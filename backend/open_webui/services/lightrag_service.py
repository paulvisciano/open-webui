"""LightRAG service — in-process library wrapper around the vendored LightRAG.

LightRAG is imported as a Python library (NOT a separate process / HTTP server).
This module owns the singleton ``LightRAG`` instance, wires its embedding and
LLM functions to Open WebUI's OpenAI-compatible model endpoints, and points its
storage backends at OWUI's Postgres database.

Configuration resolution (first wins):
  * Explicit kwargs to ``get_lightrag(...)``.
  * ``LIGHTRAG_*`` env vars (LIGHTRAG_LLM_MODEL, LIGHTRAG_EMBEDDING_MODEL, …).
  * OWUI defaults: ``OPENAI_API_BASE_URL`` / ``OPENAI_API_KEY`` and the
    ``DATABASE_URL`` postgres connection.

Postgres connection sharing:
  LightRAG's asyncpg pool reads ``POSTGRES_{HOST,PORT,USER,PASSWORD,DATABASE}``
  env vars (see ``lightrag/kg/postgres_impl.py`` ``ClientManager.get_config``).
  ``_sync_postgres_env()`` derives these from OWUI's ``DATABASE_URL`` once, at
  first init, so both OWUI (SQLAlchemy/psycopg) and LightRAG (asyncpg) talk to
  the same database without double configuration.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Optional
from urllib.parse import urlparse

from lightrag import LightRAG, QueryParam
from lightrag.utils import EmbeddingFunc
from lightrag.llm.openai import openai_complete_if_cache, openai_embed

log = logging.getLogger(__name__)

_rag: Optional[LightRAG] = None
_pg_env_synced = False


def _sync_postgres_env() -> None:
    """Derive POSTGRES_* env vars from OWUI's DATABASE_URL (idempotent).

    LightRAG's ``ClientManager.get_config`` reads POSTGRES_HOST / POSTGRES_PORT
    / POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DATABASE from the process
    environment.  Rather than requiring operators to set both DATABASE_URL and
    the POSTGRES_* vars, we parse DATABASE_URL once and populate the missing
    POSTGRES_* keys.  Existing POSTGRES_* values are left untouched so an
    operator can still point LightRAG at a separate database if desired.
    """
    global _pg_env_synced
    if _pg_env_synced:
        return

    db_url = os.getenv('DATABASE_URL', '')
    if not db_url or 'postgres' not in db_url.split('://', 1)[0]:
        _pg_env_synced = True
        return

    parsed = urlparse(db_url)
    env_map = {
        'POSTGRES_HOST': parsed.hostname or 'localhost',
        'POSTGRES_PORT': str(parsed.port or 5432),
        'POSTGRES_USER': parsed.username or 'postgres',
        'POSTGRES_PASSWORD': parsed.password or '',
        'POSTGRES_DATABASE': parsed.path.lstrip('/') or 'postgres',
    }
    for key, value in env_map.items():
        os.environ.setdefault(key, value)

    os.environ.setdefault('POSTGRES_MAX_CONNECTIONS', '20')
    _pg_env_synced = True


def _resolve_llm_config() -> tuple[str, str, str]:
    """Return (base_url, api_key, model) for the LLM, from env or OWUI defaults."""
    from open_webui import config as owui_config

    base_url = os.getenv('LIGHTRAG_LLM_API_BASE_URL') or owui_config.OPENAI_API_BASE_URL
    api_key = os.getenv('LIGHTRAG_LLM_API_KEY') or owui_config.OPENAI_API_KEY
    model = os.getenv('LIGHTRAG_LLM_MODEL') or 'gpt-4o-mini'
    return base_url, api_key, model


def _resolve_embedding_config() -> tuple[str, str, str, int]:
    """Return (base_url, api_key, model, dim) for embeddings."""
    from open_webui import config as owui_config

    base_url = os.getenv('LIGHTRAG_EMBEDDING_API_BASE_URL') or owui_config.RAG_OPENAI_API_BASE_URL
    api_key = os.getenv('LIGHTRAG_EMBEDDING_API_KEY') or owui_config.RAG_OPENAI_API_KEY
    model = os.getenv('LIGHTRAG_EMBEDDING_MODEL') or 'text-embedding-3-small'
    dim = int(os.getenv('LIGHTRAG_EMBEDDING_DIM', '1536'))
    return base_url, api_key, model, dim


def _build_llm_model_func(base_url: str, api_key: str, model: str):
    """Wrap LightRAG's openai_complete_if_cache as an llm_model_func.

    LightRAG calls ``llm_model_func(prompt, system_prompt=..., history_messages=..., **kwargs)``
    and expects a string response.  ``openai_complete_if_cache`` already has
    that signature, so we partially-apply the connection config.
    """

    async def _llm_func(prompt: str, system_prompt: Optional[str] = None, **kwargs: Any) -> str:
        return await openai_complete_if_cache(
            model,
            prompt,
            system_prompt=system_prompt,
            base_url=base_url,
            api_key=api_key,
            **kwargs,
        )

    return _llm_func


def _build_embedding_func(base_url: str, api_key: str, model: str, dim: int) -> EmbeddingFunc:
    """Build an EmbeddingFunc bound to OWUI's embedding endpoint."""
    return EmbeddingFunc(
        embedding_dim=dim,
        max_token_size=int(os.getenv('LIGHTRAG_EMBEDDING_MAX_TOKENS', '8192')),
        func=lambda texts: openai_embed(
            texts,
            model=model,
            base_url=base_url,
            api_key=api_key,
        ),
    )


async def get_lightrag(
    workspace: str = 'default',
    llm_model: Optional[str] = None,
    embedding_model: Optional[str] = None,
) -> LightRAG:
    """Return (lazily creating) the singleton LightRAG instance.

    The first call initializes the Postgres storage backends and opens the
    asyncpg connection pool.  Subsequent calls reuse the singleton unless
    ``workspace`` differs, in which case a new scoped instance is built.
    """
    global _rag

    if _rag is not None and getattr(_rag, 'workspace', '') == workspace:
        return _rag

    _sync_postgres_env()

    llm_base, llm_key, llm_default = _resolve_llm_config()
    emb_base, emb_key, emb_default, emb_dim = _resolve_embedding_config()

    llm_model = llm_model or llm_default
    embedding_model = embedding_model or emb_default

    llm_func = _build_llm_model_func(llm_base, llm_key, llm_model)
    embedding_func = _build_embedding_func(emb_base, emb_key, embedding_model, emb_dim)

    working_dir = os.getenv('LIGHTRAG_WORKING_DIR', './data/lightrag')
    os.makedirs(working_dir, exist_ok=True)

    rag = LightRAG(
        working_dir=working_dir,
        workspace=workspace,
        llm_model_func=llm_func,
        llm_model_name=llm_model,
        embedding_func=embedding_func,
        kv_storage='PGKVStorage',
        vector_storage='PGVectorStorage',
        graph_storage='NetworkXStorage',
        doc_status_storage='PGDocStatusStorage',
    )

    await rag.initialize_storages()
    _rag = rag
    log.info('LightRAG initialized (workspace=%s, llm=%s, embed=%s)', workspace, llm_model, embedding_model)
    return _rag


async def query(
    query_text: str,
    mode: str = 'hybrid',
    workspace: str = 'default',
    top_k: Optional[int] = None,
) -> str:
    """Run a LightRAG query and return the generated answer."""
    rag = await get_lightrag(workspace=workspace)
    param = QueryParam(mode=mode)
    if top_k is not None:
        param.top_k = top_k
    return await rag.aquery(query_text, param=param)


async def insert(text: str, workspace: str = 'default') -> None:
    """Insert a text document into the LightRAG graph for a workspace."""
    rag = await get_lightrag(workspace=workspace)
    await rag.ainsert(text)


async def get_graph_data(workspace: str = 'default') -> dict[str, Any]:
    """Return nodes and edges for the workspace's knowledge graph.

    Uses LightRAG's NetworkX graph storage.  Nodes carry entity metadata;
    edges carry relation descriptions.  Shapes are JSON-serialisable for the
    frontend graph client.
    """
    rag = await get_lightrag(workspace=workspace)
    graph = rag.chunk_entity_relation_graph
    nx_graph = getattr(graph, '_graph', None)
    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []

    if nx_graph is not None:
        for node_id, node_data in nx_graph.nodes(data=True):
            nodes.append({'id': node_id, **(node_data or {})})
        for src, tgt, edge_data in nx_graph.edges(data=True):
            edges.append({'source': src, 'target': tgt, **(edge_data or {})})

    return {'nodes': nodes, 'edges': edges}