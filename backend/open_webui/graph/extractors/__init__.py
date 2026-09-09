"""Fast asset metadata for library scan.

Order: Takeout sidecar → header-only EXIF (photos) → filename + mtime.
Never decode pixels, never reverse-geocode, never mutate sidecars.
``taken_at`` is unix epoch float (time-as-depth / Z).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from open_webui.graph.extractors.fast_exif import extract_fast_exif
from open_webui.graph.extractors.takeout import find_sidecar, parse_takeout_sidecar

_PHOTO = frozenset({".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".gif"})
_PDF = frozenset({".pdf"})
_DOCUMENT = frozenset({".docx", ".txt", ".md", ".html"})
_VIDEO = frozenset({".mp4", ".mov", ".m4v", ".webm"})
_AUDIO = frozenset({".mp3", ".wav", ".m4a", ".aac"})


def classify_kind(path: str | Path) -> str | None:
    suffix = Path(path).suffix.lower()
    if suffix in _PHOTO:
        return "photo"
    if suffix in _PDF:
        return "pdf"
    if suffix in _DOCUMENT:
        return "document"
    if suffix in _VIDEO:
        return "video"
    if suffix in _AUDIO:
        return "audio"
    return None


def should_skip(path: str | Path) -> bool:
    p = Path(path)
    name = p.name
    if name.startswith("."):
        return True
    if name.lower().endswith(".json"):
        return True
    if "__MACOSX" in p.parts:
        return True
    try:
        if not p.is_file() or p.stat().st_size == 0:
            return True
    except OSError:
        return True
    return classify_kind(p) is None


def _mtime_epoch(path: Path) -> float | None:
    try:
        return float(path.stat().st_mtime)
    except OSError:
        return None


def extract_asset_meta(path: str | Path) -> dict[str, Any] | None:
    """Return ``{title, taken_at, search_text, kind}`` or None if not an asset.

    Sidecar present → EXIF is not opened. ``taken_at`` is unix epoch float.
    """
    p = Path(path)
    if should_skip(p):
        return None
    kind = classify_kind(p)
    if kind is None:
        return None

    title = p.stem
    taken_at: float | None = None
    search_text = title
    sidecar = find_sidecar(p)

    if sidecar is not None:
        parsed = parse_takeout_sidecar(sidecar)
        if parsed:
            if parsed.get("title"):
                title = parsed["title"]
            if parsed.get("taken_at") is not None:
                taken_at = parsed["taken_at"]
            search_text = parsed.get("search_text") or title
            if p.name and p.name not in search_text:
                search_text = f"{p.name} {search_text}".strip()
    elif kind == "photo":
        exif = extract_fast_exif(p)
        if exif.get("taken_at") is not None:
            taken_at = exif["taken_at"]
        parts = [title]
        if p.name != title:
            parts.append(p.name)
        lat, lon = exif.get("latitude"), exif.get("longitude")
        if lat is not None and lon is not None:
            parts.append(f"{lat} {lon}")
        search_text = " ".join(parts)
    else:
        parts = [title]
        if p.name != title:
            parts.append(p.name)
        search_text = " ".join(parts)

    if taken_at is None:
        taken_at = _mtime_epoch(p)

    return {
        "title": title,
        "taken_at": taken_at,
        "search_text": search_text,
        "kind": kind,
    }


__all__ = [
    "classify_kind",
    "extract_asset_meta",
    "should_skip",
]
