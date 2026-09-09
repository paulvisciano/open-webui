/** Search hits use bare asset uuids; canvas nodes use `asset:{uuid}`. */
import type { KGNode } from './constants';

export function addSearchId(ids: Set<string>, id: string): void {
  if (!id) return;
  ids.add(id);
  if (id.startsWith('asset:')) ids.add(id.slice(6));
  else ids.add(`asset:${id}`);
}

export function isSearchMatch(ids: Set<string> | null, id: string): boolean {
  if (!ids || !id) return false;
  if (ids.has(id)) return true;
  if (id.startsWith('asset:')) return ids.has(id.slice(6));
  return ids.has(`asset:${id}`);
}

function field(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
}

export function nodeMatchesQuery(node: KGNode, q: string): boolean {
  if (!q) return false;
  const p = node.properties ?? {};
  const title = field(p.title ?? p.name).toLowerCase();
  const kind = field(p.kind ?? p.entity_type).toLowerCase();
  if (title.includes(q) || kind.includes(q)) return true;
  for (const label of node.labels ?? []) {
    const l = field(label)
      .toLowerCase()
      .replace(/\s*\(conversation\)$/, '');
    if (l && l !== 'conversation' && l.includes(q)) return true;
  }
  return false;
}

export function collectSearchMatchIds(
  hits: ReadonlyArray<{ id: string }>,
  nodes: ReadonlyArray<KGNode>,
  query: string
): Set<string> {
  const ids = new Set<string>();
  for (const hit of hits) addSearchId(ids, hit.id);
  const q = query.trim().toLowerCase();
  if (!q) return ids;
  for (const node of nodes) {
    if (nodeMatchesQuery(node, q)) addSearchId(ids, node.id);
  }
  return ids;
}
