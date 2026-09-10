/**
 * In-place library source/asset types. Time is depth: takenAt → properties.taken_at (Z), never x/y.
 */
import type { KGNode } from './constants';

export interface GraphSource {
  id: string;
  name: string;
  lastAbsPath: string;
  fingerprint: string;
  online: boolean;
  scanning?: boolean;
  assetCount?: number;
}

export interface GraphAsset {
  id: string;
  sourceId: string;
  relPath: string;
  kind: string;
  takenAt: number;
  title: string;
}

export interface GraphBrowseEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export interface GraphSearchHit {
  id: string;
  title: string;
  kind: string;
}

export interface GraphCanvas {
  sources: GraphSource[];
  assets: GraphAsset[];
  conversations: KGNode[];
}

function kindLabel(kind: string): string {
  if (!kind) return 'Asset';
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

export function assetToKgNode(
  asset: GraphAsset,
  source?: Pick<GraphSource, 'online'> | null
): KGNode {
  const label = kindLabel(asset.kind);
  return {
    id: `asset:${asset.id}`,
    labels: [label],
    properties: {
      entity_type: label,
      title: asset.title,
      taken_at: asset.takenAt,
      source_id: asset.sourceId,
      rel_path: asset.relPath,
      kind: asset.kind,
      online: source?.online ?? true
    }
  };
}

type Raw = Record<string, unknown>;

export function isTrashSource(source: Pick<GraphSource, 'name' | 'lastAbsPath'>): boolean {
  if (/trash/i.test(source.name)) return true;
  return /(?:^|\/)\.?trash\/?$/i.test(source.lastAbsPath.replace(/\\/g, '/'));
}

export function toGraphSource(raw: Raw | GraphSource | null | undefined): GraphSource {
  const r = (raw ?? {}) as Raw;
  return {
    id: String(r.id ?? ''),
    name: String(r.name ?? ''),
    lastAbsPath: String(r.lastAbsPath ?? r.last_abs_path ?? ''),
    fingerprint: String(r.fingerprint ?? ''),
    online: Boolean(r.online),
    scanning: Boolean(r.scanning),
    assetCount: Number.isFinite(Number(r.assetCount ?? r.asset_count))
      ? Number(r.assetCount ?? r.asset_count)
      : undefined
  };
}

export function toGraphAsset(raw: Raw | GraphAsset | null | undefined): GraphAsset {
  const r = (raw ?? {}) as Raw;
  return {
    id: String(r.id ?? ''),
    sourceId: String(r.sourceId ?? r.source_id ?? ''),
    relPath: String(r.relPath ?? r.rel_path ?? ''),
    kind: String(r.kind ?? ''),
    takenAt: Number(r.takenAt ?? r.taken_at ?? 0),
    title: String(r.title ?? '')
  };
}

export function toGraphBrowseEntry(raw: Raw | GraphBrowseEntry | null | undefined): GraphBrowseEntry {
  const r = (raw ?? {}) as Raw;
  return {
    name: String(r.name ?? ''),
    path: String(r.path ?? r.abs_path ?? ''),
    isDir: Boolean(r.isDir ?? r.is_dir)
  };
}

export function toGraphSearchHit(raw: Raw | GraphSearchHit | null | undefined): GraphSearchHit {
  const r = (raw ?? {}) as Raw;
  return {
    id: String(r.id ?? ''),
    title: String(r.title ?? ''),
    kind: String(r.kind ?? '')
  };
}
