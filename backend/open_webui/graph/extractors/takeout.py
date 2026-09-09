"""Google Takeout sidecar parser for library scan.

Looks beside an asset for ``{filename}.json`` (Takeout default, e.g.
``IMG_1234.jpg.json``) or ``{stem}.json``. The JSON itself is never an asset.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

logger = logging.getLogger("open_webui.graph.extractors.takeout")


def find_sidecar(path: Path) -> Path | None:
    filename_sidecar = path.with_name(path.name + ".json")
    if filename_sidecar.is_file():
        return filename_sidecar
    stem_sidecar = path.with_suffix(".json")
    if stem_sidecar.is_file() and stem_sidecar != path:
        return stem_sidecar
    return None


def _to_epoch(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        epoch = float(value)
    except (TypeError, ValueError):
        return None
    if epoch <= 0:
        return None
    return epoch


def _geo_pair(geo: Any) -> tuple[float | None, float | None]:
    if not isinstance(geo, dict):
        return None, None
    try:
        lat = float(geo.get("latitude") or 0)
        lon = float(geo.get("longitude") or 0)
    except (TypeError, ValueError):
        return None, None
    if lat == 0.0 and lon == 0.0:
        return None, None
    return lat, lon


def parse_takeout_sidecar(sidecar: Path) -> dict[str, Any] | None:
    try:
        with sidecar.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception as exc:
        logger.debug("[takeout] Could not parse sidecar %s: %s", sidecar.name, exc)
        return None

    if not isinstance(data, dict):
        return None

    title = data.get("title")
    if isinstance(title, str):
        title = title.strip() or None
    else:
        title = None

    taken_at = None
    photo_taken = data.get("photoTakenTime")
    if isinstance(photo_taken, dict):
        taken_at = _to_epoch(photo_taken.get("timestamp"))

    lat, lon = _geo_pair(data.get("geoData"))

    parts: list[str] = []
    if title:
        parts.append(title)
    description = data.get("description")
    if isinstance(description, str) and description.strip():
        parts.append(description.strip())
    if lat is not None and lon is not None:
        parts.append(f"{lat} {lon}")

    return {
        "title": title,
        "taken_at": taken_at,
        "search_text": " ".join(parts),
        "latitude": lat,
        "longitude": lon,
    }
