/**
 * OWUI LightRAG client — exposes LightRAG query / graph-traversal functions
 * via OWUI's `/api/v1/graph/` router (which proxies to the in-process
 * LightRAG singleton).  Adapted from KG's `lightrag-client.ts` but replaces
 * direct LightRAG HTTP calls (port 9621) and KG proxy paths (`/api/kg`,
 * `/api/lightrag`) with OWUI graph endpoints.  Auth uses
 * `authorization: Bearer <token>` from `localStorage`.
 */

import { WEBUI_API_BASE_URL } from '$lib/constants';
import type {
  KGGraph,
  KGNode,
  KgEntity,
  KgRelationship,
  QueryRequest
} from '../constants';

const GRAPH_BASE = `${WEBUI_API_BASE_URL}/graph`;

function getToken(): string {
  if (typeof localStorage !== 'undefined') {
    return localStorage.getItem('token') ?? '';
  }
  return '';
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${getToken()}`,
    ...extra,
  };
}

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...options,
    headers: {
      ...authHeaders(),
      Accept: 'application/json',
      ...(options.headers as Record<string, string> | undefined)
    }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Graph LightRAG ${res.status} ${res.statusText}: ${body}`);
  }
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

export async function health(): Promise<{ status: string }> {
  return request<{ status: string }>(`${GRAPH_BASE}/health`);
}

export async function query(params: QueryRequest): Promise<{ response: string }> {
  return request<{ response: string }>(`${GRAPH_BASE}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...params, stream: false })
  });
}

export async function* queryStream(params: QueryRequest): AsyncGenerator<string> {
  const res = await fetch(`${GRAPH_BASE}/query`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...params, stream: true })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Graph LightRAG ${res.status} ${res.statusText}: ${body}`);
  }
  const reader = res.body?.getReader();
  if (!reader) throw new Error('No response body');
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':')) continue;
      if (trimmed.startsWith('data:')) {
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') return;
        try {
          const parsed = JSON.parse(data);
          const text = parsed.content ?? parsed.text ?? parsed.delta ?? data;
          if (text) yield text;
        } catch {
          if (data) yield data;
        }
      } else {
        try {
          const parsed = JSON.parse(trimmed);
          const text = parsed.content ?? parsed.text ?? parsed.delta ?? '';
          if (text) yield text;
        } catch {
          if (trimmed) yield trimmed;
        }
      }
    }
  }
  if (buffer.trim()) {
    const trimmed = buffer.trim();
    if (trimmed.startsWith('data:')) {
      const data = trimmed.slice(5).trim();
      if (data !== '[DONE]') yield data;
    } else if (trimmed !== '[DONE]') {
      yield trimmed;
    }
  }
}

export async function getGraphData(
  label?: string,
  nodeId?: string,
  depth?: number
): Promise<KGGraph> {
  const params = new URLSearchParams();
  if (label) params.set('label', label);
  if (nodeId) params.set('node_id', nodeId);
  if (depth !== undefined) params.set('max_depth', String(depth));
  const qs = params.toString();
  const url = qs ? `${GRAPH_BASE}/?${qs}` : `${GRAPH_BASE}/`;
  const raw = await request<{ nodes: KGNode[]; edges: Array<{ source: string; target: string; type?: string; id?: string; properties?: Record<string, unknown> }> }>(url);
  const edges = (raw.edges ?? []).map((e, i) => ({
    id: e.id ?? `${e.source}-${e.type ?? 'RELATED'}-${e.target}-${i}`,
    source: e.source,
    target: e.target,
    type: e.type ?? 'RELATED',
    properties: e.properties ?? {}
  }));
  return { nodes: raw.nodes ?? [], edges };
}

export async function getEntities(
  type?: string,
  limit?: number
): Promise<KgEntity[]> {
  const params = new URLSearchParams();
  if (type) params.set('type', type);
  if (limit !== undefined) params.set('limit', String(limit));
  const qs = params.toString();
  const url = qs ? `${GRAPH_BASE}/entities?${qs}` : `${GRAPH_BASE}/entities`;
  return request<KgEntity[]>(url);
}

export async function getEntity(entityId: string): Promise<KgEntity | null> {
  return request<KgEntity | null>(`${GRAPH_BASE}/entity/${encodeURIComponent(entityId)}`);
}

export async function getRelationships(
  entityId?: string,
  limit?: number
): Promise<KgRelationship[]> {
  const params = new URLSearchParams();
  if (entityId) params.set('entity_id', entityId);
  if (limit !== undefined) params.set('limit', String(limit));
  const qs = params.toString();
  const url = qs
    ? `${GRAPH_BASE}/relationships?${qs}`
    : `${GRAPH_BASE}/relationships`;
  return request<KgRelationship[]>(url);
}

export async function getLabels(): Promise<string[]> {
  return request<string[]>(`${GRAPH_BASE}/labels`);
}

export async function getEntityTypes(): Promise<string[]> {
  return request<string[]>(`${GRAPH_BASE}/entity-types`);
}

export async function createEntity(
  name: string,
  type: string,
  properties?: Record<string, unknown>
): Promise<unknown> {
  return request<unknown>(`${GRAPH_BASE}/entities`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, type, properties: properties ?? {} })
  });
}

export async function createRelation(
  source: string,
  target: string,
  relation: string,
  properties?: Record<string, unknown>
): Promise<unknown> {
  return request<unknown>(`${GRAPH_BASE}/relationships`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, target, relation, properties: properties ?? {} })
  });
}

export async function mergeEntities(source: string, target: string): Promise<unknown> {
  return request<unknown>(`${GRAPH_BASE}/entities/merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, target })
  });
}

class LightragClient {
  health = health;
  query = query;
  queryStream = queryStream;
  getGraph = getGraphData;
  getGraphData = getGraphData;
  getEntities = getEntities;
  getEntity = getEntity;
  getRelationships = getRelationships;
  getLabels = getLabels;
  getEntityTypes = getEntityTypes;
  createEntity = createEntity;
  createRelation = createRelation;
  mergeEntities = mergeEntities;
}

export const lightragClient = new LightragClient();