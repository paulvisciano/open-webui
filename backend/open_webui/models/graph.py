"""Graph / LightRAG storage models.

LightRAG manages its own Postgres tables (LIGHTRAG_DOC_FULL, LIGHTRAG_DOC_CHUNKS,
LIGHTRAG_VECTOR_*, etc.) via its asyncpg connection pool and auto-creates them
on first use — see ``lightrag/kg/postgres_impl.py``.  Those tables live in the
same database as OWUI but are owned by LightRAG, so OWUI's SQLAlchemy metadata
must NOT declare them (otherwise Alembic would try to migrate/drop them).

This module instead owns the *OWUI-side* metadata that wraps LightRAG:
``Graph`` — one row per LightRAG workspace/collection, with access control,
owner, and display metadata.  It also exposes ``ensure_lightrag_schema()``
which creates the ``lightrag`` Postgres schema namespace (a no-op when it
already exists) so LightRAG's tables are isolated from OWUI's.

Keeping this separate from LightRAG's own schema means:
  * Alembic only manages OWUI tables (``graph``, not ``LIGHTRAG_*``).
  * LightRAG's asyncpg pool reads/writes its tables without SQLAlchemy.
  * The graph router can join ``graph`` (owner/ACL) to LightRAG graph data.
"""

from __future__ import annotations

import logging
import time
import uuid
from typing import Optional

from open_webui.internal.db import Base, get_async_db_context
from pydantic import BaseModel, ConfigDict
from sqlalchemy import (
    BigInteger,
    Column,
    Index,
    Text,
    delete,
    func,
    select,
    text,
    update,
)
from sqlalchemy.ext.asyncio import AsyncSession

log = logging.getLogger(__name__)


class Graph(Base):
    __tablename__ = 'graph'

    id = Column(Text, primary_key=True, unique=True)
    user_id = Column(Text, nullable=False)

    name = Column(Text, nullable=False)
    workspace = Column(Text, nullable=False, default='')
    description = Column(Text, nullable=True)

    meta = Column(Text, nullable=True)

    created_at = Column(BigInteger, nullable=False)
    updated_at = Column(BigInteger, nullable=False)

    __table_args__ = (
        Index('ix_graph_user_id', 'user_id'),
        Index('ix_graph_workspace', 'workspace', unique=True),
    )


class GraphModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    user_id: str

    name: str
    workspace: str = ''
    description: Optional[str] = None

    meta: Optional[str] = None

    created_at: int
    updated_at: int


class GraphForm(BaseModel):
    name: str
    workspace: Optional[str] = None
    description: Optional[str] = None
    meta: Optional[str] = None


class GraphUserResponse(GraphModel):
    user: Optional[dict] = None


class Graphs:
    @staticmethod
    def insert_graph(form: GraphForm, user_id: str) -> Optional[GraphModel]:
        with get_async_db_context() as db:
            graph = Graph(
                id=str(uuid.uuid4()),
                user_id=user_id,
                name=form.name,
                workspace=form.workspace or str(uuid.uuid4()),
                description=form.description,
                meta=form.meta,
                created_at=int(time.time()),
                updated_at=int(time.time()),
            )
            db.add(graph)
            db.commit()
            db.refresh(graph)
            return GraphModel.model_validate(graph)

    @staticmethod
    def get_graphs_by_user_id(user_id: str) -> list[GraphModel]:
        with get_async_db_context() as db:
            rows = db.execute(
                select(Graph).where(Graph.user_id == user_id).order_by(Graph.updated_at.desc())
            )
            return [GraphModel.model_validate(r) for r in rows.scalars().all()]

    @staticmethod
    def get_graph_by_id(graph_id: str) -> Optional[GraphModel]:
        with get_async_db_context() as db:
            graph = db.get(Graph, graph_id)
            return GraphModel.model_validate(graph) if graph else None

    @staticmethod
    def update_graph_by_id(graph_id: str, form: GraphForm) -> Optional[GraphModel]:
        with get_async_db_context() as db:
            db.execute(
                update(Graph)
                .where(Graph.id == graph_id)
                .values(
                    name=form.name,
                    description=form.description,
                    meta=form.meta,
                    updated_at=int(time.time()),
                )
            )
            db.commit()
            graph = db.get(Graph, graph_id)
            return GraphModel.model_validate(graph) if graph else None

    @staticmethod
    def delete_graph_by_id(graph_id: str) -> bool:
        with get_async_db_context() as db:
            res = db.execute(delete(Graph).where(Graph.id == graph_id))
            db.commit()
            return res.rowcount > 0


async def ensure_lightrag_schema(db: AsyncSession) -> None:
    """Create the ``lightrag`` Postgres schema namespace if absent.

    LightRAG's asyncpg pool creates its tables in the public schema by
    default; when ``DATABASE_SCHEMA`` is set (e.g. for multi-tenant
    deployments) the tables land in that schema.  This helper is a defensive
    no-op guard for the common single-schema case and is safe to call at
    startup.  It must run on a SQLAlchemy connection (psycopg), not asyncpg.
    """
    await db.execute(text('CREATE SCHEMA IF NOT EXISTS lightrag'))
    await db.commit()