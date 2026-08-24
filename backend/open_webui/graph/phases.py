"""Two-phase image processing pipeline runners, shared by the worker and the
synchronous API endpoints.

Ported from the Knowledge Graph project. Adapted for Open WebUI's in-process
LightRAG singleton: the processor functions no longer take a ``lightrag_url``
argument — they use ``_get_rag()`` internally to reach the shared LightRAG
instance.

The semaphores (``_semaphore``, ``_exif_semaphore``) and the
``_running_tasks`` dict are per-process state and live here in the worker
process. The VLM semaphore in ``processor.py`` (``_get_vlm_semaphore``) is
separate and imported by both processes.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from dataclasses import asdict
from pathlib import Path
from typing import Any, AsyncGenerator

from sse_starlette.sse import ServerSentEvent

from open_webui.graph.processor import (
    create_exif_relations,
    link_exif_to_visual_entities,
    prepare_vlm_image,
    cleanup_vlm_image,
    process_image,
    upload_image_to_lightrag,
    wait_for_lightrag_processing,
)
from open_webui.graph.job_manager import (
    Job,
    get_events,
    get_job,
    store_event,
    update_job_status,
)

logger = logging.getLogger(__name__)

KNOWN_FACES_PATH = os.environ.get(
    "KNOWN_FACES_PATH",
    str(Path(__file__).resolve().parent.parent.parent.parent / "known_faces"),
)


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def vlm_batch_start_hour() -> int:
    return _env_int("VLM_BATCH_START_HOUR", 2)


def vlm_batch_enabled() -> bool:
    return _env_int("VLM_BATCH_ENABLED", 1) == 1


MAX_CONCURRENT_JOBS = 3
_semaphore = asyncio.Semaphore(MAX_CONCURRENT_JOBS)

MAX_EXIF_CONCURRENT = 10
_exif_semaphore = asyncio.Semaphore(MAX_EXIF_CONCURRENT)

_running_tasks: dict[str, asyncio.Task] = {}


async def _emit_exif_entities(
    file_source: str,
    exif_data: dict,
) -> AsyncGenerator[ServerSentEvent, None]:
    photo_name = f"{file_source} (Photo)"
    exif_dimensions: list[dict[str, Any]] = []

    date_taken_friendly = exif_data.get("date_taken_friendly")
    if date_taken_friendly:
        date_only = date_taken_friendly.split(" at ")[0].split(" ")[0]
        exif_dimensions.append({"name": f"{date_only} (Date)", "entity_type": "Date", "description": f"Calendar date {date_taken_friendly}", "edge_keyword": "taken_on", "edge_description": f"Photo taken on {date_taken_friendly}"})

    location = exif_data.get("location")
    if location:
        loc_str = location if isinstance(location, str) else str(location)
        if loc_str:
            exif_dimensions.append({"name": f"{loc_str} (Location)", "entity_type": "Location", "description": f"Location in {loc_str}", "edge_keyword": "taken_at", "edge_description": f"Photo taken at {loc_str}"})

    camera = exif_data.get("camera") or exif_data.get("camera_make") or exif_data.get("camera_model")
    if camera:
        exif_dimensions.append({"name": f"{camera} (Camera)", "entity_type": "Camera", "description": f"Camera device: {camera}", "edge_keyword": "taken_with", "edge_description": f"Photo taken with {camera}"})

    yield ServerSentEvent(event="message", data=json.dumps({"event": "injecting_exif_relations", "data": {"file_source": file_source}, "timestamp": time.time()}))
    yield ServerSentEvent(event="message", data=json.dumps({"event": "photo_node_created", "data": {"entity_name": photo_name, "entity_type": "Photo", "labels": ["Photo"], "source_id": file_source}, "timestamp": time.time()}))
    for dim in exif_dimensions:
        yield ServerSentEvent(event="message", data=json.dumps({"event": "exif_node_created", "data": {"entity_name": dim["name"], "entity_type": dim.get("entity_type", "ExifEntity"), "labels": [dim.get("entity_type", "ExifEntity")]}}))

    if exif_dimensions:
        yield ServerSentEvent(event="message", data=json.dumps({"event": "creating_exif_entities", "data": {"file_source": file_source, "dimensions_count": len(exif_dimensions)}, "timestamp": time.time()}))
        exif_result = None
        max_create_attempts = 3
        for attempt in range(max_create_attempts):
            try:
                exif_result = await create_exif_relations(file_source, photo_name, exif_dimensions)
                failed_entities = [e for e in exif_result.get("entities_created", []) if e.get("status") == "error"]
                if not failed_entities:
                    break
                logger.warning("[EXIF] attempt %d/%d had %d failed entities for %s, retrying",
                               attempt + 1, max_create_attempts, len(failed_entities), file_source)
            except Exception as exc:
                logger.warning("[EXIF] attempt %d/%d raised for %s: %s",
                               attempt + 1, max_create_attempts, file_source, exc)
                exif_result = None
            if attempt < max_create_attempts - 1:
                await asyncio.sleep(2.0 * (attempt + 1))
        if exif_result:
            for entity in exif_result.get("entities_created", []):
                if "entity_name" not in entity and "data" in entity and isinstance(entity["data"], dict):
                    entity["entity_name"] = entity["data"].get("entity_name", "")
                if "entity_type" not in entity and "data" in entity and isinstance(entity["data"], dict):
                    entity["entity_type"] = entity["data"].get("entity_type", "")
            for relation in exif_result.get("relations_created", []):
                src = relation.get("source") or relation.get("source_entity") or ""
                tgt = relation.get("target") or relation.get("target_entity") or ""
                yield ServerSentEvent(event="message", data=json.dumps({"event": "exif_relation_created", "data": {"source": src, "target": tgt, "relation_type": relation.get("keywords", "has_exif")}, "timestamp": time.time()}))
            yield ServerSentEvent(event="message", data=json.dumps({"event": "exif_entities_complete", "data": {"file_source": file_source, "entities": len(exif_result.get("entities_created", [])), "relations": len(exif_result.get("relations_created", []))}, "timestamp": time.time()}))
        else:
            logger.error("EXIF entity creation failed for %s after %d attempts", file_source, max_create_attempts)
            yield ServerSentEvent(event="message", data=json.dumps({"event": "exif_entities_failed", "data": {"error": "max retries exceeded", "exif_dimensions": exif_dimensions}, "timestamp": time.time()}))


async def _run_exif_phase(
    file_path: str,
    file_source: str,
    skip_exif: bool,
    skip_faces: bool,
    insert: bool,
    note: str = "",
):
    content_list: list[dict] | None = None
    metadata_text: str | None = None
    exif_data: dict | None = None
    exif_entities_emitted = False

    async for event in process_image(
        file_path,
        known_faces_path=KNOWN_FACES_PATH,
        skip_exif=skip_exif,
        skip_faces=skip_faces,
    ):
        if event.event == "captions_built":
            content_list = event.data.get("content_list")
            metadata_text = event.data.get("metadata_text")
            exif_data = event.data.get("exif_data")

        if event.event == "exif_complete":
            exif_data = event.data.get("exif") or event.data.get("exif_data")

        yield ServerSentEvent(
            event="message",
            data=json.dumps(asdict(event)),
        )

        if event.event == "exif_complete" and insert and not exif_entities_emitted:
            exif_entities_emitted = True
            async for sse_event in _emit_exif_entities(file_source, exif_data):
                yield sse_event

    if not insert:
        yield ServerSentEvent(
            event="message",
            data=json.dumps({"event": "pipeline_complete", "data": {"file_source": file_source, "status": "no_insert"}, "timestamp": time.time()}),
        )
        return

    if not exif_entities_emitted and exif_data:
        async for sse_event in _emit_exif_entities(file_source, exif_data):
            yield sse_event

    yield ServerSentEvent(
        event="message",
        data=json.dumps({"event": "exif_phase_complete", "data": {"file_source": file_source}, "timestamp": time.time()}),
    )

    if exif_data is not None:
        try:
            from open_webui.graph._db import save_photo_exif
            await save_photo_exif(file_source, exif_data, metadata_text=metadata_text)
        except Exception:
            logger.exception("Failed to persist EXIF + metadata_text for %s", file_source)

    return


async def _run_ai_phase(
    file_path: str,
    file_source: str,
    metadata_text: str | None,
    note: str = "",
    photo_name: str | None = None,
):
    if metadata_text is None:
        try:
            from open_webui.graph._db import get_photo_metadata_text
            metadata_text = await get_photo_metadata_text(file_source)
        except Exception:
            logger.exception("Failed to load metadata_text for %s", file_source)

    yield ServerSentEvent(
        event="message",
        data=json.dumps({"event": "queued_for_ai", "data": {"file_source": file_source}, "timestamp": time.time()}),
    )
    yield ServerSentEvent(
        event="message",
        data=json.dumps({"event": "describing_image", "data": {"file_source": file_source}, "timestamp": time.time()}),
    )
    try:
        if note:
            metadata_text = (f"User note: {note}\n\n" + metadata_text) if metadata_text else f"User note: {note}"
        vlm_image_path = prepare_vlm_image(file_path)
        try:
            upload_result = await upload_image_to_lightrag(
                vlm_image_path, filename=file_source, metadata_text=metadata_text,
            )
        finally:
            cleanup_vlm_image(vlm_image_path)
        if upload_result.get("status") == "error":
            yield ServerSentEvent(
                event="message",
                data=json.dumps({"event": "upload_failed", "data": upload_result, "timestamp": time.time()}),
            )
            yield ServerSentEvent(
                event="message",
                data=json.dumps({"event": "pipeline_complete", "data": {"file_source": file_source, "status": "upload_failed"}, "timestamp": time.time()}),
            )
            return
        yield ServerSentEvent(
            event="message",
            data=json.dumps({"event": "upload_complete", "data": upload_result, "timestamp": time.time()}),
        )
    except Exception as exc:
        yield ServerSentEvent(
            event="message",
            data=json.dumps({"event": "upload_failed", "data": {"error": str(exc)}, "timestamp": time.time()}),
        )
        yield ServerSentEvent(
            event="message",
            data=json.dumps({"event": "pipeline_complete", "data": {"file_source": file_source, "status": "upload_failed"}, "timestamp": time.time()}),
        )
        return

    yield ServerSentEvent(
        event="message",
        data=json.dumps({"event": "lightrag_upload_complete", "data": {"file_source": file_source}, "timestamp": time.time()}),
    )

    yield ServerSentEvent(
        event="message",
        data=json.dumps({"event": "lightrag_processing_waiting", "data": {"file_source": file_source}, "timestamp": time.time()}),
    )
    try:
        final_status = await wait_for_lightrag_processing(file_source)
        yield ServerSentEvent(
            event="message",
            data=json.dumps({"event": "lightrag_processing_complete", "data": {"file_source": file_source, "status": final_status}, "timestamp": time.time()}),
        )
    except TimeoutError as exc:
        yield ServerSentEvent(
            event="message",
            data=json.dumps({"event": "lightrag_processing_timeout", "data": {"error": str(exc)}, "timestamp": time.time()}),
        )
    except Exception as exc:
        yield ServerSentEvent(
            event="message",
            data=json.dumps({"event": "lightrag_processing_error", "data": {"error": str(exc)}, "timestamp": time.time()}),
        )

    if photo_name is None:
        photo_name = f"{file_source} (Photo)"

    try:
        visual_result = await link_exif_to_visual_entities(file_source, photo_name)
        for link in visual_result.get("visual_links_created", []):
            if "source" not in link:
                link["source"] = link.get("source_entity") or link.get("src") or ""
            if "target" not in link:
                link["target"] = link.get("target_entity") or link.get("tgt") or photo_name
            yield ServerSentEvent(
                event="message",
                data=json.dumps({"event": "visual_entity_linked", "data": link, "timestamp": time.time()}),
            )
        yield ServerSentEvent(
            event="message",
            data=json.dumps({"event": "visual_links_complete", "data": visual_result, "timestamp": time.time()}),
        )
    except Exception as exc:
        logger.exception("Visual entity linking failed for %s", file_source)
        yield ServerSentEvent(
            event="message",
            data=json.dumps({"event": "visual_links_failed", "data": {"error": str(exc)}, "timestamp": time.time()}),
        )

    yield ServerSentEvent(
        event="message",
        data=json.dumps({"event": "pipeline_complete", "data": {"file_source": file_source}, "timestamp": time.time()}),
    )


async def _process_and_stream(
    file_path: str,
    file_source: str,
    skip_exif: bool,
    skip_faces: bool,
    insert: bool,
    note: str = "",
):
    metadata_text: str | None = None
    async for ev in _run_exif_phase(file_path, file_source, skip_exif, skip_faces, insert, note):
        yield ev

    if not insert:
        return

    async for ev in _run_ai_phase(file_path, file_source, None, note=note):
        yield ev


async def start_processing(job: Job, phase: str = "both") -> None:
    task = asyncio.create_task(_run_job(job, phase))
    _running_tasks[job.id] = task
    task.add_done_callback(lambda t: _running_tasks.pop(job.id, None))


async def _run_job(job: Job, phase: str = "both") -> None:
    sem = _exif_semaphore if phase == "exif" else _semaphore
    async with sem:
        try:
            await update_job_status(job.id, "processing", "starting")
            if phase == "exif":
                event_generator = _phase1_generator(job)
                await _drain_generator(job, event_generator, phase)
            elif phase == "ai":
                event_generator = _phase2_generator(job)
                await _drain_generator(job, event_generator, phase)
            else:
                event_generator = _both_phase_generator(job)
                await _drain_generator(job, event_generator, "both")
        except asyncio.CancelledError:
            await update_job_status(job.id, "cancelled", "cancelled")
        except Exception as exc:
            logger.exception("Job %s failed", job.id)
            await update_job_status(job.id, "failed", "error", str(exc))
            await store_event(job.id, "pipeline_failed", {"error": str(exc)})


async def _phase1_generator(job: Job):
    async for sse_event in _run_exif_phase(
        job.file_path,
        job.file_source,
        job.skip_exif,
        job.skip_faces,
        job.insert,
        note=job.note,
    ):
        yield sse_event


async def _phase2_generator(job: Job):
    async for sse_event in _run_ai_phase(
        job.file_path,
        job.file_source,
        None,
        note=job.note,
    ):
        yield sse_event


async def _both_phase_generator(job: Job):
    async for sse_event in _process_and_stream(
        job.file_path,
        job.file_source,
        job.skip_exif,
        job.skip_faces,
        job.insert,
        note=job.note,
    ):
        yield sse_event


async def _drain_generator(job: Job, event_generator, phase: str) -> None:
    async for sse_event in event_generator:
        if not sse_event.data:
            continue
        try:
            payload = json.loads(sse_event.data)
            event_name = payload.get("event", "")
            event_data = payload.get("data", {})
            stage = _map_event_to_stage(event_name)
            if stage:
                await update_job_status(job.id, "processing", stage)
            if event_name == "exif_complete":
                exif = event_data.get("exif") or event_data.get("exif_data")
                if exif:
                    from open_webui.graph._db import save_photo_exif
                    await save_photo_exif(job.file_source, exif)
            await store_event(job.id, event_name, event_data if isinstance(event_data, dict) else {"raw": event_data})
        except (json.JSONDecodeError, TypeError):
            await store_event(job.id, "raw", {"data": sse_event.data})

    if phase == "exif":
        await update_job_status(job.id, "processing", "exif_complete")
    else:
        await update_job_status(job.id, "complete", "pipeline_complete")


def _map_event_to_stage(event_name: str) -> str:
    if event_name in ("extracting_exif", "exif_complete", "detecting_faces", "faces_complete", "captions_built", "exif_dimensions_ready"):
        return "extracting_metadata"
    if event_name in ("injecting_exif_relations", "creating_exif_entities", "photo_node_created", "exif_node_created", "exif_relation_created", "exif_entities_complete"):
        return "creating_entities"
    if event_name == "exif_phase_complete":
        return "exif_complete"
    if event_name in ("describing_image", "upload_complete", "lightrag_upload_complete", "lightrag_processing_waiting", "lightrag_processing_timeout"):
        return "processing_ai"
    if event_name in ("lightrag_processing_complete",) or event_name.startswith("visual_"):
        return "linking_entities"
    if event_name == "pipeline_complete":
        return "complete"
    if event_name.endswith("_failed") or event_name.endswith("_error") or event_name.endswith("_timeout"):
        return "error"
    return ""


async def run_batch_phases(jobs: list[Job]) -> None:
    phase1_tasks = [
        asyncio.create_task(_run_job(job, phase="exif"))
        for job in jobs
    ]
    await asyncio.gather(*phase1_tasks, return_exceptions=True)

    if vlm_batch_enabled():
        promoted = sum(
            1 for job in jobs
            if (fresh := await get_job(job.id))
            and fresh.status == "processing"
            and fresh.stage == "exif_complete"
        )
        if promoted:
            logger.info("VLM batch enabled — %d job(s) left at exif_complete for overnight/manual processing", promoted)
        return

    phase2_jobs: list[Job] = []
    for job in jobs:
        fresh = await get_job(job.id)
        if fresh is None:
            continue
        if fresh.status == "processing" and fresh.stage == "exif_complete":
            phase2_jobs.append(fresh)
        elif fresh.status == "complete":
            continue

    phase2_tasks = [
        asyncio.create_task(_run_job(job, phase="ai"))
        for job in phase2_jobs
    ]
    await asyncio.gather(*phase2_tasks, return_exceptions=True)


async def run_overnight_vlm_batch() -> int:
    from open_webui.graph._db import get_pool
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT * FROM jobs WHERE status = 'processing' AND stage = 'exif_complete' ORDER BY created_at"
        )
    jobs = [Job(**dict(r)) for r in rows]
    if not jobs:
        logger.info("Overnight VLM batch: no exif_complete jobs to process")
        return 0

    logger.info("Overnight VLM batch: processing %d job(s)", len(jobs))
    tasks = [asyncio.create_task(_run_job(job, phase="ai")) for job in jobs]
    await asyncio.gather(*tasks, return_exceptions=True)
    return len(jobs)