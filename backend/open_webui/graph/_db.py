"""asyncpg pool for the graph image pipeline.

The image pipeline (job queue, event bus) predates Open WebUI's SQLAlchemy
layer and relies on asyncpg for NOTIFY/LISTEN and lightweight job-row updates.
The pool is created lazily on first use and points at the same Postgres
instance as OWUI's ``DATABASE_URL`` (and the LightRAG singleton).

Tables (``jobs``, ``job_events``, ``photo_metadata``, ``graph_source``,
``graph_asset``, ``graph_asset_fts``) are created idempotently by
:func:`init_db` the first time the pool is acquired.

``graph_source`` identity is ``(user_id, last_abs_path)``. ``fingerprint`` is
the volume UUID used by the presence monitor (unplug / remount), not uniqueness.
Two folders on the same disk are two sources. ``graph_asset.id`` stores a
bare uuid; the ``asset:`` prefix is applied later on KGNode, not in Postgres.
``taken_at`` is unix-epoch float and is the time-depth (Z) field — do not add
a separate time column. Presence is not stored; the monitor derives it.
"""

from __future__ import annotations

import getpass
import logging
import os
import uuid
from pathlib import Path
from urllib.parse import quote, urlsplit

import asyncpg

logger = logging.getLogger(__name__)


def _os_user() -> str:
    return os.environ.get('USER') or getpass.getuser()


def _strip_sqlalchemy_driver(url: str) -> str:
    scheme, sep, rest = url.partition('://')
    if not sep:
        return url
    base = scheme.split('+', 1)[0]
    if base in ('postgres', 'postgresql'):
        return f'postgresql://{rest}'
    return url


def _is_postgres_url(url: str) -> bool:
    scheme = url.split('://', 1)[0].split('+', 1)[0]
    return scheme in ('postgres', 'postgresql')


def _build_postgres_url(user: str | None = None, password: str | None = None) -> str:
    user = user if user is not None else os.environ.get('POSTGRES_USER') or _os_user()
    if password is None:
        password = os.environ.get('POSTGRES_PASSWORD', '')
    host = os.environ.get('POSTGRES_HOST', 'localhost')
    port = os.environ.get('POSTGRES_PORT', '5432')
    db = os.environ.get('POSTGRES_DATABASE', 'postgres')
    if password:
        return f'postgresql://{user}:{password}@{host}:{port}/{db}'
    return f'postgresql://{user}@{host}:{port}/{db}'


def _peer_fallback_url(url: str) -> str:
    parts = urlsplit(url)
    host = parts.hostname or os.environ.get('POSTGRES_HOST', 'localhost')
    port = parts.port or int(os.environ.get('POSTGRES_PORT', '5432'))
    db = (parts.path or '/postgres').lstrip('/') or 'postgres'
    return f'postgresql://{quote(_os_user(), safe="")}@{host}:{port}/{db}'


def _resolve_database_url() -> str:
    graph_url = (os.environ.get('GRAPH_DATABASE_URL') or '').strip()
    if graph_url:
        return _strip_sqlalchemy_driver(graph_url)
    db_url = (os.environ.get('DATABASE_URL') or '').strip()
    if db_url and _is_postgres_url(db_url):
        return _strip_sqlalchemy_driver(db_url)
    return _build_postgres_url()


DATABASE_URL = _resolve_database_url()

_pool: asyncpg.Pool | None = None
_initialized = False


async def get_pool() -> asyncpg.Pool:
    global _pool, DATABASE_URL
    if _pool is None:
        try:
            _pool = await asyncpg.create_pool(
                DATABASE_URL,
                min_size=1,
                max_size=10,
                command_timeout=30,
                max_inactive_connection_lifetime=300,
            )
        except asyncpg.exceptions.InvalidAuthorizationSpecificationError:
            fallback = _peer_fallback_url(DATABASE_URL)
            logger.warning(
                'graph postgres auth failed; retrying peer as %s',
                _os_user(),
            )
            DATABASE_URL = fallback
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

            CREATE TABLE IF NOT EXISTS graph_source (
                id TEXT PRIMARY KEY,
                user_id TEXT,
                name TEXT,
                fingerprint TEXT NOT NULL,
                last_abs_path TEXT,
                kind TEXT,
                created_at DOUBLE PRECISION NOT NULL DEFAULT extract(epoch from now()),
                updated_at DOUBLE PRECISION NOT NULL DEFAULT extract(epoch from now())
            );

            CREATE TABLE IF NOT EXISTS graph_asset (
                id TEXT PRIMARY KEY,
                source_id TEXT,
                rel_path TEXT,
                content_hash TEXT,
                kind TEXT,
                taken_at DOUBLE PRECISION,
                title TEXT,
                search_text TEXT,
                size_bytes BIGINT,
                mtime_ns BIGINT,
                mime TEXT,
                UNIQUE (source_id, rel_path)
            );
            CREATE INDEX IF NOT EXISTS idx_graph_asset_source_id
                ON graph_asset(source_id);
            CREATE INDEX IF NOT EXISTS idx_graph_asset_content_hash
                ON graph_asset(content_hash);
            CREATE INDEX IF NOT EXISTS idx_graph_asset_taken_at
                ON graph_asset(taken_at);

            CREATE TABLE IF NOT EXISTS graph_asset_fts (
                asset_id TEXT PRIMARY KEY
                    REFERENCES graph_asset(id) ON DELETE CASCADE,
                tsv tsvector NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_graph_asset_fts_gin
                ON graph_asset_fts USING GIN (tsv);

            INSERT INTO graph_asset_fts (asset_id, tsv)
            SELECT a.id,
                   to_tsvector(
                       'simple',
                       concat_ws(
                           ' ',
                           coalesce(a.rel_path, ''),
                           coalesce(a.title, ''),
                           coalesce(a.search_text, '')
                       )
                   )
            FROM graph_asset a
            ON CONFLICT (asset_id) DO NOTHING;
        """)
        await conn.execute("""
            ALTER TABLE graph_source
                DROP CONSTRAINT IF EXISTS graph_source_user_id_fingerprint_key;
            DROP INDEX IF EXISTS graph_source_user_id_fingerprint_key;
            DROP INDEX IF EXISTS graph_source_user_id_fingerprint_idx;
        """)
        await conn.execute("""
            DO $$
            DECLARE
                rec RECORD;
            BEGIN
                FOR rec IN
                    SELECT c.conname
                    FROM pg_constraint c
                    JOIN pg_class t ON t.oid = c.conrelid
                    JOIN pg_namespace n ON n.oid = t.relnamespace
                    WHERE t.relname = 'graph_source'
                      AND n.nspname = current_schema()
                      AND c.contype = 'u'
                      AND pg_get_constraintdef(c.oid) ILIKE '%fingerprint%'
                LOOP
                    EXECUTE format(
                        'ALTER TABLE graph_source DROP CONSTRAINT IF EXISTS %I',
                        rec.conname
                    );
                END LOOP;

                FOR rec IN
                    SELECT i.relname AS index_name
                    FROM pg_index x
                    JOIN pg_class i ON i.oid = x.indexrelid
                    JOIN pg_class t ON t.oid = x.indrelid
                    JOIN pg_namespace n ON n.oid = t.relnamespace
                    WHERE t.relname = 'graph_source'
                      AND n.nspname = current_schema()
                      AND x.indisunique
                      AND NOT x.indisprimary
                      AND NOT EXISTS (
                          SELECT 1 FROM pg_constraint c
                          WHERE c.conindid = x.indexrelid
                      )
                      AND pg_get_indexdef(x.indexrelid) ILIKE '%(user_id, fingerprint)%'
                LOOP
                    EXECUTE format('DROP INDEX IF EXISTS %I', rec.index_name);
                END LOOP;
            END $$;
        """)
        await conn.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS graph_source_user_id_path_key
                ON graph_source (user_id, last_abs_path)
                WHERE last_abs_path IS NOT NULL;
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
    raw = row['exif_data']
    if isinstance(raw, dict):
        return raw
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return None


def _bare_asset_id(raw: str | None) -> str:
    if not raw:
        return str(uuid.uuid4())
    if raw.startswith('asset:'):
        return raw[6:]
    return raw


async def _update_source_identity(
    conn: asyncpg.Connection,
    source_id: str,
    name: str | None,
    fingerprint: str,
) -> dict:
    row = await conn.fetchrow(
        """UPDATE graph_source
           SET name = COALESCE($2, name),
               fingerprint = $3,
               updated_at = extract(epoch from now())
           WHERE id = $1
           RETURNING *""",
        source_id,
        name,
        fingerprint,
    )
    return dict(row)


async def insert_source(
    user_id: str,
    fingerprint: str,
    name: str | None = None,
    last_abs_path: str | None = None,
    kind: str = 'folder',
    source_id: str | None = None,
) -> dict:
    source_id = source_id or str(uuid.uuid4())
    pool = await get_pool()
    async with pool.acquire() as conn:
        if last_abs_path is not None:
            existing = await conn.fetchrow(
                """SELECT id FROM graph_source
                   WHERE user_id = $1 AND last_abs_path = $2""",
                user_id,
                last_abs_path,
            )
            if existing is not None:
                return await _update_source_identity(
                    conn, existing['id'], name, fingerprint
                )
        try:
            row = await conn.fetchrow(
                """INSERT INTO graph_source
                     (id, user_id, name, fingerprint, last_abs_path, kind,
                      created_at, updated_at)
                   VALUES ($1, $2, $3, $4, $5, $6,
                           extract(epoch from now()), extract(epoch from now()))
                   RETURNING *""",
                source_id,
                user_id,
                name,
                fingerprint,
                last_abs_path,
                kind,
            )
        except asyncpg.exceptions.UniqueViolationError:
            if last_abs_path is None:
                raise
            existing = await conn.fetchrow(
                """SELECT id FROM graph_source
                   WHERE user_id = $1 AND last_abs_path = $2""",
                user_id,
                last_abs_path,
            )
            if existing is None:
                raise
            return await _update_source_identity(
                conn, existing['id'], name, fingerprint
            )
    return dict(row)


async def list_sources(user_id: str) -> list[dict]:
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT id, user_id, name, fingerprint, last_abs_path, kind,
                      created_at, updated_at
               FROM graph_source
               WHERE user_id = $1
               ORDER BY created_at""",
            user_id,
        )
    return [dict(row) for row in rows]


async def upsert_assets_batch(assets: list[dict]) -> None:
    if not assets:
        return
    records = [
        (
            _bare_asset_id(asset.get('id')),
            asset['source_id'],
            asset['rel_path'],
            asset.get('content_hash'),
            asset.get('kind'),
            asset.get('taken_at'),
            asset.get('title'),
            asset.get('search_text'),
            asset.get('size_bytes'),
            asset.get('mtime_ns'),
            asset.get('mime'),
        )
        for asset in assets
    ]
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.executemany(
                """INSERT INTO graph_asset
                     (id, source_id, rel_path, content_hash, kind, taken_at,
                      title, search_text, size_bytes, mtime_ns, mime)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                   ON CONFLICT (source_id, rel_path)
                   DO UPDATE SET
                     content_hash = COALESCE(EXCLUDED.content_hash, graph_asset.content_hash),
                     kind = COALESCE(EXCLUDED.kind, graph_asset.kind),
                     taken_at = COALESCE(EXCLUDED.taken_at, graph_asset.taken_at),
                     title = COALESCE(EXCLUDED.title, graph_asset.title),
                     search_text = COALESCE(EXCLUDED.search_text, graph_asset.search_text),
                     size_bytes = COALESCE(EXCLUDED.size_bytes, graph_asset.size_bytes),
                     mtime_ns = COALESCE(EXCLUDED.mtime_ns, graph_asset.mtime_ns),
                     mime = COALESCE(EXCLUDED.mime, graph_asset.mime)""",
                records,
            )
            await _refresh_fts(conn, assets)


async def list_assets_for_canvas(user_id: str) -> list[dict]:
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT a.id, a.source_id, a.rel_path, a.content_hash, a.kind,
                      a.taken_at, a.title, a.search_text, a.size_bytes,
                      a.mtime_ns, a.mime
               FROM graph_asset a
               JOIN graph_source s ON s.id = a.source_id
                WHERE s.user_id = $1
                ORDER BY a.taken_at NULLS LAST, a.rel_path""",
            user_id,
        )
    return [dict(row) for row in rows]


async def get_asset(asset_id: str) -> dict | None:
    asset_id = _bare_asset_id(asset_id)
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """SELECT id, source_id, rel_path, content_hash, kind,
                      taken_at, title, search_text, size_bytes,
                      mtime_ns, mime
               FROM graph_asset
               WHERE id = $1""",
            asset_id,
        )
    return dict(row) if row else None


async def count_assets_by_source(source_id: str) -> int:
    pool = await get_pool()
    async with pool.acquire() as conn:
        n = await conn.fetchval(
            'SELECT COUNT(*) FROM graph_asset WHERE source_id = $1',
            source_id,
        )
    return int(n or 0)


async def get_source(source_id: str) -> dict | None:
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """SELECT id, user_id, name, fingerprint, last_abs_path, kind,
                      created_at, updated_at
               FROM graph_source
               WHERE id = $1""",
            source_id,
        )
    return dict(row) if row else None


async def list_assets_by_source(source_id: str) -> list[dict]:
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT id, source_id, rel_path, content_hash, kind,
                      taken_at, title, search_text, size_bytes,
                      mtime_ns, mime
               FROM graph_asset
               WHERE source_id = $1
               ORDER BY rel_path""",
            source_id,
        )
    return [dict(row) for row in rows]


async def delete_assets_by_rel_paths(source_id: str, rel_paths: list[str]) -> int:
    if not rel_paths:
        return 0
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                """DELETE FROM graph_asset_fts
                   WHERE asset_id IN (
                       SELECT id FROM graph_asset
                       WHERE source_id = $1 AND rel_path = ANY($2::text[])
                   )""",
                source_id,
                rel_paths,
            )
            result = await conn.execute(
                """DELETE FROM graph_asset
                   WHERE source_id = $1 AND rel_path = ANY($2::text[])""",
                source_id,
                rel_paths,
            )
    try:
        return int(str(result).split()[-1])
    except (ValueError, IndexError):
        return 0


_FTS_DOCUMENT_SQL = """
concat_ws(
    ' ',
    coalesce(a.rel_path, ''),
    coalesce(a.title, ''),
    coalesce(a.search_text, '')
)
"""


async def _refresh_fts(conn: asyncpg.Connection, assets: list[dict]) -> None:
    by_source: dict[str, list[str]] = {}
    for asset in assets:
        source_id = asset.get('source_id')
        rel_path = asset.get('rel_path')
        if not source_id or not rel_path:
            continue
        by_source.setdefault(source_id, []).append(rel_path)
    for source_id, rel_paths in by_source.items():
        await conn.execute(
            f"""INSERT INTO graph_asset_fts (asset_id, tsv)
                SELECT a.id, to_tsvector('simple', {_FTS_DOCUMENT_SQL})
                FROM graph_asset a
                WHERE a.source_id = $1 AND a.rel_path = ANY($2::text[])
                ON CONFLICT (asset_id) DO UPDATE SET tsv = EXCLUDED.tsv""",
            source_id,
            rel_paths,
        )


async def update_asset_search_text(asset_id: str, search_text: str) -> None:
    asset_id = _bare_asset_id(asset_id)
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                'UPDATE graph_asset SET search_text = $2 WHERE id = $1',
                asset_id,
                search_text,
            )
            await conn.execute(
                f"""INSERT INTO graph_asset_fts (asset_id, tsv)
                    SELECT a.id, to_tsvector('simple', {_FTS_DOCUMENT_SQL})
                    FROM graph_asset a
                    WHERE a.id = $1
                    ON CONFLICT (asset_id) DO UPDATE SET tsv = EXCLUDED.tsv""",
                asset_id,
            )


async def search_assets_fts(
    user_id: str,
    query: str,
    online_source_ids: list[str],
    limit: int = 50,
) -> list[dict]:
    q = (query or '').strip()
    if not q or not online_source_ids:
        return []
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT a.id, a.title, a.kind,
                      ts_rank(f.tsv, q) AS rank
               FROM graph_asset_fts f
               JOIN graph_asset a ON a.id = f.asset_id
               JOIN graph_source s ON s.id = a.source_id
               CROSS JOIN plainto_tsquery('simple', $3) AS q
               WHERE s.user_id = $1
                 AND a.source_id = ANY($2::text[])
                 AND q::text <> ''
                 AND f.tsv @@ q
               ORDER BY rank DESC, a.title
               LIMIT $4""",
            user_id,
            online_source_ids,
            q,
            limit,
        )
    return [
        {
            'id': row['id'],
            'title': row['title'] or '',
            'kind': row['kind'] or '',
        }
        for row in rows
    ]


async def count_fts_for_source(source_id: str) -> int:
    pool = await get_pool()
    async with pool.acquire() as conn:
        n = await conn.fetchval(
            """SELECT COUNT(*)
               FROM graph_asset_fts f
               JOIN graph_asset a ON a.id = f.asset_id
               WHERE a.source_id = $1""",
            source_id,
        )
    return int(n or 0)
