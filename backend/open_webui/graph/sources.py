"""Volume fingerprinting and per-source presence monitoring.

Identity is the volume, never the path and never the basename of
``/Volumes/Foo``. Presence is in-memory: unplug/offline fades a source in
the UI; it does **not** DELETE ``graph_asset`` rows (those live in the DB,
wired in a later task).

The FastAPI lifespan starts :data:`presence_monitor` as a poll loop. Startup
must not walk the library.
"""

from __future__ import annotations

import asyncio
import logging
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)

POLL_INTERVAL_SECONDS = 3.0
MISSES_TO_OFFLINE = 2
_VOLUMES_DIR = Path("/Volumes")


def _existing_ancestor(path: Path) -> Path:
    current = Path(path)
    while True:
        try:
            if current.exists():
                return current
        except OSError:
            pass
        parent = current.parent
        if parent == current:
            return current
        current = parent


def _walk_mount(path: Path) -> Path:
    try:
        resolved = path.resolve()
    except OSError:
        resolved = path
    try:
        dev = os.stat(resolved).st_dev
    except OSError:
        return resolved
    current = resolved
    while True:
        parent = current.parent
        if parent == current:
            return current
        try:
            if os.stat(parent).st_dev != dev:
                return current
        except OSError:
            return current
        current = parent


def _volume_mount(path: Path) -> Path:
    target = _existing_ancestor(path)
    try:
        completed = subprocess.run(
            ["df", "-P", os.fspath(target)],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        if completed.returncode == 0:
            lines = completed.stdout.splitlines()
            if len(lines) >= 2:
                fields = lines[-1].split(None, 5)
                if len(fields) >= 6:
                    return Path(fields[5])
    except (OSError, subprocess.TimeoutExpired):
        pass
    return _walk_mount(target)


def _macos_volume_uuid(mount: Path) -> str | None:
    if sys.platform != "darwin":
        return None
    try:
        completed = subprocess.run(
            ["diskutil", "info", os.fspath(mount)],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if completed.returncode != 0:
        return None
    for line in completed.stdout.splitlines():
        stripped = line.strip()
        if stripped.startswith("Volume UUID:"):
            uuid = stripped.split(":", 1)[1].strip()
            if uuid:
                return uuid
    return None


def _device_root_fingerprint(mount: Path) -> str:
    st = os.stat(os.fspath(mount))
    return f"dev:{st.st_dev}:{st.st_ino}"


def fingerprint_for(path: Path) -> str:
    """Stable volume identity for ``path``.

    Prefers the macOS ``Volume UUID``. Falls back to device id + root inode.
    Never returns a path or the basename of ``/Volumes/Foo``.
    """
    path = Path(path)
    mount = _volume_mount(path)
    uuid = _macos_volume_uuid(mount)
    if uuid:
        return f"vol:{uuid}"
    return _device_root_fingerprint(mount)


def _path_present(abs_path: str) -> bool:
    root = Path(abs_path)
    try:
        if not root.exists():
            return False
        os.stat(root)
        return True
    except OSError:
        return False


@dataclass
class _TrackedSource:
    last_abs_path: str
    fingerprint: str
    mount_point: str
    online: bool = True
    consecutive_misses: int = 0
    forced: bool | None = None


class PresenceMonitor:
    """Poll last_abs_path every 3s. Two consecutive misses → offline.

    Remount: if the folder is gone but a ``/Volumes/*`` entry has the same
    fingerprint, update ``last_abs_path`` only (same source_id).
    """

    def __init__(self, poll_interval: float = POLL_INTERVAL_SECONDS) -> None:
        self._interval = poll_interval
        self._sources: dict[str, _TrackedSource] = {}
        self._task: asyncio.Task[None] | None = None
        self._started = False

    async def start(self) -> None:
        """Start the poll loop. Does not walk any library."""
        if self._started:
            return
        self._started = True
        self._task = asyncio.create_task(self._poll_loop(), name="graph-presence-monitor")
        logger.info("PresenceMonitor started (poll=%.1fs, no library walk)", self._interval)

    async def stop(self) -> None:
        if not self._started:
            return
        self._started = False
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        logger.info("PresenceMonitor stopped")

    def set_abs_path(self, source_id: str, abs_path: str | Path) -> None:
        path = Path(abs_path)
        last_abs = os.fspath(path)
        present = _path_present(last_abs)
        existing = self._sources.get(source_id)
        if present:
            fingerprint = fingerprint_for(path)
            mount_point = os.fspath(_volume_mount(path))
        elif existing is not None:
            fingerprint = existing.fingerprint
            mount_point = existing.mount_point
        else:
            fingerprint = fingerprint_for(path)
            mount_point = os.fspath(_volume_mount(path))
        self._sources[source_id] = _TrackedSource(
            last_abs_path=last_abs,
            fingerprint=fingerprint,
            mount_point=mount_point,
            online=present,
            consecutive_misses=0 if present else 1,
            forced=None,
        )

    def set_online(self, source_id: str, online: bool) -> None:
        """QA/dev hook: force presence. ``online=False`` sticks across polls."""
        state = self._sources.get(source_id)
        if state is None:
            self._sources[source_id] = _TrackedSource(
                last_abs_path="",
                fingerprint="",
                mount_point="",
                online=online,
                consecutive_misses=0 if online else MISSES_TO_OFFLINE,
                forced=None if online else False,
            )
            return
        if online:
            state.forced = None
            state.online = True
            state.consecutive_misses = 0
        else:
            state.forced = False
            state.online = False
            state.consecutive_misses = MISSES_TO_OFFLINE

    def is_online(self, source_id: str) -> bool:
        state = self._sources.get(source_id)
        if state is None:
            return False
        if state.forced is not None:
            return bool(state.forced)
        return bool(state.online)

    def snapshot(self) -> dict[str, bool]:
        return {source_id: state.online for source_id, state in self._sources.items()}

    def last_abs_path(self, source_id: str) -> str | None:
        state = self._sources.get(source_id)
        return None if state is None else state.last_abs_path

    async def _poll_loop(self) -> None:
        try:
            while True:
                try:
                    self._tick()
                except Exception:
                    logger.exception("PresenceMonitor poll failed")
                await asyncio.sleep(self._interval)
        except asyncio.CancelledError:
            logger.info("PresenceMonitor poll loop cancelled")
            raise

    def _tick(self) -> None:
        for state in self._sources.values():
            if state.forced is not None:
                continue
            present = _path_present(state.last_abs_path)
            if not present:
                relocated = self._resolve_remount(state)
                if relocated is not None:
                    state.last_abs_path = relocated
                    state.mount_point = os.fspath(_volume_mount(Path(relocated)))
                    present = True
            if present:
                state.consecutive_misses = 0
                state.online = True
            else:
                state.consecutive_misses += 1
                if state.consecutive_misses >= MISSES_TO_OFFLINE:
                    state.online = False

    def _resolve_remount(self, state: _TrackedSource) -> str | None:
        if not state.fingerprint or not _VOLUMES_DIR.is_dir():
            return None
        try:
            candidates = list(_VOLUMES_DIR.iterdir())
        except OSError:
            return None
        old_mount = Path(state.mount_point)
        for candidate in candidates:
            try:
                if not candidate.exists():
                    continue
                if fingerprint_for(candidate) != state.fingerprint:
                    continue
            except OSError:
                continue
            try:
                same_mount = candidate.resolve() == old_mount.resolve()
            except OSError:
                same_mount = os.fspath(candidate) == os.fspath(old_mount)
            if same_mount:
                continue
            new_path = self._rebase_onto_mount(state, candidate)
            if new_path is not None and _path_present(new_path):
                logger.info(
                    "PresenceMonitor remount: %s -> %s (fingerprint match)",
                    state.last_abs_path,
                    new_path,
                )
                return new_path
        return None

    @staticmethod
    def _rebase_onto_mount(state: _TrackedSource, new_mount: Path) -> str | None:
        old_path = Path(state.last_abs_path)
        old_mount = Path(state.mount_point)
        try:
            rel = old_path.relative_to(old_mount)
        except ValueError:
            if old_path == old_mount:
                return os.fspath(new_mount)
            return None
        return os.fspath(new_mount / rel)


presence_monitor = PresenceMonitor()


def is_online(source_id: str) -> bool:
    return presence_monitor.is_online(source_id)


def set_abs_path(source_id: str, abs_path: str | Path) -> None:
    presence_monitor.set_abs_path(source_id, abs_path)


def set_online(source_id: str, online: bool) -> None:
    presence_monitor.set_online(source_id, online)


def snapshot() -> dict[str, bool]:
    return presence_monitor.snapshot()
