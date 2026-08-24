"""asyncpg pool for the graph image pipeline.

The image pipeline (job queue, event bus) predates Open WebUI's SQLAlchemy
layer and relies on asyncpg for NOTIFY/LISTEN and lightweight job-row updates.
The pool is created lazily on first use and points at the same Postgres
instance as OWUI's ``DATABASE_URL`` (and the LightRAG singleton).

Tables (``jobs``, ``job_events``, ``photo_metadata``) are created idempotently
by :func:`init_db` the first time the pool is acquired.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

import asyncpg

logger = logging.getLogger(__name__)

DATABASE_URL = os.environ.get(
    'DATABASE_URL',
    f"postgresql://{os.environ.get('POSTGRES_USER', 'postgres')}:"
    f"{os.environ.get('POSTGRES_PASSWORD', 'postgres')}"
    f"@{os.environ.get('POSTGRES_HOST', 'localhost')}:"
    f"{os.environ.get('POSTGRES_PORT', '5432')}"
    f"/{os.environ.get('POSTGRES_DATABASE', 'postgres')}",
)

if DATABASE_URL.startswith('postgres://'):
    DATABASE_URL = DATABASE_URL.replace('postgres://', 'postgresql://', 1)

_pool: asyncpg.Pool | None = None
_initialized = False


async def get_pool() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(
            DATABASE_URL,
            min_size=1,
            max_size=10,
            command_timeout=30,
            max_inactive_connection_lifetime=300,
        )
    return _pool


async def init_db() -> None:
    global _initialized
    if _initialized:
        return
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                file_source TEXT NOT NULL,
                file_path TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                stage TEXT,
                error TEXT,
                skip_exif BOOLEAN NOT NULL DEFAULT FALSE,
                skip_faces BOOLEAN NOT NULL DEFAULT FALSE,
                insert BOOLEAN NOT NULL DEFAULT TRUE,
                created_at DOUBLE PRECISION NOT NULL DEFAULT extract(epoch from now()),
                updated_at DOUBLE PRECISION NOT NULL DEFAULT extract(epoch from now()),
                note TEXT NOT NULL DEFAULT '',
                file_type TEXT NOT NULL DEFAULT 'image'
            );

            CREATE TABLE IF NOT EXISTS job_events (
                id BIGSERIAL PRIMARY KEY,
                job_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                event_data JSONB,
                created_at DOUBLE PRECISION NOT NULL DEFAULT extract(epoch from now())
            );
            CREATE INDEX IF NOT EXISTS idx_job_events_job_id ON job_events(job_id);

            CREATE TABLE IF NOT EXISTS photo_metadata (
                file_source TEXT PRIMARY KEY,
                exif_data JSONB,
                date_taken TEXT,
                date_taken_friendly TEXT,
                image_width INTEGER,
                image_height INTEGER,
                metadata_text TEXT,
                created_at DOUBLE PRECISION NOT NULL DEFAULT extract(epoch from now()),
                updated_at DOUBLE PRECISION NOT NULL DEFAULT extract(epoch from now())
            );
        """)
    _initialized = True


async def close_db() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


INPUT_DIR = Path(
    os.environ.get(
        'GRAPH_INPUT_DIR',
        str(Path(__file__).resolve().parent.parent.parent / 'data' / 'graph_images'),
    )
)


async def save_photo_exif(
    file_source: str,
    exif_data: dict,
    metadata_text: str | None = None,
) -> None:
    import json

    date_taken = exif_data.get('date_taken')
    friendly = exif_data.get('date_taken_friendly')
    width = exif_data.get('image_width')
    height = exif_data.get('image_height')

    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            """INSERT INTO photo_metadata
                 (file_source, exif_data, date_taken, date_taken_friendly,
                  image_width, image_height, metadata_text, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, extract(epoch from now()), extract(epoch from now()))
               ON CONFLICT (file_source)
               DO UPDATE SET
                 exif_data = $2,
                 date_taken = COALESCE($3, photo_metadata.date_taken),
                 date_taken_friendly = COALESCE($4, photo_metadata.date_taken_friendly),
                 image_width = COALESCE($5, photo_metadata.image_width),
                 image_height = COALESCE($6, photo_metadata.image_height),
                 metadata_text = COALESCE($7, photo_metadata.metadata_text),
                 updated_at = extract(epoch from now())""",
            file_source,
            json.dumps(exif_data),
            date_taken,
            friendly,
            width,
            height,
            metadata_text,
        )


async def get_photo_metadata_text(file_source: str) -> str | None:
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            'SELECT metadata_text FROM photo_metadata WHERE file_source = $1',
            file_source,
        )
    return row['metadata_text'] if row else None


async def get_photo_exif(file_source: str) -> dict | None:
    import json

    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            'SELECT exif_data FROM photo_metadata WHERE file_source = $1',
            file_source,
        )
    if not row or not row['exif_data']:
        return None
    try:
        return json.loads(row['exif_data'])
    except (json.JSONDecodeError, TypeError):
        return None