"""VLM image processing and entity extraction for the graph pipeline.

Ported from Knowledge Graph's ``api/services/processor.py``.  Key adaptations
for Open WebUI:

* VLM calls go through the ``openai`` Python library pointed at OWUI's
  OpenAI-compatible model endpoint (``OPENAI_API_BASE_URL`` /
  ``OPENAI_API_KEY``) instead of a raw ``httpx.post`` to a llama-server.
* LightRAG entity/relation/document operations use the in-process
  :mod:`open_webui.services.lightrag_service` singleton (``LightRAG.ainsert``,
  ``LightRAG.ainsert_custom_kg``, ``LightRAG.aget_graph_labels``,
  ``LightRAG.aget_knowledge_graph``) instead of the LightRAG HTTP API.
* Face detection / recognition is removed entirely.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import re
import time
from dataclasses import dataclass, field
from datetime import datetime
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, AsyncGenerator, Callable

import zoneinfo

from open_webui.graph.exif_extractor import extract_exif_metadata

logger = logging.getLogger("open_webui.graph.processor")

_MAX_ENTITY_ATTEMPTS = 5
_MAX_RELATION_ATTEMPTS = 5
_VLM_MAX_RETRIES = 3
_VLM_RETRY_BACKOFF_BASE = 5

_PIPELINE_BUSY_TOTAL_TIMEOUT = int(os.environ.get("PIPELINE_BUSY_TIMEOUT", "300"))
_PIPELINE_BUSY_MAX_SLEEP = 30.0

_vlm_semaphore: asyncio.Semaphore | None = None
_poll_semaphore = asyncio.Semaphore(4)


def _get_vlm_semaphore() -> asyncio.Semaphore:
    global _vlm_semaphore
    if _vlm_semaphore is None:
        _vlm_semaphore = asyncio.Semaphore(
            max(1, int(os.environ.get("VLM_MAX_CONCURRENT", "1")))
        )
    return _vlm_semaphore


def _vlm_timeout() -> int:
    return int(os.environ.get("VLM_TIMEOUT", "300"))


def _vlm_image_max_dim() -> int:
    return int(os.environ.get("VLM_IMAGE_MAX_DIM", "768"))


def _vlm_model() -> str:
    return os.environ.get("VLM_LLM_MODEL", os.environ.get("LIGHTRAG_LLM_MODEL", "gpt-4o-mini"))


# ---------------------------------------------------------------------------
# LightRAG helpers
# ---------------------------------------------------------------------------


async def _get_rag():
    from open_webui.services.lightrag_service import get_lightrag

    return await get_lightrag()


@dataclass
class ProcessingEvent:
    event: str
    data: dict[str, Any]
    timestamp: float = field(default_factory=time.time)


@dataclass
class ProcessingResult:
    exif: dict[str, Any] | None
    captions: list[str]
    content_list: list[dict[str, Any]]
    events: list[ProcessingEvent]


# ---------------------------------------------------------------------------
# Metadata / caption builders
# ---------------------------------------------------------------------------


def _build_metadata_text(
    exif_data: dict[str, Any] | None,
    image_path: str,
) -> str:
    has_location = has_date = has_camera = False
    location_clause = date_clause = camera_clause = ""

    if exif_data:
        location = exif_data.get("location")
        if location:
            loc_str = location if isinstance(location, str) else ", ".join(
                str(v) for v in location.values() if v
            )
            if loc_str:
                location_clause = f"in {loc_str}"
                has_location = True
        date = exif_data.get("date_taken_friendly") or exif_data.get("date_taken")
        if date:
            date_clause = f"on {date}"
            has_date = True
        camera = exif_data.get("camera") or exif_data.get("camera_make") or exif_data.get("camera_model")
        if camera:
            camera_clause = f"with a {camera}"
            has_camera = True

    if not (has_location or has_date or has_camera):
        return f"Image: {Path(image_path).name}"

    fragments: list[str] = []
    if has_location:
        fragments.append(location_clause)
    if has_date:
        fragments.append(date_clause)
    if has_camera:
        fragments.append(camera_clause)
    return " ".join(fragments)


def _build_captions(
    exif_data: dict[str, Any] | None,
    image_path: str,
) -> list[str]:
    captions: list[str] = []

    if exif_data:
        metadata_text = exif_data.get("metadata_text")
        if metadata_text:
            captions.append(metadata_text)
        else:
            parts: list[str] = []
            date = exif_data.get("date_taken_friendly") or exif_data.get("date_taken")
            if date:
                parts.append(f"Photo taken on {date}")
            camera = exif_data.get("camera") or exif_data.get("camera_make") or exif_data.get("camera_model")
            if camera:
                parts.append(f"with {camera}")
            location = exif_data.get("location")
            if location:
                loc_str = (
                    location if isinstance(location, str)
                    else ", ".join(str(v) for v in location.values() if v)
                    if isinstance(location, dict)
                    else str(location)
                )
                if loc_str:
                    parts.append(f"at {loc_str}")
            settings_parts: list[str] = []
            for key in ("f_number", "exposure_time", "iso", "focal_length"):
                val = exif_data.get(key)
                if val:
                    settings_parts.append(str(val))
            if settings_parts:
                parts.append(", ".join(settings_parts))
            if parts:
                caption = " ".join(parts).replace("  ", " ").strip()
                if not caption.endswith("."):
                    caption += "."
                captions.append(caption)

    if not captions:
        captions.append(f"Image: {Path(image_path).name}")

    return captions


def _build_content_list(image_path: str, captions: list[str]) -> list[dict[str, Any]]:
    return [{
        "type": "image",
        "image_caption": captions,
        "image_path": str(Path(image_path).resolve()),
    }]


def _process_exif(image_path: str) -> dict[str, Any] | None:
    try:
        result = extract_exif_metadata(image_path)
        logger.info("EXIF extraction succeeded for %s", image_path)
        return result
    except Exception:
        logger.exception("EXIF extraction failed for %s", image_path)
        return None


# ---------------------------------------------------------------------------
# VLM image preparation
# ---------------------------------------------------------------------------


def prepare_vlm_image(image_path: str) -> str:
    """Pre-resize an image for VLM processing and return a temp file path.

    If ``VLM_IMAGE_MAX_DIM`` is 0 or the image is already small enough, the
    original path is returned unchanged.
    """
    import tempfile

    max_dim = _vlm_image_max_dim()
    if max_dim <= 0:
        return image_path

    from PIL import Image

    img = Image.open(image_path)
    w, h = img.size
    if max(w, h) <= max_dim:
        return image_path

    img.thumbnail((max_dim, max_dim), Image.Resampling.LANCZOS)
    tmp = tempfile.NamedTemporaryFile(suffix=".jpg", delete=False)
    img.save(tmp, format="JPEG", quality=85)
    tmp.close()
    logger.info(
        "Pre-resized %s (max_dim=%d)",
        Path(image_path).name, max_dim,
    )
    return tmp.name


def cleanup_vlm_image(path: str) -> None:
    import tempfile

    try:
        if path and Path(path).exists():
            tmp_dir = Path(tempfile.gettempdir()).resolve()
            if Path(path).resolve().parent == tmp_dir:
                os.unlink(path)
    except OSError:
        pass


# ---------------------------------------------------------------------------
# VLM description
# ---------------------------------------------------------------------------


def _build_vlm_client():
    """Build an OpenAI client pointed at OWUI's model endpoint."""
    from openai import AsyncOpenAI

    from open_webui import config as owui_config

    base_url = os.environ.get("VLM_LLM_BINDING_HOST") or owui_config.OPENAI_API_BASE_URL
    api_key = os.environ.get("VLM_LLM_BINDING_API_KEY") or owui_config.OPENAI_API_KEY or "unused"

    if not base_url:
        base_url = "https://api.openai.com/v1"

    return AsyncOpenAI(base_url=base_url, api_key=api_key, timeout=_vlm_timeout())


async def describe_image_with_vlm(
    image_path: str,
    context: str | None = None,
    on_queued: Callable[[], Any] | None = None,
) -> str:
    """Send an image to the VLM and return a text description.

    Uses the OpenAI-compatible chat completions endpoint with multimodal input
    to generate a detailed description of the image content.
    """
    model = _vlm_model()

    with open(image_path, "rb") as f:
        image_b64 = base64.b64encode(f.read()).decode("ascii")

    ext = Path(image_path).suffix.lower().lstrip(".")
    mime_map = {
        "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
        "gif": "image/gif", "webp": "image/webp", "bmp": "image/bmp",
    }
    mime_type = mime_map.get(ext, "image/jpeg")

    prompt = (
        "Analyze this image in detail for a knowledge graph. "
        "Identify every visible element using specific proper nouns where possible "
        "(e.g., brand names, model numbers, landmark names, specific locations). "
        "Transcribe any visible text verbatim — exact spelling, numbers, and labels. "
        "Note colors, materials, and quantities. "
        f"{'Context: ' + context if context else ''}"
        "\n\n"
        "Format your response with EXACTLY these sections in this order, each as a bold header "
        "on its own line followed by bullet points. Do NOT output the section headers as "
        "standalone entities — they are structure only. If a section has no content, write "
        "\"None\" on one bullet:\n"
        "**People**: One bullet per distinct person. For each: hair (color, length, style), "
        "approximate age, facial hair, glasses, clothing (color, material, brand if visible), "
        "expression, and position in frame (foreground/background, left/right).\n"
        "**Objects**: One bullet per distinct object. For each: name (use the specific proper "
        "noun — brand, model, material — not the generic category), color, quantity, and "
        "position in frame.\n"
        "**Text**: One bullet per visible text string, transcribed verbatim with its location.\n"
        "**Colors & Materials**: One bullet per dominant color/material in the scene.\n"
        "**Scene Type**: One bullet stating indoor/outdoor, the setting, and the activity.\n"
        "**Spatial Relationships**: One bullet per key spatial relationship "
        "(foreground/background, left/right, above/below) between named elements.\n"
        "Be exhaustive — every visible element should appear in exactly one section. "
        "Prefer specific proper nouns over generic descriptions."
    )

    client = _build_vlm_client()

    last_exc: Exception | None = None
    for attempt in range(1, _VLM_MAX_RETRIES + 1):
        try:
            if attempt == 1 and on_queued is not None:
                on_queued()
            async with _get_vlm_semaphore():
                resp = await client.chat.completions.create(
                    model=model,
                    messages=[
                        {
                            "role": "user",
                            "content": [
                                {"type": "text", "text": prompt},
                                {"type": "image_url", "image_url": {"url": f"data:{mime_type};base64,{image_b64}"}},
                            ],
                        }
                    ],
                    max_tokens=2048,
                    temperature=0.1,
                )
            description = resp.choices[0].message.content or ""
            logger.info(
                "VLM description generated (%d chars) for %s (attempt %d)",
                len(description), image_path, attempt,
            )
            return description
        except Exception as exc:
            last_exc = exc
            if attempt < _VLM_MAX_RETRIES:
                delay = _VLM_RETRY_BACKOFF_BASE * (2 ** (attempt - 1))
                logger.warning(
                    "VLM error for %s (attempt %d/%d): %s, retrying in %.0fs",
                    image_path, attempt, _VLM_MAX_RETRIES, type(exc).__name__, delay,
                )
                await asyncio.sleep(delay)
            else:
                logger.error(
                    "VLM failed after %d attempts for %s: %s",
                    _VLM_MAX_RETRIES, image_path, exc,
                )

    raise last_exc or RuntimeError("VLM description failed")


# ---------------------------------------------------------------------------
# LightRAG insertion
# ---------------------------------------------------------------------------


async def insert_metadata_into_lightrag(
    metadata_text: str,
    file_source: str,
) -> dict[str, Any]:
    """Insert text content into LightRAG as a document.

    The ``file_source`` is used as the document identifier via ``file_paths``.
    """
    try:
        rag = await _get_rag()
        await rag.ainsert(metadata_text, file_paths=[file_source])
        logger.info("Inserted document '%s' into LightRAG", file_source)
        return {"status": "success", "file_source": file_source}
    except Exception as exc:
        logger.exception("Failed to insert document '%s' into LightRAG", file_source)
        return {"status": "error", "file_source": file_source, "error": str(exc)}


async def upload_image_to_lightrag(
    image_path: str,
    filename: str | None = None,
    metadata_text: str | None = None,
    on_queued: Callable[[], Any] | None = None,
) -> dict[str, Any]:
    """Process an image through VLM and insert the description into LightRAG.

    EXIF metadata is deliberately excluded from the LightRAG document — those
    facts are created as typed entities separately via ``create_exif_relations``.
    """
    try:
        description = await describe_image_with_vlm(
            image_path, context=None, on_queued=on_queued
        )
    except Exception:
        logger.exception("VLM description failed for %s", image_path)
        file_name = filename or Path(image_path).name
        fallback_text = f"Image: {file_name}\n\n[Image description unavailable — visual analysis failed.]"
        return await insert_metadata_into_lightrag(fallback_text, file_name)

    file_name = filename or Path(image_path).name
    combined_text = f"Image: {file_name}\n\n{description}"
    return await insert_metadata_into_lightrag(combined_text, file_name)


# ---------------------------------------------------------------------------
# Entity / relation creation (via LightRAG's ainsert_custom_kg)
# ---------------------------------------------------------------------------


_LOCATION_SUFFIXES = (" (Location)", " (Date)", " (Camera)", " (Photo)")
_LOCATION_ABBREVS = {
    "st": "saint", "mt": "mount", "ft": "fort",
    "n": "north", "s": "south", "e": "east", "w": "west",
}


def _strip_entity_suffix(name: str) -> str:
    for suffix in _LOCATION_SUFFIXES:
        if name.endswith(suffix):
            return name[: -len(suffix)]
    return name


def _normalize_for_matching(name: str) -> str:
    bare = _strip_entity_suffix(name)
    normalized = re.sub(r"[.\-,]", " ", bare.lower())
    normalized = re.sub(r"\s+", " ", normalized).strip()
    words = normalized.split()
    expanded = [_LOCATION_ABBREVS.get(word, word) for word in words]
    return " ".join(expanded)


def _find_matching_entity(entity_name: str, existing_labels: set[str], threshold: float = 0.85) -> str | None:
    if entity_name in existing_labels:
        return entity_name

    bare_name = _strip_entity_suffix(entity_name)
    if bare_name in existing_labels:
        return bare_name

    if entity_name.endswith(" (Photo)"):
        return None

    if entity_name.endswith(" (Date)"):
        return None

    target_norm = _normalize_for_matching(entity_name)
    best_match: str | None = None
    best_score = 0.0

    for label in existing_labels:
        label_norm = _normalize_for_matching(label)
        score = SequenceMatcher(None, target_norm, label_norm).ratio()
        if score > best_score and score >= threshold:
            best_score = score
            best_match = label

    return best_match


async def _get_existing_labels() -> set[str]:
    try:
        rag = await _get_rag()
        labels = await rag.get_graph_labels()
        return set(labels) if labels else set()
    except Exception as exc:
        logger.warning("Failed to get existing graph labels: %s", exc)
        return set()


async def _create_entity_via_custom_kg(
    entity_name: str,
    entity_data: dict[str, Any],
) -> dict[str, Any]:
    """Create a single entity node in LightRAG via ainsert_custom_kg."""
    try:
        rag = await _get_rag()
        await rag.ainsert_custom_kg({
            "entities": [
                {
                    "entity_name": entity_name,
                    "entity_type": entity_data.get("entity_type", "UNKNOWN"),
                    "description": entity_data.get("description", ""),
                    "source_id": entity_data.get("source_id", "custom_kg"),
                    "file_path": entity_data.get("file_path", entity_data.get("source_id", "custom_kg")),
                }
            ],
            "relationships": [],
        })
        logger.info("[Entity] Created '%s'", entity_name)
        return {"status": "success", "entity_name": entity_name, "entity_type": entity_data.get("entity_type", "UNKNOWN")}
    except Exception as exc:
        logger.warning("[Entity] Failed to create '%s': %s", entity_name, exc)
        return {"status": "error", "entity_name": entity_name, "error": str(exc)}


async def _create_relation_via_custom_kg(
    source_entity: str,
    target_entity: str,
    relation_data: dict[str, Any],
) -> dict[str, Any]:
    """Create a single relation edge in LightRAG via ainsert_custom_kg."""
    try:
        rag = await _get_rag()
        await rag.ainsert_custom_kg({
            "entities": [],
            "relationships": [
                {
                    "src_id": source_entity,
                    "tgt_id": target_entity,
                    "description": relation_data.get("description", ""),
                    "keywords": relation_data.get("keywords", "related_to"),
                    "weight": relation_data.get("weight", 1.0),
                    "source_id": relation_data.get("source_id", "custom_kg"),
                    "file_path": relation_data.get("file_path", relation_data.get("source_id", "custom_kg")),
                }
            ],
        })
        logger.info("[Relation] Created '%s' -> '%s'", source_entity, target_entity)
        return {"status": "success", "source": source_entity, "target": target_entity}
    except Exception as exc:
        logger.warning("[Relation] Failed '%s' -> '%s': %s", source_entity, target_entity, exc)
        return {"status": "error", "source": source_entity, "target": target_entity, "error": str(exc)}


async def create_exif_relations(
    file_source: str,
    photo_name: str,
    exif_dimensions: list[dict[str, Any]],
) -> dict[str, Any]:
    """Create EXIF entity nodes and relation edges after LightRAG processing.

    Creates the Photo node plus Date/Location/Camera entities from EXIF data,
    then links each to the Photo node with typed edges.
    """
    results: dict[str, Any] = {"entities_created": [], "relations_created": []}

    existing_labels = await _get_existing_labels()

    photo_match = _find_matching_entity(photo_name, existing_labels)
    if photo_match:
        logger.info("[EXIF Relations] Photo entity '%s' matches existing '%s', reusing", photo_name, photo_match)
        photo_result = {"status": "exists", "entity_name": photo_match, "entity_type": "Photo"}
    else:
        photo_result = await _create_entity_via_custom_kg(
            photo_name,
            {"description": f"Photo: {file_source}", "entity_type": "Photo", "source_id": file_source, "file_path": file_source},
        )
        existing_labels.add(photo_name)
    photo_result["entity_name"] = photo_result.get("entity_name") or photo_name
    photo_result["entity_type"] = "Photo"
    results["entities_created"].append(photo_result)

    if photo_result.get("status") == "error":
        logger.error(
            "[EXIF Relations] Photo entity '%s' failed: %s — skipping relations",
            photo_name, photo_result.get("error", "unknown"),
        )
        return results

    for dim in exif_dimensions:
        dim_name = dim["name"]
        dim_match = _find_matching_entity(dim_name, existing_labels)
        if dim_match:
            entity_result = {"status": "exists", "entity_name": dim_match, "entity_type": dim.get("entity_type", "ExifEntity")}
        else:
            entity_result = await _create_entity_via_custom_kg(
                dim_name,
                {
                    "description": dim.get("description", ""),
                    "entity_type": dim.get("entity_type", "ExifEntity"),
                    "source_id": file_source,
                    "file_path": file_source,
                },
            )
            existing_labels.add(dim_name)
        entity_result["entity_name"] = entity_result.get("entity_name") or dim_name
        entity_result["entity_type"] = dim.get("entity_type", "ExifEntity")
        results["entities_created"].append(entity_result)

        if entity_result.get("status") == "error":
            continue

        relation_result = await _create_relation_via_custom_kg(
            photo_name,
            dim_name,
            {
                "description": dim.get("edge_description", f"Photo linked to {dim_name}"),
                "keywords": dim.get("edge_keyword", "has_exif"),
                "weight": 1.0,
                "source_id": file_source,
                "file_path": file_source,
            },
        )
        results["relations_created"].append(relation_result)

    return results


async def link_exif_to_visual_entities(
    file_source: str,
    photo_name: str,
) -> dict[str, Any]:
    """Link LLM-extracted visual entities to the photo node.

    After LightRAG processes a document, it creates visual entities with the
    document's file_path.  This function finds those entities and creates
    edges from them to the photo node.
    """
    results: dict[str, Any] = {"visual_links_created": []}

    try:
        rag = await _get_rag()
        all_labels = await rag.get_graph_labels()
        all_labels = all_labels or []
        logger.info("[EXIF Links] Found %d labels for %s", len(all_labels), file_source)
    except Exception as exc:
        logger.warning("[EXIF Links] Failed to get graph labels: %s", exc)
        return results

    exif_suffixes = (" (Date)", " (Camera)", " (Location)", " (Photo)")

    for label in all_labels:
        if label.endswith(exif_suffixes):
            continue

        try:
            graph_data = await rag.get_knowledge_graph(label, max_depth=1, max_nodes=500)
        except Exception as exc:
            logger.warning("[EXIF Links] Failed to get neighbors for '%s': %s", label, exc)
            continue

        nodes = getattr(graph_data, "nodes", []) or []
        edges = getattr(graph_data, "edges", []) or []

        for node in nodes:
            node_id = getattr(node, "id", "") or (node.get("id", "") if isinstance(node, dict) else "")
            props = getattr(node, "properties", {}) or (node.get("properties", {}) if isinstance(node, dict) else {})
            if hasattr(props, "__dict__"):
                props = props.__dict__
            file_path = props.get("file_path", "")
            normalized_path = file_path.replace("\u202f", " ").replace("\u00a0", " ")
            normalized_source = file_source.replace("\u202f", " ").replace("\u00a0", " ")

            if normalized_path == normalized_source and node_id != photo_name:
                link_result = await _create_relation_via_custom_kg(
                    node_id,
                    photo_name,
                    {
                        "description": f"{node_id} appears in {file_source}",
                        "keywords": "appears_in",
                        "weight": 1.0,
                        "source_id": file_source,
                        "file_path": file_source,
                    },
                )
                results["visual_links_created"].append(link_result)

    return results


# ---------------------------------------------------------------------------
# Note-to-date linking
# ---------------------------------------------------------------------------


def _parse_file_source_date(file_source: str) -> datetime | None:
    """Extract a local-calendar ``datetime`` from a note file_source."""
    try:
        tz = zoneinfo.ZoneInfo(os.environ.get("TZ", "America/New_York"))
    except Exception:
        tz = zoneinfo.ZoneInfo("America/New_York")

    m = re.match(r"^note_(\d+)$", file_source)
    if m:
        try:
            return datetime.fromtimestamp(int(m.group(1)), tz=tz)
        except (ValueError, OSError, OverflowError):
            return None

    m = re.search(r"(\d{8})-(\d{6})-(\d{6})$", file_source)
    if m:
        ymd, hms, _ = m.groups()
        try:
            naive = datetime.strptime(f"{ymd}{hms}", "%Y%m%d%H%M%S")
            return naive.replace(tzinfo=tz)
        except ValueError:
            return None

    return None


async def link_note_to_date(
    file_source: str,
) -> dict[str, Any]:
    """Bridge a note's LLM-extracted entities into the temporal graph."""
    results: dict[str, Any] = {"date_links_created": []}

    dt = _parse_file_source_date(file_source)
    if dt is None:
        return results

    date_str = dt.strftime("%Y-%m-%d")
    date_entity = f"{date_str} (Date)"

    try:
        rag = await _get_rag()
        all_labels = await rag.get_graph_labels()
        all_labels = all_labels or []
    except Exception as exc:
        logger.warning("[Note Links] Failed to get graph labels: %s", exc)
        return results

    if date_entity not in all_labels:
        date_result = await _create_entity_via_custom_kg(
            date_entity,
            {
                "description": f"Calendar date {date_str}",
                "entity_type": "Date",
                "source_id": file_source,
                "file_path": file_source,
            },
        )
        results["date_links_created"].append(date_result)
    else:
        results["date_links_created"].append({"status": "exists", "entity_name": date_entity})

    for label in all_labels:
        if label.endswith(" (Date)") or label.endswith(" (Photo)"):
            continue
        try:
            graph_data = await rag.get_knowledge_graph(label, max_depth=1, max_nodes=500)
        except Exception:
            continue

        nodes = getattr(graph_data, "nodes", []) or []
        for node in nodes:
            node_id = getattr(node, "id", "") or (node.get("id", "") if isinstance(node, dict) else "")
            props = getattr(node, "properties", {}) or (node.get("properties", {}) if isinstance(node, dict) else {})
            if hasattr(props, "__dict__"):
                props = props.__dict__
            file_path = props.get("file_path", "")
            normalized_path = file_path.replace("\u202f", " ").replace("\u00a0", " ")
            normalized_source = file_source.replace("\u202f", " ").replace("\u00a0", " ")

            if normalized_path == normalized_source and node_id != date_entity:
                link_result = await _create_relation_via_custom_kg(
                    node_id,
                    date_entity,
                    {
                        "description": f"{node_id} occurred on {date_str}",
                        "keywords": "occurred_on",
                        "weight": 1.0,
                        "source_id": file_source,
                        "file_path": file_source,
                    },
                )
                results["date_links_created"].append(link_result)

    return results


# ---------------------------------------------------------------------------
# Wait for LightRAG processing
# ---------------------------------------------------------------------------


async def wait_for_lightrag_processing(
    file_source: str,
    poll_interval: float = 2.0,
    timeout: float = 300.0,
) -> str:
    """Wait for LightRAG to finish processing the document for ``file_source``.

    With the in-process LightRAG, ``ainsert`` is synchronous — it returns only
    after the document has been fully processed (entities extracted, graph
    updated).  So this function is effectively a no-op that confirms the
    document exists.  We keep the signature for compatibility with the phase
    runner, which calls it after ``upload_image_to_lightrag``.
    """
    start = time.monotonic()
    while True:
        elapsed = time.monotonic() - start
        if elapsed >= timeout:
            logger.warning(
                "wait_for_lightrag_processing timed out after %.0fs for '%s' "
                "(in-process insert should be synchronous — investigate)",
                timeout, file_source,
            )
            return "timeout"

        try:
            rag = await _get_rag()
            doc_status = getattr(rag, "doc_status", None)
            if doc_status is not None:
                from lightrag.utils import DocStatus

                ds = await doc_status.get_by_status(DocStatus.PROCESSED)
                if ds and any(
                    (d.get("file_path") if isinstance(d, dict) else getattr(d, "file_path", None)) == file_source
                    for d in ds
                ):
                    return "processed"
        except Exception:
            pass

        await asyncio.sleep(poll_interval)


# ---------------------------------------------------------------------------
# Main image processing generator
# ---------------------------------------------------------------------------


async def process_image(
    image_path: str,
    skip_exif: bool = False,
) -> AsyncGenerator[ProcessingEvent, None]:
    """Process a single image: EXIF extraction + caption building.

    Face detection is removed in this port.  Yields ``ProcessingEvent`` objects
    that the phase runner consumes.
    """
    exif_data: dict[str, Any] | None = None

    if not skip_exif:
        yield ProcessingEvent(event="extracting_exif", data={"image_path": image_path})
        exif_data = await asyncio.to_thread(_process_exif, image_path)
        yield ProcessingEvent(event="exif_complete", data={"exif": exif_data or {}})

    captions = _build_captions(exif_data, image_path)
    metadata_text = _build_metadata_text(exif_data, image_path)
    content_list = _build_content_list(image_path, captions)

    yield ProcessingEvent(
        event="captions_built",
        data={
            "content_list": content_list,
            "metadata_text": metadata_text,
            "exif_data": exif_data,
        },
    )


# ---------------------------------------------------------------------------
# Deletion helpers
# ---------------------------------------------------------------------------


async def delete_photo_entities(
    file_source: str,
) -> dict[str, Any]:
    """Delete the Photo node and EXIF entities created for a file source."""
    results: dict[str, Any] = {"entities_deleted": [], "errors": []}
    photo_name = f"{file_source} (Photo)"

    try:
        rag = await _get_rag()
        graph_data = await rag.get_knowledge_graph(photo_name, max_depth=1, max_nodes=500)
    except Exception as exc:
        logger.warning("[Delete Entities] Failed to fetch graph for '%s': %s", photo_name, exc)
        results["errors"].append({"step": "fetch_graph", "error": str(exc)})
        return results

    nodes = getattr(graph_data, "nodes", []) or []
    edges = getattr(graph_data, "edges", []) or []

    exif_suffixes = (" (Date)", " (Camera)", " (Location)")
    entities_to_delete: list[str] = []

    for node in nodes:
        node_id = getattr(node, "id", "") or (node.get("id", "") if isinstance(node, dict) else "")
        props = getattr(node, "properties", {}) or (node.get("properties", {}) if isinstance(node, dict) else {})
        if hasattr(props, "__dict__"):
            props = props.__dict__
        source_id = props.get("source_id", "")
        if node_id == photo_name or source_id == file_source:
            if node_id not in entities_to_delete:
                entities_to_delete.append(node_id)
        elif any(node_id.endswith(s) for s in exif_suffixes):
            connected = any(
                (getattr(e, "source", "") if not isinstance(e, dict) else e.get("source", "")) == photo_name
                and ((getattr(e, "target", "") if not isinstance(e, dict) else e.get("target", "")) == node_id)
                or ((getattr(e, "target", "") if not isinstance(e, dict) else e.get("target", "")) == photo_name
                    and (getattr(e, "source", "") if not isinstance(e, dict) else e.get("source", "")) == node_id)
                for e in edges
            )
            if connected and node_id not in entities_to_delete:
                entities_to_delete.append(node_id)

    for entity_name in entities_to_delete:
        try:
            rag = await _get_rag()
            await rag.adelete_by_entity(entity_name)
            results["entities_deleted"].append({"name": entity_name, "status": "deleted"})
            logger.info("[Delete Entities] Deleted '%s'", entity_name)
        except Exception as exc:
            if "not found" in str(exc).lower() or "404" in str(exc):
                results["entities_deleted"].append({"name": entity_name, "status": "not_found"})
            else:
                results["errors"].append({"entity": entity_name, "error": str(exc)})
                logger.warning("[Delete Entities] Failed to delete '%s': %s", entity_name, exc)

    return results


async def delete_lightrag_document_by_file_source(
    file_source: str,
) -> dict[str, Any]:
    """Delete the LightRAG document for a given file_source so it can be re-ingested."""
    try:
        rag = await _get_rag()
        from lightrag.utils import compute_mdhash_id

        doc_id = compute_mdhash_id(file_source)
        await rag.adelete_by_doc_id(doc_id)
        logger.info("[Delete Document] Deleted document '%s' (id=%s)", file_source, doc_id)
        return {"status": "success", "file_source": file_source, "doc_id": doc_id}
    except Exception as exc:
        logger.warning("[Delete Document] Failed to delete '%s': %s", file_source, exc)
        return {"status": "error", "file_source": file_source, "error": str(exc)}