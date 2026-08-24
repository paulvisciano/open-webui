"""Graph router for Open WebUI's knowledge-graph canvas.

Provides:
  * ``GET /``          — combined graph data (conversation nodes + LightRAG entity nodes + edges)
  * ``GET /conversations`` — user's chats as KGNode-compatible objects
  * ``POST /images/process`` — accept an image upload, enqueue a processing job
  * ``GET /images/photo/{filename}`` — serve a stored image (optionally a thumbnail)
  * ``GET /health``    — liveness probe
"""

from __future__ import annotations

import logging
import os
import shutil
import uuid
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from pydantic import BaseModel

from open_webui.constants import ERROR_MESSAGES
from open_webui.internal.db import get_async_session
from open_webui.models.chats import Chats
from open_webui.services import lightrag_service
from open_webui.utils.auth import get_verified_user
from sqlalchemy.ext.asyncio import AsyncSession

log = logging.getLogger(__name__)

router = APIRouter()

IMAGES_DIR = Path(
    os.environ.get(
        'GRAPH_IMAGES_DIR',
        str(Path(__file__).resolve().parent.parent / 'data' / 'graph_images'),
    )
)
IMAGES_DIR.mkdir(parents=True, exist_ok=True)

THUMBNAIL_MAX_DIM = 300


def _chat_to_kgnode(chat) -> dict:
    """Convert a ChatTitleIdResponse (or row) to the KGNode format the frontend expects.

    KGNode shape: ``{ id, labels, properties }`` where ``labels`` is a list of
    strings and ``properties`` is a flat dict of scalar metadata.
    """
    created_at = getattr(chat, 'created_at', None)
    updated_at = getattr(chat, 'updated_at', None)
    title = getattr(chat, 'title', '') or ''

    properties: dict = {
        'title': title,
        'created_at': created_at,
        'updated_at': updated_at,
    }

    pinned = getattr(chat, 'pinned', None)
    if pinned is not None:
        properties['pinned'] = bool(pinned)

    archived = getattr(chat, 'archived', None)
    if archived is not None:
        properties['archived'] = bool(archived)

    folder_id = getattr(chat, 'folder_id', None)
    if folder_id:
        properties['folder_id'] = folder_id

    last_read_at = getattr(chat, 'last_read_at', None)
    if last_read_at is not None:
        properties['last_read_at'] = last_read_at

    return {
        'id': chat.id,
        'labels': ['Conversation'],
        'properties': properties,
    }


async def _get_lightrag_nodes_edges() -> tuple[list[dict], list[dict]]:
    """Best-effort fetch of LightRAG entity nodes and edges.

    Returns ``([], [])`` if LightRAG is unavailable or the graph is empty so
    the canvas degrades gracefully to conversations-only.
    """
    try:
        from open_webui.services.lightrag_service import get_graph_data

        data = await get_graph_data()
        nodes = data.get('nodes', []) or []
        edges = data.get('edges', []) or []

        normalised_nodes: list[dict] = []
        for n in nodes:
            if isinstance(n, dict) and 'id' in n:
                node_id = n['id']
                props = {k: v for k, v in n.items() if k != 'id'}
                labels = props.pop('labels', None) or props.pop('entity_type', None)
                if isinstance(labels, str):
                    labels = [labels]
                if not labels:
                    labels = ['Entity']
                normalised_nodes.append(
                    {'id': str(node_id), 'labels': labels, 'properties': props}
                )

        normalised_edges: list[dict] = []
        for e in edges:
            if isinstance(e, dict) and 'source' in e and 'target' in e:
                src = e['source']
                tgt = e['target']
                props = {k: v for k, v in e.items() if k not in ('source', 'target')}
                normalised_edges.append(
                    {'source': str(src), 'target': str(tgt), 'properties': props}
                )

        return normalised_nodes, normalised_edges
    except Exception as exc:
        log.warning('LightRAG graph data unavailable: %s', exc)
        return [], []


@router.get('/')
async def get_graph(
    user=Depends(get_verified_user),
    db: AsyncSession = Depends(get_async_session),
):
    """Return the combined knowledge graph for the canvas.

    Conversation nodes come from OWUI's ``chat`` table (no edges between
    conversations per the plan's Decision 4).  Entity nodes and edges come
    from the LightRAG singleton when available.
    """
    nodes: list[dict] = []
    edges: list[dict] = []

    try:
        chats = await Chats.get_chat_list_by_user_id(
            user.id,
            include_archived=False,
            skip=0,
            limit=500,
            db=db,
        )
        for chat in chats:
            nodes.append(_chat_to_kgnode(chat))
    except Exception as exc:
        log.warning('Failed to load conversations for graph: %s', exc)

    try:
        rag_nodes, rag_edges = await _get_lightrag_nodes_edges()
        nodes.extend(rag_nodes)
        edges.extend(rag_edges)
    except Exception as exc:
        log.warning('Failed to load LightRAG graph: %s', exc)

    return {'nodes': nodes, 'edges': edges}


@router.get('/conversations')
async def get_conversations(
    user=Depends(get_verified_user),
    db: AsyncSession = Depends(get_async_session),
):
    """Return the current user's conversations as KGNode-compatible objects.

    Each item has the shape ``{ id, labels: ['Conversation'], properties: {...} }``
    which is what the frontend conversation provider expects.
    """
    try:
        chats = await Chats.get_chat_list_by_user_id(
            user.id,
            include_archived=False,
            skip=0,
            limit=500,
            db=db,
        )
        return [_chat_to_kgnode(chat) for chat in chats]
    except Exception as exc:
        log.exception('Failed to load conversations: %s', exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=ERROR_MESSAGES.DEFAULT(),
        )


@router.post('/images/process')
async def process_image(
    file: UploadFile = File(...),
    user=Depends(get_verified_user),
    db: AsyncSession = Depends(get_async_session),
):
    """Accept an image upload, persist it to the graph images directory, and
    enqueue a processing job via the graph pipeline's job manager.

    The heavy lifting (EXIF extraction, VLM captioning, LightRAG insertion)
    is performed asynchronously by ``open_webui.graph.phases.start_processing``
    so the HTTP response returns immediately with the job id.
    """
    if not file.content_type or not file.content_type.startswith('image/'):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail='Uploaded file is not an image',
        )

    original_name = file.filename or 'upload.jpg'
    safe_stem = Path(original_name).stem.replace('/', '_').replace(' ', '_')[:80]
    file_source = f'{safe_stem}_{uuid.uuid4().hex[:8]}'
    ext = Path(original_name).suffix.lower() or '.jpg'
    stored_filename = f'{file_source}{ext}'
    dest_path = IMAGES_DIR / stored_filename

    try:
        with open(dest_path, 'wb') as out:
            shutil.copyfileobj(file.file, out)
    except Exception as exc:
        log.exception('Failed to store uploaded image: %s', exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail='Failed to store uploaded image',
        )
    finally:
        await file.close()

    job_id: str | None = None
    try:
        from open_webui.graph.job_manager import create_job
        from open_webui.graph.phases import start_processing

        job = await create_job(
            file_source=file_source,
            file_path=str(dest_path),
            skip_exif=False,
            skip_faces=True,
            insert=True,
            note=f'Uploaded by {user.id}',
            file_type='image',
        )
        job_id = job.id

        try:
            await start_processing(job, phase='both')
        except Exception as exc:
            log.warning('start_processing failed (worker may handle it): %s', exc)
    except Exception as exc:
        log.warning('Graph pipeline unavailable, image stored but not processed: %s', exc)

    return {
        'status': 'accepted',
        'file_source': file_source,
        'filename': stored_filename,
        'job_id': job_id,
    }


@router.get('/images/photo/{filename}')
async def get_image(
    filename: str,
    user=Depends(get_verified_user),
    db: AsyncSession = Depends(get_async_session),
    w: str | None = None,
):
    """Serve a stored graph image.

    The optional ``w`` query parameter requests a thumbnail.  When ``w=thumb``
    a proportionally-resized preview is generated on-the-fly and cached.
    """
    safe_name = Path(filename).name
    image_path = IMAGES_DIR / safe_name

    if not image_path.exists() or not image_path.is_file():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=ERROR_MESSAGES.NOT_FOUND,
        )

    if w is not None:
        thumb_path = IMAGES_DIR / 'thumbs' / safe_name
        thumb_path.parent.mkdir(parents=True, exist_ok=True)

        if not thumb_path.exists():
            try:
                from PIL import Image

                with Image.open(image_path) as img:
                    img.thumbnail((THUMBNAIL_MAX_DIM, THUMBNAIL_MAX_DIM))
                    img.save(thumb_path)
            except Exception as exc:
                log.warning('Thumbnail generation failed for %s: %s', safe_name, exc)
                return FileResponse(str(image_path))

        return FileResponse(str(thumb_path))

    return FileResponse(str(image_path))


@router.get('/health')
async def get_graph_health(
    user=Depends(get_verified_user),
):
    return {'status': 'ok'}


class QueryBody(BaseModel):
    query: str
    mode: str = 'hybrid'
    only_need_context: Optional[bool] = None
    only_need_prompt: Optional[bool] = None
    response_type: Optional[str] = None
    top_k: Optional[int] = None
    history_turns: Optional[int] = None
    conversation_history: Optional[list[dict[str, Any]]] = None
    include_references: Optional[bool] = None
    include_chunk_content: Optional[bool] = None


class CreateEntityBody(BaseModel):
    name: str
    type: str
    properties: dict[str, Any] = {}


class CreateRelationBody(BaseModel):
    source: str
    target: str
    relation: str
    properties: dict[str, Any] = {}


class MergeEntitiesBody(BaseModel):
    source: str
    target: str


def _entity_payload(node_id: str, node_data: dict) -> dict:
    return {
        'entity_name': node_id,
        'entity_type': node_data.get('entity_type', 'Entity'),
        'description': node_data.get('description', ''),
        'source_id': node_data.get('source_id', ''),
        'file_path': node_data.get('file_path', ''),
        'created_at': node_data.get('created_at', ''),
        'reference_id': node_id,
    }


def _relationship_payload(src: str, tgt: str, edge_data: dict) -> dict:
    return {
        'src_id': src,
        'tgt_id': tgt,
        'description': edge_data.get('description', ''),
        'keywords': edge_data.get('keywords', ''),
        'weight': edge_data.get('weight', 1.0),
        'source_id': edge_data.get('source_id', ''),
        'file_path': edge_data.get('file_path', ''),
        'created_at': edge_data.get('created_at', ''),
        'reference_id': f'{src}-{tgt}',
    }


@router.post('/query')
async def query_lightrag(
    body: QueryBody,
    user=Depends(get_verified_user),
):
    """Query the LightRAG singleton (entity search / graph traversal)."""
    try:
        result = await lightrag_service.query(
            body.query,
            mode=body.mode,
            top_k=body.top_k,
        )
        return {'response': result}
    except Exception as exc:
        log.exception('LightRAG query failed')
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        ) from exc


@router.get('/entities')
async def get_entities(
    type: Optional[str] = None,
    limit: Optional[int] = None,
    user=Depends(get_verified_user),
):
    """List entities from the LightRAG graph, optionally filtered by type."""
    try:
        rag = await lightrag_service.get_lightrag()
        graph = rag.chunk_entity_relation_graph
        nx_graph = getattr(graph, '_graph', None)
        if nx_graph is None:
            return []
        entities: list[dict] = []
        for node_id, node_data in nx_graph.nodes(data=True):
            data = node_data or {}
            if type and data.get('entity_type', 'Entity') != type:
                continue
            entities.append(_entity_payload(node_id, data))
            if limit and len(entities) >= limit:
                break
        return entities
    except Exception as exc:
        log.exception('LightRAG get_entities failed')
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        ) from exc


@router.get('/entity/{entity_id}')
async def get_entity(
    entity_id: str,
    user=Depends(get_verified_user),
):
    """Return a single entity's details (for NodeDetail.svelte)."""
    try:
        rag = await lightrag_service.get_lightrag()
        graph = rag.chunk_entity_relation_graph
        nx_graph = getattr(graph, '_graph', None)
        if nx_graph is None or entity_id not in nx_graph:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=ERROR_MESSAGES.NOT_FOUND,
            )
        return _entity_payload(entity_id, nx_graph.nodes[entity_id] or {})
    except HTTPException:
        raise
    except Exception as exc:
        log.exception('LightRAG get_entity failed')
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        ) from exc


@router.get('/relationships')
async def get_relationships(
    entity_id: Optional[str] = None,
    limit: Optional[int] = None,
    user=Depends(get_verified_user),
):
    """List relationships (edges); optionally filter to those touching ``entity_id``."""
    try:
        rag = await lightrag_service.get_lightrag()
        graph = rag.chunk_entity_relation_graph
        nx_graph = getattr(graph, '_graph', None)
        if nx_graph is None:
            return []
        relationships: list[dict] = []
        for src, tgt, edge_data in nx_graph.edges(data=True):
            if entity_id and src != entity_id and tgt != entity_id:
                continue
            relationships.append(_relationship_payload(src, tgt, edge_data or {}))
            if limit and len(relationships) >= limit:
                break
        return relationships
    except Exception as exc:
        log.exception('LightRAG get_relationships failed')
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        ) from exc


@router.get('/labels')
async def get_labels(
    user=Depends(get_verified_user),
):
    """Return distinct entity types present in the LightRAG graph."""
    try:
        rag = await lightrag_service.get_lightrag()
        graph = rag.chunk_entity_relation_graph
        nx_graph = getattr(graph, '_graph', None)
        if nx_graph is None:
            return []
        labels: set[str] = set()
        for _, node_data in nx_graph.nodes(data=True):
            et = (node_data or {}).get('entity_type')
            if et:
                labels.add(et)
        return sorted(labels)
    except Exception as exc:
        log.exception('LightRAG get_labels failed')
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        ) from exc


@router.get('/entity-types')
async def get_entity_types(
    user=Depends(get_verified_user),
):
    return await get_labels(user=user)


@router.post('/entities')
async def create_entity(
    body: CreateEntityBody,
    user=Depends(get_verified_user),
):
    """Insert a new entity description into LightRAG via ainsert."""
    try:
        rag = await lightrag_service.get_lightrag()
        text = f'{body.name} ({body.type})'
        if body.properties:
            text += f' {body.properties}'
        await rag.ainsert(text)
        return {'status': 'created', 'name': body.name}
    except Exception as exc:
        log.exception('LightRAG create_entity failed')
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        ) from exc


@router.post('/relationships')
async def create_relation(
    body: CreateRelationBody,
    user=Depends(get_verified_user),
):
    """Insert a new relation description into LightRAG via ainsert."""
    try:
        rag = await lightrag_service.get_lightrag()
        text = f'{body.source} {body.relation} {body.target}'
        if body.properties:
            text += f' {body.properties}'
        await rag.ainsert(text)
        return {'status': 'created', 'source': body.source, 'target': body.target}
    except Exception as exc:
        log.exception('LightRAG create_relation failed')
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        ) from exc


@router.post('/entities/merge')
async def merge_entities(
    body: MergeEntitiesBody,
    user=Depends(get_verified_user),
):
    raise HTTPException(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        detail='Entity merge not yet supported by the OWUI graph router.',
    )