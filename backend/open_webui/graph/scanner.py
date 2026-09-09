"""Cancellable in-place library scan.

Walks ``graph_source.last_abs_path`` with ``os.walk``, extracts fast metadata
for new/changed files, and batch-upserts ``graph_asset`` rows (100 at a time).
Identity is ``(source_id, rel_path)``. Whole-file hashing is skipped in v1.
Offline sources are never pruned. Walk/extract run in ``asyncio.to_thread`` so
the FastAPI event loop is not blocked.
"""

from __future__ import annotations

import asyncio
import logging
import mimetypes
import os
import stat
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from open_webui.graph._db import (
    delete_assets_by_rel_paths,
    get_source,
    list_assets_by_source,
    upsert_assets_batch,
)
from open_webui.graph.extractors import extract_asset_meta, should_skip
from open_webui.graph.sources import is_online

logger = logging.getLogger(__name__)

BATCH_SIZE = 100


def _is_cancelled(cancel_event: Any) -> bool:
    if cancel_event is None:
        return False
    is_set = getattr(cancel_event, "is_set", None)
    if not callable(is_set):
        return False
    try:
        return bool(is_set())
    except Exception:
        return False


def _is_under_root(path: str, root_real: str) -> bool:
    try:
        real = os.path.realpath(path)
    except OSError:
        return False
    if real == root_real:
        return True
    prefix = root_real if root_real.endswith(os.sep) else root_real + os.sep
    return real.startswith(prefix)


def _mtime_ns(st: os.stat_result) -> int:
    ns = getattr(st, "st_mtime_ns", None)
    if ns is not None:
        return int(ns)
    return int(st.st_mtime * 1_000_000_000)


class _WalkCursor:
    def __init__(
        self,
        source_id: str,
        root: str,
        existing: dict[str, tuple[int | None, int | None, str | None]],
        cancel_event: Any,
    ) -> None:
        self.source_id = source_id
        self.root = root
        self.root_real = os.path.realpath(root)
        self.existing = existing
        self.cancel_event = cancel_event
        self.seen = 0
        self.kind_counts: dict[str, int] = {}
        self.seen_rel_paths: set[str] = set()
        self.done = False
        self.cancelled = False
        self._walk = os.walk(
            root, topdown=True, onerror=None, followlinks=False
        )
        self._pending: list[str] = []
        self._dirpath = ""

    def next_batch(self, limit: int = BATCH_SIZE) -> list[dict]:
        if self.cancelled or _is_cancelled(self.cancel_event):
            self.cancelled = True
            self.done = True
            return []

        batch: list[dict] = []
        while len(batch) < limit:
            if _is_cancelled(self.cancel_event):
                self.cancelled = True
                return []
            item = self._next_candidate()
            if item is None:
                self.done = True
                break
            abs_path, rel_path, size_bytes, mtime_ns = item
            self.seen += 1
            self.seen_rel_paths.add(rel_path)

            prev = self.existing.get(rel_path)
            if (
                prev is not None
                and prev[0] == size_bytes
                and prev[1] == mtime_ns
            ):
                kind = prev[2]
                if kind:
                    self.kind_counts[kind] = self.kind_counts.get(kind, 0) + 1
                continue

            meta = extract_asset_meta(abs_path)
            if meta is None:
                continue

            kind = meta["kind"]
            self.kind_counts[kind] = self.kind_counts.get(kind, 0) + 1
            batch.append(
                {
                    "source_id": self.source_id,
                    "rel_path": rel_path,
                    "content_hash": None,
                    "kind": kind,
                    "taken_at": meta.get("taken_at"),
                    "title": meta.get("title"),
                    "search_text": meta.get("search_text"),
                    "size_bytes": size_bytes,
                    "mtime_ns": mtime_ns,
                    "mime": mimetypes.guess_type(abs_path)[0],
                }
            )
        return batch

    def _next_candidate(self) -> tuple[str, str, int, int] | None:
        while True:
            if _is_cancelled(self.cancel_event):
                self.cancelled = True
                return None
            if not self._pending:
                try:
                    dirpath, dirnames, filenames = next(self._walk)
                except StopIteration:
                    return None
                if not _is_under_root(dirpath, self.root_real):
                    dirnames[:] = []
                    continue
                dirnames[:] = [
                    name
                    for name in dirnames
                    if not name.startswith(".")
                    and name != "__MACOSX"
                    and _is_under_root(
                        os.path.join(dirpath, name), self.root_real
                    )
                ]
                self._dirpath = dirpath
                self._pending = list(filenames)
                continue

            name = self._pending.pop(0)
            abs_path = os.path.join(self._dirpath, name)
            if not _is_under_root(abs_path, self.root_real):
                continue
            if should_skip(abs_path):
                continue
            try:
                st = os.stat(abs_path, follow_symlinks=True)
            except OSError:
                continue
            if not stat.S_ISREG(st.st_mode) or st.st_size == 0:
                continue
            rel_path = Path(os.path.relpath(abs_path, self.root)).as_posix()
            return abs_path, rel_path, int(st.st_size), _mtime_ns(st)


def _progress(cursor: _WalkCursor, upserted: int) -> dict[str, Any]:
    return {
        "seen": cursor.seen,
        "upserted": upserted,
        "kind_counts": dict(cursor.kind_counts),
    }


async def scan_source(
    source_id: str,
    cancel_event: Any = None,
) -> AsyncIterator[dict[str, Any]]:
    """Walk a source and stream batch-upsert progress.

    Yields ``{seen, upserted, kind_counts}`` after each committed batch.
    ``cancel_event.is_set()`` stops further upserts. Disappeared ``rel_path``
    rows are deleted only when the source is online and the walk completed.
    """
    source = await get_source(source_id)
    if source is None:
        logger.warning("scan_source: unknown source_id=%s", source_id)
        return

    root = source.get("last_abs_path")
    if not root or not os.path.isdir(root):
        logger.info(
            "scan_source: skip walk source_id=%s path=%s", source_id, root
        )
        return

    existing_rows = await list_assets_by_source(source_id)
    existing = {
        row["rel_path"]: (
            row.get("size_bytes"),
            row.get("mtime_ns"),
            row.get("kind"),
        )
        for row in existing_rows
    }

    cursor = _WalkCursor(source_id, root, existing, cancel_event)
    upserted = 0

    while not cursor.done and not cursor.cancelled:
        if _is_cancelled(cancel_event):
            cursor.cancelled = True
            break
        batch = await asyncio.to_thread(cursor.next_batch, BATCH_SIZE)
        if cursor.cancelled or _is_cancelled(cancel_event):
            cursor.cancelled = True
            break
        if batch:
            await upsert_assets_batch(batch)
            upserted += len(batch)
            pdf_rels = [
                row["rel_path"] for row in batch if row.get("kind") == "pdf"
            ]
            if pdf_rels:
                from open_webui.graph.pdf_text import schedule_pdf_text_extract

                schedule_pdf_text_extract(source_id, pdf_rels)
            yield _progress(cursor, upserted)
        elif cursor.done or cursor.cancelled:
            break

    if cursor.cancelled:
        logger.info(
            "scan_source: cancelled source_id=%s seen=%s upserted=%s",
            source_id,
            cursor.seen,
            upserted,
        )
        return

    if is_online(source_id):
        gone = [
            rel_path
            for rel_path in existing
            if rel_path not in cursor.seen_rel_paths
        ]
        if gone:
            deleted = await delete_assets_by_rel_paths(source_id, gone)
            logger.info(
                "scan_source: pruned %s disappeared rows source_id=%s",
                deleted,
                source_id,
            )

    if upserted == 0:
        yield _progress(cursor, upserted)


__all__ = ["BATCH_SIZE", "scan_source"]
