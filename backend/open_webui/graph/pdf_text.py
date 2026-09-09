"""Lazy PDF text for graph FTS.

Runs after scan in a background task (never on the UI / request thread).
Cards appear from filename/sidecar ``search_text``; extracted page text is
appended later. Failure is silent — filename still matches.
"""

from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path

logger = logging.getLogger(__name__)

MAX_TEXT_BYTES = 32 * 1024
MAX_PAGES = 4

_pdf_tasks: set[asyncio.Task] = set()


def extract_pdf_text(path: str | Path) -> str:
    p = Path(path)
    text = _extract_pypdf(p)
    if not text:
        text = _extract_pdfminer(p)
    if not text:
        return ""
    encoded = text.encode("utf-8", errors="ignore")[:MAX_TEXT_BYTES]
    return encoded.decode("utf-8", errors="ignore").strip()


def _extract_pypdf(path: Path) -> str:
    try:
        from pypdf import PdfReader
    except Exception:
        return ""
    try:
        reader = PdfReader(os.fspath(path))
        parts: list[str] = []
        total = 0
        for page in reader.pages[:MAX_PAGES]:
            chunk = page.extract_text() or ""
            if not chunk:
                continue
            parts.append(chunk)
            total += len(chunk)
            if total >= MAX_TEXT_BYTES:
                break
        return "\n".join(parts)
    except Exception as exc:
        logger.debug("[pdf_text] pypdf failed %s: %s", path.name, exc)
        return ""


def _extract_pdfminer(path: Path) -> str:
    try:
        from pdfminer.high_level import extract_text
    except Exception:
        return ""
    try:
        text = extract_text(os.fspath(path), maxpages=MAX_PAGES) or ""
        return text
    except Exception as exc:
        logger.debug("[pdf_text] pdfminer failed %s: %s", path.name, exc)
        return ""


def schedule_pdf_text_extract(
    source_id: str,
    rel_paths: list[str] | None = None,
) -> asyncio.Task | None:
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return None
    task = loop.create_task(
        _run_pdf_text_extract(source_id, rel_paths),
        name=f"graph-pdf-text-{source_id}",
    )
    _pdf_tasks.add(task)
    task.add_done_callback(_pdf_tasks.discard)
    return task


async def _run_pdf_text_extract(
    source_id: str,
    rel_paths: list[str] | None,
) -> None:
    try:
        await extract_pdf_text_for_source(source_id, rel_paths)
    except Exception:
        logger.exception("pdf text extract failed source_id=%s", source_id)


async def extract_pdf_text_for_source(
    source_id: str,
    rel_paths: list[str] | None = None,
) -> int:
    from open_webui.graph._db import (
        get_source,
        list_assets_by_source,
        update_asset_search_text,
    )

    source = await get_source(source_id)
    if source is None:
        return 0
    root = source.get("last_abs_path") or ""
    if not root or not os.path.isdir(root):
        return 0

    wanted = set(rel_paths) if rel_paths else None
    updated = 0
    for asset in await list_assets_by_source(source_id):
        if str(asset.get("kind") or "").lower() != "pdf":
            continue
        rel = asset.get("rel_path") or ""
        if wanted is not None and rel not in wanted:
            continue
        abs_path = os.path.join(root, rel)
        try:
            text = await asyncio.to_thread(extract_pdf_text, abs_path)
        except Exception:
            logger.debug("[pdf_text] skip %s", rel, exc_info=True)
            continue
        if not text:
            continue
        current = (asset.get("search_text") or "").strip()
        if text in current:
            continue
        new_text = f"{current} {text}".strip() if current else text
        try:
            await update_asset_search_text(str(asset["id"]), new_text)
            updated += 1
        except Exception:
            logger.debug("[pdf_text] update failed %s", rel, exc_info=True)
    return updated


__all__ = [
    "MAX_PAGES",
    "MAX_TEXT_BYTES",
    "extract_pdf_text",
    "extract_pdf_text_for_source",
    "schedule_pdf_text_extract",
]
