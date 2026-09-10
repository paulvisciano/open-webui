"""Graph router for Open WebUI's knowledge-graph canvas.

Provides:
  * ``GET /``          — combined graph data (conversation nodes + LightRAG entity nodes + edges)
  * ``GET /conversations`` — user's chats as KGNode-compatible objects
  * ``GET /search``    — FTS over online assets + conversation title ilike
  * ``POST /images/process`` — accept an image upload, enqueue a processing job
  * ``GET /images/photo/{filename}`` — serve a stored image (optionally a thumbnail)
  * ``GET /health``    — liveness probe
"""

from __future__ import annotations

import asyncio
import logging
import mimetypes
import os
import shutil
import uuid
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from fastapi.responses import FileResponse
from pydantic import BaseModel

from open_webui.constants import ERROR_MESSAGES
from open_webui.graph.sources import (
    forget_source,
    is_online,
    presence_monitor,
    set_abs_path,
    set_online,
)
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

_scan_tasks: dict[str, asyncio.Task] = {}


def _scan_running(source_id: str) -> bool:
    task = _scan_tasks.get(source_id)
    return task is not None and not task.done()


def _source_roots() -> list[str]:
    raw = os.environ.get('GRAPH_SOURCE_ROOTS', '')
    if raw.strip():
        parts = [
            p.strip()
            for p in raw.replace(',', os.pathsep).split(os.pathsep)
            if p.strip()
        ]
    else:
        parts = [os.path.expanduser('~'), '/Volumes', '/tmp']
    roots: list[str] = []
    seen: set[str] = set()
    for part in parts:
        try:
            real = os.path.realpath(os.path.expanduser(part))
        except OSError:
            continue
        if real in seen:
            continue
        seen.add(real)
        roots.append(real)
    return roots


def _is_under_root(path: str, root: str) -> bool:
    try:
        real = os.path.realpath(path)
        root_real = os.path.realpath(root)
    except OSError:
        return False
    if real == root_real:
        return True
    prefix = root_real if root_real.endswith(os.sep) else root_real + os.sep
    return real.startswith(prefix)


def _path_allowed(path: str) -> bool:
    return any(_is_under_root(path, root) for root in _source_roots())


def _reject_unallowed(path: str) -> str:
    if not path:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail='path is required',
        )
    try:
        real = os.path.realpath(path)
    except OSError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail='invalid path',
        ) from exc
    if not _path_allowed(real):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail='path is outside allowed roots',
        )
    return real


def _bare_asset_id(raw: str) -> str:
    if raw.startswith('asset:'):
        return raw[6:]
    return raw


def _parse_asset_id(raw: str) -> str:
    bare = _bare_asset_id(raw or '')
    try:
        return str(uuid.UUID(bare))
    except (ValueError, AttributeError, TypeError) as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=ERROR_MESSAGES.NOT_FOUND,
        ) from exc


def _resolved_relative_to(
    path: str | Path,
    root: str | Path,
    *,
    forbidden_status: int = status.HTTP_403_FORBIDDEN,
) -> Path:
    try:
        real = Path(path).resolve()
        root_real = Path(root).resolve()
    except OSError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=ERROR_MESSAGES.NOT_FOUND,
        ) from exc
    try:
        real.relative_to(root_real)
    except ValueError as exc:
        raise HTTPException(
            status_code=forbidden_status,
            detail='path is outside source root'
            if forbidden_status == status.HTTP_403_FORBIDDEN
            else ERROR_MESSAGES.NOT_FOUND,
        ) from exc
    return real


def _source_payload(row: dict, *, asset_count: int | None = None) -> dict:
    source_id = str(row.get('id') or '')
    last = row.get('last_abs_path') or ''
    if last and presence_monitor.last_abs_path(source_id) is None:
        set_abs_path(source_id, last)
    payload = {
        'id': source_id,
        'name': row.get('name') or '',
        'last_abs_path': last,
        'fingerprint': row.get('fingerprint') or '',
        'online': is_online(source_id),
        'scanning': _scan_running(source_id),
    }
    if asset_count is not None:
        payload['asset_count'] = asset_count
    return payload


def _canvas_asset(row: dict) -> dict:
    return {
        'id': row.get('id') or '',
        'source_id': row.get('source_id') or '',
        'kind': row.get('kind') or '',
        'title': row.get('title') or '',
        'taken_at': row.get('taken_at'),
        'rel_path': row.get('rel_path') or '',
    }


async def _ensure_graph_db() -> None:
    from open_webui.graph._db import init_db

    await init_db()


async def _owned_source(source_id: str, user_id: str) -> dict:
    await _ensure_graph_db()
    from open_webui.graph._db import get_source

    source = await get_source(source_id)
    if source is None or source.get('user_id') != user_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=ERROR_MESSAGES.NOT_FOUND,
        )
    return source


async def _run_scan(source_id: str) -> None:
    from open_webui.graph.scanner import scan_source

    try:
        async for _progress in scan_source(source_id):
            pass
    except Exception:
        log.exception('scan_source failed source_id=%s', source_id)


def _cancel_scan(source_id: str) -> None:
    task = _scan_tasks.pop(source_id, None)
    if task is not None and not task.done():
        task.cancel()


def _enqueue_scan(source_id: str) -> None:
    existing = _scan_tasks.get(source_id)
    if existing is not None and not existing.done():
        return
    task = asyncio.create_task(_run_scan(source_id), name=f'graph-scan-{source_id}')
    _scan_tasks[source_id] = task

    def _clear(done: asyncio.Task, *, sid: str = source_id) -> None:
        current = _scan_tasks.get(sid)
        if current is done:
            _scan_tasks.pop(sid, None)

    task.add_done_callback(_clear)


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


class AttachSourceBody(BaseModel):
    abs_path: str
    name: Optional[str] = None


class PresenceBody(BaseModel):
    online: bool


@router.get('/sources/browse')
async def browse_sources(
    path: str = Query(''),
    user=Depends(get_verified_user),
):
    if not path:
        entries = []
        for root in _source_roots():
            if os.path.isdir(root):
                entries.append(
                    {
                        'name': os.path.basename(root) or root,
                        'path': root,
                        'is_dir': True,
                    }
                )
        return entries

    real = _reject_unallowed(path)
    if not os.path.exists(real):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=ERROR_MESSAGES.NOT_FOUND,
        )
    if not os.path.isdir(real):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail='path is not a directory',
        )

    try:
        names = os.listdir(real)
    except OSError as exc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail='cannot list path',
        ) from exc

    entries = []
    for name in names:
        if name in ('.', '..'):
            continue
        child = os.path.join(real, name)
        try:
            child_real = os.path.realpath(child)
            is_dir = os.path.isdir(child)
        except OSError:
            continue
        if not _path_allowed(child_real):
            continue
        entries.append(
            {
                'name': name,
                'path': child_real,
                'is_dir': bool(is_dir),
            }
        )
    entries.sort(key=lambda e: (not e['is_dir'], e['name'].lower()))
    return entries


@router.post('/sources')
async def attach_source(
    body: AttachSourceBody,
    user=Depends(get_verified_user),
):
    from open_webui.graph._db import count_assets_by_source, insert_source
    from open_webui.graph.sources import fingerprint_for

    real = _reject_unallowed(body.abs_path)
    if not os.path.exists(real):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=ERROR_MESSAGES.NOT_FOUND,
        )
    if not os.path.isdir(real):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail='abs_path is not a directory',
        )

    await _ensure_graph_db()
    fingerprint = fingerprint_for(Path(real))
    name = body.name or os.path.basename(real) or real
    row = await insert_source(
        user_id=user.id,
        fingerprint=fingerprint,
        name=name,
        last_abs_path=real,
        kind='folder',
    )
    set_abs_path(row['id'], real)
    n = await count_assets_by_source(row['id'])
    return _source_payload(row, asset_count=n)


@router.get('/sources')
async def get_sources(
    user=Depends(get_verified_user),
):
    from open_webui.graph._db import count_assets_by_source, list_sources

    await _ensure_graph_db()
    rows = await list_sources(user.id)
    out = []
    for row in rows:
        n = await count_assets_by_source(row['id'])
        out.append(_source_payload(row, asset_count=n))
    return out


@router.delete('/sources/{source_id}')
async def detach_source(
    source_id: str,
    user=Depends(get_verified_user),
):
    await _owned_source(source_id, user.id)
    _cancel_scan(source_id)
    from open_webui.graph._db import delete_source
    from open_webui.graph.thumbs import delete_source_thumbs

    n = await delete_source(source_id)
    forget_source(source_id)
    delete_source_thumbs(source_id)
    return {'ok': True, 'source_id': source_id, 'removed_assets': n}


@router.post('/sources/{source_id}/scan')
async def start_source_scan(
    source_id: str,
    user=Depends(get_verified_user),
):
    await _owned_source(source_id, user.id)
    _enqueue_scan(source_id)
    return {'status': 'accepted', 'source_id': source_id}


@router.post('/sources/{source_id}/presence')
async def set_source_presence(
    source_id: str,
    body: PresenceBody,
    user=Depends(get_verified_user),
):
    from open_webui.graph._db import count_assets_by_source

    source = await _owned_source(source_id, user.id)
    last = source.get('last_abs_path')
    if last:
        set_abs_path(source_id, last)
    set_online(source_id, bool(body.online))
    n = await count_assets_by_source(source_id)
    return _source_payload(source, asset_count=n)


@router.get('/canvas')
async def get_canvas(
    user=Depends(get_verified_user),
    db: AsyncSession = Depends(get_async_session),
):
    from open_webui.graph._db import list_assets_for_canvas, list_sources

    await _ensure_graph_db()

    source_rows = await list_sources(user.id)
    sources = [_source_payload(row) for row in source_rows]
    online_ids = {s['id'] for s in sources if s['online']}

    asset_rows = await list_assets_for_canvas(user.id)
    assets = [
        _canvas_asset(row)
        for row in asset_rows
        if row.get('source_id') in online_ids
    ]

    conversations: list[dict] = []
    try:
        chats = await Chats.get_chat_list_by_user_id(
            user.id,
            include_archived=False,
            skip=0,
            limit=500,
            db=db,
        )
        conversations = [_chat_to_kgnode(chat) for chat in chats]
    except Exception as exc:
        log.warning('Failed to load conversations for canvas: %s', exc)

    return {
        'sources': sources,
        'assets': assets,
        'conversations': conversations,
    }


@router.get('/search')
async def search_graph(
    q: str = Query(''),
    user=Depends(get_verified_user),
    db: AsyncSession = Depends(get_async_session),
):
    """FTS over online library assets plus conversation title ilike.

    Hits are ``{id, title, kind}`` only — never ``search_text``. Offline
    sources are omitted; FTS rows are not dropped on unplug.
    """
    from open_webui.graph._db import list_sources, search_assets_fts

    query = (q or '').strip()
    if not query:
        return []

    await _ensure_graph_db()

    source_rows = await list_sources(user.id)
    online_ids = [
        payload['id']
        for payload in (_source_payload(row) for row in source_rows)
        if payload['online']
    ]

    hits: list[dict] = []
    if online_ids:
        try:
            hits.extend(await search_assets_fts(user.id, query, online_ids))
        except Exception as exc:
            log.warning('asset FTS search failed: %s', exc)

    try:
        chats = await Chats.get_chat_list_by_user_id(
            user.id,
            include_archived=False,
            filter={'query': query},
            skip=0,
            limit=20,
            db=db,
        )
        for chat in chats:
            hits.append(
                {
                    'id': chat.id,
                    'title': getattr(chat, 'title', '') or '',
                    'kind': 'conversation',
                }
            )
    except Exception as exc:
        log.warning('conversation search failed: %s', exc)

    return hits


def _asset_original_path(asset: dict, source: dict) -> str:
    rel = asset.get('rel_path') or ''
    root = source.get('last_abs_path') or ''
    if os.path.isabs(rel):
        return rel
    return os.path.join(root, rel)


def _jail_original(asset: dict, source: dict) -> str:
    root = source.get('last_abs_path') or ''
    if not root:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=ERROR_MESSAGES.NOT_FOUND,
        )
    original = _asset_original_path(asset, source)
    real = _resolved_relative_to(original, root)
    if not _path_allowed(str(real)):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail='path is outside source root',
        )
    return str(real)


async def _owned_asset(asset_id: str, user_id: str) -> tuple[dict, dict]:
    from open_webui.graph._db import get_asset

    await _ensure_graph_db()
    asset = await get_asset(_parse_asset_id(asset_id))
    if asset is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=ERROR_MESSAGES.NOT_FOUND,
        )
    source = await _owned_source(str(asset['source_id']), user_id)
    return asset, source


def _thumb_media_type(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix == '.webp':
        return 'image/webp'
    if suffix == '.png':
        return 'image/png'
    if suffix in {'.jpg', '.jpeg'}:
        return 'image/jpeg'
    guessed, _ = mimetypes.guess_type(str(path))
    return guessed or 'image/webp'


@router.get('/assets/{asset_id}/thumb')
async def get_asset_thumb(
    asset_id: str,
    user=Depends(get_verified_user),
    w: int = Query(512),
):
    from open_webui.graph.thumbs import (
        GRAPH_THUMBS_DIR,
        ensure_thumb,
        placeholder_thumb,
    )

    asset, source = await _owned_asset(asset_id, user.id)
    if not is_online(str(source['id'])):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=ERROR_MESSAGES.NOT_FOUND,
        )
    original = _jail_original(asset, source)
    if not os.path.isfile(original):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=ERROR_MESSAGES.NOT_FOUND,
        )
    payload = dict(asset)
    payload['abs_path'] = original
    size = 1024 if w >= 1024 else 512
    thumb: Path | None = None
    try:
        generated = await asyncio.to_thread(ensure_thumb, payload, size)
        if generated is not None:
            thumb = Path(generated)
    except Exception:
        log.exception('ensure_thumb failed asset_id=%s', asset_id)
        thumb = None
    kind = str(asset.get('kind') or '').lower()
    if thumb is None or not thumb.is_file():
        if kind in ('photo', 'video'):
            try:
                thumb = placeholder_thumb()
            except Exception:
                log.exception('placeholder_thumb failed asset_id=%s', asset_id)
                thumb = None
        if thumb is None or not Path(thumb).is_file():
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=ERROR_MESSAGES.NOT_FOUND,
            )
    served = _resolved_relative_to(
        thumb,
        GRAPH_THUMBS_DIR,
        forbidden_status=status.HTTP_404_NOT_FOUND,
    )
    return FileResponse(str(served), media_type=_thumb_media_type(served))


@router.get('/assets/{asset_id}/file')
async def get_asset_file(
    asset_id: str,
    user=Depends(get_verified_user),
):
    asset, source = await _owned_asset(asset_id, user.id)
    if not is_online(str(source['id'])):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=ERROR_MESSAGES.NOT_FOUND,
        )
    original = _jail_original(asset, source)
    if not os.path.isfile(original):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=ERROR_MESSAGES.NOT_FOUND,
        )
    media_type = asset.get('mime') or mimetypes.guess_type(original)[0]
    return FileResponse(original, media_type=media_type)


@router.get('/assets/{asset_id}/exif')
async def get_asset_exif(
    asset_id: str,
    user=Depends(get_verified_user),
):
    asset, source = await _owned_asset(asset_id, user.id)
    if not is_online(str(source['id'])):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=ERROR_MESSAGES.NOT_FOUND,
        )
    kind = str(asset.get('kind') or '').lower()
    if kind != 'photo':
        return {}
    original = _jail_original(asset, source)
    if not os.path.isfile(original):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=ERROR_MESSAGES.NOT_FOUND,
        )
    from open_webui.graph._db import get_photo_exif, save_photo_exif
    from open_webui.graph.exif_extractor import extract_exif_metadata

    key = f'asset:{_parse_asset_id(asset_id)}'
    cached = await get_photo_exif(key)
    if cached:
        return cached
    data = await asyncio.to_thread(extract_exif_metadata, original)
    if data and (len(data) > 1 or data.get('metadata_text')):
        await save_photo_exif(key, data, data.get('metadata_text'))
    return data or {}


@router.post('/assets/{asset_id}/path')
async def reveal_asset_path(
    asset_id: str,
    user=Depends(get_verified_user),
):
    asset, source = await _owned_asset(asset_id, user.id)
    if not is_online(str(source['id'])):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=ERROR_MESSAGES.NOT_FOUND,
        )
    original = _jail_original(asset, source)
    return {'path': original}


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