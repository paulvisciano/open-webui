"""Header-only EXIF for library scan.

Reads DateTimeOriginal / GPS / Orientation via ExifRead ``details=False``.
Opens the file in binary mode only — never decode pixels, never reverse
geocode.
"""

from __future__ import annotations

import logging
from datetime import datetime
from pathlib import Path
from typing import Any

from open_webui.graph.exif_extractor import _get_gps_coords, _import_exifread

logger = logging.getLogger("open_webui.graph.extractors.fast_exif")


def _tag_text(tag: Any) -> str | None:
    if tag is None:
        return None
    try:
        vals = tag.values
        if isinstance(vals, (list, tuple)):
            if not vals:
                return None
            return str(vals[0]).strip() or None
        text = str(vals).strip()
        return text or None
    except Exception:
        text = str(tag).strip()
        return text or None


def _exif_datetime_to_epoch(raw: str) -> float | None:
    text = raw.strip().strip("\x00")
    if not text or text.startswith("0000"):
        return None
    candidate = text[:19]
    for fmt in ("%Y:%m:%d %H:%M:%S", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(candidate, fmt).timestamp()
        except ValueError:
            continue
    return None


def _orientation(tag: Any) -> int | None:
    if tag is None:
        return None
    try:
        vals = tag.values
        if isinstance(vals, (list, tuple)) and vals:
            return int(vals[0])
        return int(vals)
    except (TypeError, ValueError):
        return None


def extract_fast_exif(path: str | Path) -> dict[str, Any]:
    result: dict[str, Any] = {
        "taken_at": None,
        "latitude": None,
        "longitude": None,
        "orientation": None,
    }
    exifread = _import_exifread()
    if exifread is None:
        return result

    image_path = Path(path)
    try:
        with image_path.open("rb") as fh:
            tags = exifread.process_file(fh, details=False)
    except Exception as exc:
        logger.debug("[fast_exif] Could not read EXIF from %s: %s", image_path.name, exc)
        return result

    if not tags:
        return result

    date_str = (
        _tag_text(tags.get("EXIF DateTimeOriginal"))
        or _tag_text(tags.get("EXIF DateTimeDigitized"))
        or _tag_text(tags.get("Image DateTime"))
    )
    if date_str:
        result["taken_at"] = _exif_datetime_to_epoch(date_str)

    lat, lon = _get_gps_coords(tags)
    result["latitude"] = lat
    result["longitude"] = lon
    result["orientation"] = _orientation(tags.get("Image Orientation"))
    return result
