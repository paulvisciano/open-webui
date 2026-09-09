/**
 * Layout.ts — pure, deterministic graph → canvas-cell mapping.
 *
 * Turns `KGNode[]` + `KGEdge[]` into `CanvasNode[]` by assigning each node a
 * stable chunk-cell coordinate `(cellX, cellY, cellZ)` and a within-chunk
 * offset `(localX, localY, localZ)`. The strategy is a **time-depth layout**:
 * photos are spread along the camera's depth axis (Z) by date taken, so the
 * user zooms in to travel back through time instead of panning sideways.
 *
 *   cellZ = time bucket  (primary axis — newest at z=0, older at -1,-2,… so
 *           zooming in (camera z decreasing) reveals progressively older
 *           photos). Conversations and the library walls share this axis.
 *   cellY = 0 (corridor centered on camera Y; wall rows live in localY)
 *   cellX = conversations helix in the aisle (|X| < 90; cellX = 0 or
 *           −1 when localX would be negative). Library assets
 *           (`photo|document|video|audio`) split even/odd onto left and right
 *           corridor walls (cellX=-2 / +1), yawed inward, so looking along Z
 *           is a photo tunnel with chats floating in the middle.
 *
 * No Three.js / DOM access here — this module is pure data and must be
 * deterministic: two calls with the same input produce identical coords.
 *
 * Ported faithfully from Knowledge Graph `ui/src/lib/components/canvas/Layout.ts`.
 * Only the import paths were adjusted to Open WebUI's directory layout;
 * the algorithm, exports, and behavior are identical.
 */

import type { KGNode, KGEdge } from '../constants';
import type { BuildCtx, CanvasNode, NodeKind } from './types';
import { CHUNK_SIZE, TIME_BUCKET_SPACING } from './constants';
// Side-effect import: registers all providers (note/docChunk/photo/person/
// location/event/conversation) in registration order. MUST come before any
// use of `classifyKind`/`getProvider` so the registry is populated.
import './providers';
import { classifyKind as classifyKindRegistry, getProvider } from './NodeKindProvider';

// ---------------------------------------------------------------------------
// Kind classification
// ---------------------------------------------------------------------------

/**
 * Recognize a note `file_source` / `source_id` string, mirroring the backend
 * predicate. A string is a note file_source if it:
 *   - matches `^note_\d+$` (legacy), OR
 *   - starts with one of: `diary-entry`, `chat-note`, `preference-update`,
 *     `correction`, `plan_entry`, `daily_update`, `personal_context_update`,
 *     `mcp-`, OR
 *   - ends with the MCP timestamp suffix `\d{8}-\d{6}-\d{6}$` AND does not
 *     look like an image.
 *
 * Conservative guard: any string that looks like an image (contains a photo
 * extension or starts with `PXL_`) is treated as a photo, never a note, so
 * real photos are never misrouted to the note renderer.
 */
export function isNoteFileSource(s: string): boolean {
  if (typeof s !== 'string' || s.length === 0) return false;
  // LightRAG concatenates an entity's source documents with "<SEP>" (e.g.
  // "personal_context_update<SEP>PXL_20260504....jpg<SEP>daily_update").
  // Those compound strings are NOT a single note file_source — they belong
  // to extracted entities (person/location/...), not to a Note hub. Reject
  // them so entities don't get misclassified as notes.
  if (s.includes('<SEP>')) return false;
  // Image heuristic — checked first so real photos win even if they happen to
  // match a note prefix or the MCP timestamp suffix.
  if (/(?:\.jpe?g|\.raw|\.png|\.heic)$/i.test(s) || s.startsWith('PXL_')) {
    return false;
  }
  if (/^note_\d+$/.test(s)) return true;
  const notePrefixes = [
    'diary-entry',
    'diary_entry',
    'chat-note',
    'preference-update',
    'correction',
    'plan_entry',
    'daily_update',
    'personal_context_update',
    'mcp-',
  ];
  for (const p of notePrefixes) {
    if (s.startsWith(p)) return true;
  }
  // MCP-generated timestamp suffix without an explicit note prefix.
  if (/\d{8}-\d{6}-\d{6}$/.test(s)) return true;
  return false;
}

/** Recognize a LightRAG document-chunk `source_id`. Chunk IDs look like
 *  `doc-{32 hex}-chunk-{NNN}` (from lightrag/utils_pipeline.py). They are
 *  internal chunk identifiers, NOT image filenames — a spurious (Photo)
 *  hub with a chunk source_id must not route to the photo image path. */
export function isDocChunkFileSource(s: string): boolean {
  if (typeof s !== 'string' || s.length === 0) return false;
  if (s.includes('<SEP>')) return false;
  return /^doc-[a-f0-9]{32}-chunk-\d{3}$/.test(s);
}

/**
 * True if the node represents a Note entity (diary entry, chat note, plan
 * entry, daily update, personal-context update, …). Matches any of:
 *   - `properties.entity_type === 'Note'`, OR
 *   - any label ending with ` (Note)`, OR
 *   - `source_id` / `file_path` / `filename` / `file_source` is a note
 *     file_source (see {@link isNoteFileSource}).
 *
 * This is checked BEFORE `isPhotoNode` in {@link classifyKind} so that a
 * spurious `(Photo)` hub whose `source_id` is actually a note file_source is
 * classified as `note` (not `photo`) and therefore never routed to the photo
 * image URL path that 404s.
 */
export function isNoteNode(node: {
  labels?: string[];
  properties?: Record<string, unknown>;
  id?: string;
}): boolean {
  const et = node.properties?.entity_type;
  if (typeof et === 'string' && et === 'Note') return true;
  if (node.labels?.some((l) => l.endsWith(' (Note)'))) return true;
  // A spurious `(Photo)` hub (created by the orphan-repair script for note
  // file_sources) has `entity_type === 'Photo'` but `source_id` = the note
  // file_source. Reclassify it as a note via `source_id` so it isn't routed
  // to the photo image path. Do NOT check `file_path`/`file_source` here:
  // extracted entities (person/location/concept) carry the note's
  // file_source in `file_path` (the document they were extracted FROM), but
  // they are NOT notes — only the hub is.
  const sid = node.properties?.source_id;
  if (typeof sid === 'string' && isNoteFileSource(sid)) return true;
  return false;
}

/** True if the node represents a Photo/Image entity.
 *
 *  Excludes LightRAG multi-source hubs whose `source_id` joins several
 *  chunks with `<SEP>` (e.g. `doc-X-chunk-000<SEP>doc-Y-chunk-000`). Those
 *  compound IDs are not image filenames, so routing them to the photo image
 *  endpoint 404s. They fall through `classifyKind` to `concept` instead. */
export function isPhotoNode(node: {
  labels?: string[];
  properties?: Record<string, unknown>;
  id?: string;
}): boolean {
  const sourceId = node.properties?.source_id ?? node.properties?.file_path;
  if (typeof sourceId === 'string' && sourceId.includes('<SEP>')) return false;
  return (
    !!node.labels?.some((l) => /^(Photo|Image)$/i.test(l)) ||
    (node.properties?.entity_type as string) === 'Photo' ||
    (node.properties?.entity_type as string) === 'Image' ||
    (node.id ?? '').includes('(Photo)') ||
    (node.id ?? '').includes('(Image)')
  );
}

/** True if a Photo node is a stale placeholder from incomplete processing
 *  (no backing image file). These must be excluded from the layout — their
 *  `created_at` timestamp lands them in the newest time bucket, which centers
 *  the camera on an empty layer with no real photos. */
function isStalePhotoNode(node: {
  properties?: Record<string, unknown>;
}): boolean {
  const sourceId = node.properties?.source_id ?? node.properties?.file_path;
  return !sourceId || sourceId === 'manual_creation';
}

/** True if the node represents a Person entity. */
export function isPersonNode(node: {
  labels?: string[];
  properties?: Record<string, unknown>;
}): boolean {
  const et = node.properties?.entity_type;
  if (typeof et === 'string' && et.toLowerCase() === 'person') return true;
  return !!node.labels?.some((l) => l.toLowerCase() === 'person');
}

/** True if the node represents a Location entity. */
export function isLocationNode(node: {
  labels?: string[];
  properties?: Record<string, unknown>;
}): boolean {
  const et = node.properties?.entity_type;
  if (typeof et === 'string' && et.toLowerCase() === 'location') return true;
  return !!node.labels?.some((l) => /^(Location|Place|GpsPoint)$/i.test(l));
}

/** True if the node represents an Event entity. */
export function isEventNode(node: {
  labels?: string[];
  properties?: Record<string, unknown>;
}): boolean {
  const et = node.properties?.entity_type;
  if (typeof et === 'string' && et.toLowerCase() === 'event') return true;
  return !!node.labels?.some((l) => /^Event$/i.test(l));
}

/** True if the node is an in-place library asset (`asset:{uuid}` or `properties.library`). */
export function isLocalAssetNode(node: {
  id?: string;
  properties?: Record<string, unknown>;
}): boolean {
  if ((node.id ?? '').startsWith('asset:')) return true;
  return node.properties?.library === true;
}

const WALL_CELL_X_LEFT = -2;
const WALL_CELL_X_RIGHT = 1;
const WALL_YAW_LEFT = Math.PI / 2;
const WALL_YAW_RIGHT = -Math.PI / 2;
const WALL_PITCH_Y = 88;
const WALL_PITCH_Z = 260;
const WALL_TILE_W = 64;
const WALL_ROWS = 2;

/** World |X| of aisle helix. Must stay < 140 so cards stay off walls at ±240. */
const CONV_AISLE_X = 90;
const CONV_HELIX_Y = 120;
const CONV_PITCH_Z = 220;
const CONV_GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

const WALL_KINDS = new Set(['photo', 'pdf', 'document', 'video', 'audio']);

/** True if the node belongs on the library wall, not the conversation cluster. */
export function isLibraryWallNode(
  node: { id?: string; properties?: Record<string, unknown> },
  kind: NodeKind,
): boolean {
  if (kind === 'conversation') return false;
  if (isLocalAssetNode(node)) return true;
  return WALL_KINDS.has(kind);
}

/**
 * Kinds that carry their own timestamp and occupy a Z time-bucket.
 * Library assets (`photo|pdf|document|video|audio`) must be assigned even
 * when no plane provider exists yet — only conversation+photo survive
 * `shouldRender` today.
 */
function isTimePlanKind(kind: string): boolean {
  return (
    kind === 'photo' ||
    kind === 'note' ||
    kind === 'conversation' ||
    kind === 'pdf' ||
    kind === 'document' ||
    kind === 'video' ||
    kind === 'audio'
  );
}

/** True if this node should seed the time plan from its own date (`taken_at` / `createdAt`). */
function isTimePlanNode(node: KGNode, kind: NodeKind): boolean {
  if (isTimePlanKind(kind)) return true;
  if (isLocalAssetNode(node)) return true;
  const assetKind = node.properties?.kind;
  return typeof assetKind === 'string' && isTimePlanKind(assetKind);
}

/**
 * Classify a `KGNode` into one of the renderer's visual categories.
 * Delegates to the provider registry (`renderer/NodeKindProvider.ts`),
 * which iterates providers in registration order (note → docChunk → photo →
 * person → location → event), falling back to `'concept'`. The note-first
 * ordering is preserved so a spurious `(Photo)` hub with a note/chunk
 * `source_id` reclassifies before the photo check matches.
 */
export function classifyKind(node: KGNode): NodeKind {
  return classifyKindRegistry(node);
}

// ---------------------------------------------------------------------------
// Small deterministic helpers
// ---------------------------------------------------------------------------

/** Stable 32-bit hash of a string → unsigned int. */
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/** Deterministic [0, 1) PRNG from an integer seed (matches reference seededRandom). */
function seededRandom(seed: number): number {
  const x = Math.sin(seed * 9999) * 10000;
  return x - Math.floor(x);
}

/**
 * Parse a date from any of the known timestamp properties, including
 * library-asset `taken_at` (unix seconds or ms) and conversation `createdAt`.
 * Returns `null` when no usable timestamp is present.
 */
export function parseNodeDate(node: KGNode): Date | null {
  const p = node.properties ?? {};
  const raw =
    p.date_taken_friendly ??
    p.datetime_original ??
    p.date_taken ??
    p.datetime ??
    p.taken_at ??
    p.created_at ??
    p.createdAt ??
    p.timestamp;
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'number') {
    // Unix seconds or ms — heuristic: ms if > 1e12, else seconds.
    const ms = raw > 1e12 ? raw : raw * 1000;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof raw === 'string') {
    const d = parseExifDateString(raw) ?? new Date(raw);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * Parse the two EXIF date string formats produced by the backend:
 *   - "YYYY:MM:DD HH:MM:SS"  (raw EXIF DateTimeOriginal, colons in date)
 *   - "YYYY-MM-DD at HH:MM"  (date_taken_friendly, human form)
 * Both are unparseable by `new Date()`, so normalize before constructing.
 * Returns `null` for any other shape.
 */
function parseExifDateString(raw: string): Date | null {
  const m1 = raw.match(/^(\d{4}):(\d{2}):(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (m1) {
    const [, Y, Mo, D, H, Mi, S] = m1;
    return new Date(`${Y}-${Mo}-${D}T${H}:${Mi}:${S ?? '00'}`);
  }
  const m2 = raw.match(/^(\d{4})-(\d{2})-(\d{2})\s+at\s+(\d{2}):(\d{2})$/);
  if (m2) {
    const [, Y, Mo, D, H, Mi] = m2;
    return new Date(`${Y}-${Mo}-${D}T${H}:${Mi}:00`);
  }
  return null;
}

/** Day bucket key (YYYY-MM-DD). */
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

/** Month bucket key (YYYY-MM). */
function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Cluster band assignment (ported hubMap pattern)
// ---------------------------------------------------------------------------

interface ClusterAssignment {
  /** nodeId → hubId it belongs to. */
  hubOf: Map<string, string>;
  /** hubId → stable band index (0-based). */
  bandOfHub: Map<string, number>;
  /** Set of hub node ids (degree ≥ median). */
  hubSet: Set<string>;
}

/**
 * Compute the hubMap cluster assignment and map each hub to a stable Y band
 * index. Mirrors the original buildDegreeMap: hubs are nodes with
 * degree ≥ median; non-hubs attach to their highest-degree neighbor hub.
 */
function buildClusterAssignment(nodes: KGNode[], edges: KGEdge[]): ClusterAssignment {
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }

  const degValues = Array.from(degree.values()).sort((a, b) => a - b);
  const medianDeg =
    degValues.length > 0 ? degValues[Math.floor(degValues.length / 2)] : 1;

  const hubSet = new Set<string>();
  for (const [id, deg] of degree) {
    if (deg >= medianDeg) hubSet.add(id);
  }
  if (hubSet.size === 0 && degValues.length > 0) {
    // Fall back to the single highest-degree node.
    let bestId = '';
    let bestDeg = -1;
    for (const [id, deg] of degree) {
      if (deg > bestDeg) {
        bestDeg = deg;
        bestId = id;
      }
    }
    if (bestId) hubSet.add(bestId);
  }

  // Adjacency for O(1) neighbor lookup.
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    if (!adjacency.has(e.source)) adjacency.set(e.source, []);
    if (!adjacency.has(e.target)) adjacency.set(e.target, []);
    adjacency.get(e.source)!.push(e.target);
    adjacency.get(e.target)!.push(e.source);
  }

  const hubOf = new Map<string, string>();
  for (const n of nodes) {
    if (hubSet.has(n.id)) {
      hubOf.set(n.id, n.id);
      continue;
    }
    const neighbors = adjacency.get(n.id) ?? [];
    let bestHub: string | null = null;
    let bestDeg = 0;
    for (const nid of neighbors) {
      const d = degree.get(nid) ?? 1;
      if (d > bestDeg) {
        bestDeg = d;
        bestHub = nid;
      }
    }
    hubOf.set(n.id, bestHub ?? n.id);
  }

  // Assign each hub a stable, dense band index (0, 1, 2, …) so clusters form
  // adjacent horizontal bands near the camera's origin chunk. Sort hub ids
  // first so the band ordering is deterministic across runs (independent of
  // Map insertion order). Sparse hashes would scatter clusters thousands of
  // chunks away from chunk (0,0,0), putting them outside RENDER_DISTANCE.
  const bandOfHub = new Map<string, number>();
  const sortedHubs = Array.from(hubSet).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (let i = 0; i < sortedHubs.length; i++) {
    bandOfHub.set(sortedHubs[i], i);
  }

  return { hubOf, bandOfHub, hubSet };
}

// ---------------------------------------------------------------------------
// Time bucketing
// ---------------------------------------------------------------------------

interface TimePlan {
  /** nodeId → cellZ (monotonic bucket index, oldest = 0, newest = highest). */
  cellZOf: Map<string, number>;
  /** Sorted bucket key → human-readable date label (e.g. "2024-06"). */
  bucketLabel: Map<string, string>;
  /** Dense bucket index → bucket key (for date-indicator lookups). */
  indexToBucket: string[];
  /** Bucket key → bucket index (reverse of indexToBucket). */
  bucketIndex: Map<string, number>;
  /** Special day-level bucket keys for today/yesterday, or null if not present. */
  todayKey: string | null;
  yesterdayKey: string | null;
  /** Month key for today's month (YYYY-MM), used for duplicating nodes into parent bucket. */
  todayMonthKey: string;
  yesterdayMonthKey: string;
}

/**
 * Assign each timestamped node a time-bucket index along cellZ, oldest→newest
 * ascending. Newest land at the highest cellZ (closest to the camera at +Z);
 * older at lower cellZ. Zooming in (camera z decreasing) travels toward older
 * nodes. Library assets use `properties.taken_at` (unix seconds or ms).
 * Non-timestamped nodes inherit the bucket of their most-recent connected
 * timestamped node. Nodes with no date connection fall back to ingestion order.
 *
 * Buckets are days by default; if the date span exceeds ~180 days we
 * switch to month buckets so the Z axis stays bounded.
 */
function buildTimePlan(nodes: KGNode[], edges: KGEdge[]): TimePlan {
  // Dates for nodes that carry their own timestamp — photos, notes,
  // conversations, and library assets (photo|pdf|document|video|audio).
  // `parseNodeDate` reads `taken_at` the same way conversations use
  // `createdAt`, so a month containing only assets still produces its own
  // Z bucket. The map is keyed by nodeId so the granularity decision and
  // bucket-key collection cover conversations + assets together.
  const renderableDate = new Map<string, Date>();
  for (const n of nodes) {
    const kind = classifyKind(n);
    if (!isTimePlanNode(n, kind)) continue;
    if (kind === 'photo' && isStalePhotoNode(n)) continue;
    const d = parseNodeDate(n);
    if (d) renderableDate.set(n.id, d);
  }

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const todayKey = 'today';
  const yesterdayKey = 'yesterday';
  const todayMonthKey = monthKey(today);
  const yesterdayMonthKey = monthKey(yesterday);
  const prevMonthKey = monthKey(new Date(today.getFullYear(), today.getMonth() - 1, 1));

  const granularity: 'month' | 'day' | 'photo' = 'month';

  const bucketKeyOf = (d: Date): string => {
    if (d.getFullYear() === today.getFullYear()
      && d.getMonth() === today.getMonth()
      && d.getDate() === today.getDate()) return todayKey;
    if (d.getFullYear() === yesterday.getFullYear()
      && d.getMonth() === yesterday.getMonth()
      && d.getDate() === yesterday.getDate()) return yesterdayKey;
    if (granularity === 'month') return monthKey(d);
    if (granularity === 'day') return dayKey(d);
    return d.getTime().toString();
  };

  const bucketKeys = new Set<string>();
  for (const d of renderableDate.values()) {
    bucketKeys.add(bucketKeyOf(d));
  }
  const sortedBuckets = Array.from(bucketKeys).sort((a, b) => {
    const sa = a === todayKey ? todayMonthKey + '~1' : a === yesterdayKey ? yesterdayMonthKey + '~0' : a;
    const sb = b === todayKey ? todayMonthKey + '~1' : b === yesterdayKey ? yesterdayMonthKey + '~0' : b;
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });
  const bucketIndex = new Map<string, number>();
  const indexToBucket: string[] = [];
  const bucketLabel = new Map<string, string>();
  for (let i = 0; i < sortedBuckets.length; i++) {
    bucketIndex.set(sortedBuckets[i], i);
    indexToBucket.push(sortedBuckets[i]);
    if (sortedBuckets[i] === todayKey) {
      bucketLabel.set(sortedBuckets[i], 'Today');
    } else if (sortedBuckets[i] === yesterdayKey) {
      bucketLabel.set(sortedBuckets[i], 'Yesterday');
    } else if (sortedBuckets[i] === todayMonthKey) {
      bucketLabel.set(sortedBuckets[i], 'This Month');
    } else if (sortedBuckets[i] === prevMonthKey) {
      bucketLabel.set(sortedBuckets[i], 'Last Month');
    } else {
      bucketLabel.set(sortedBuckets[i], sortedBuckets[i]);
    }
  }

  // Build adjacency (nodeId → neighbor nodeIds) for photo-inheritance.
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    if (!adjacency.has(e.source)) adjacency.set(e.source, []);
    if (!adjacency.has(e.target)) adjacency.set(e.target, []);
    adjacency.get(e.source)!.push(e.target);
    adjacency.get(e.target)!.push(e.source);
  }

  const cellZOf = new Map<string, number>();

  // Timestamped nodes with their own date (photos, notes, conversations,
  // library assets): direct bucket assignment. A month containing only
  // assets/chats still clusters them on Z instead of a far-away fallback
  // cellZ (which would pull the camera away from the photos).
  for (const n of nodes) {
    const kind = classifyKind(n);
    if (!isTimePlanNode(n, kind)) continue;
    if (kind === 'photo' && isStalePhotoNode(n)) continue;
    const d = renderableDate.get(n.id);
    if (!d) continue;
    const key = bucketKeyOf(d);
    const idx = bucketIndex.get(key);
    if (idx !== undefined) cellZOf.set(n.id, idx * TIME_BUCKET_SPACING);
  }

  // Non-timestamped entities (person/location/event/concept): inherit the
  // most-recent connected timestamped node's bucket so they sit alongside
  // the photos/notes/conversations/assets they relate to.
  for (const n of nodes) {
    const kind = classifyKind(n);
    if (isTimePlanNode(n, kind)) continue;
    if (cellZOf.has(n.id)) continue;
    const neighbors = adjacency.get(n.id) ?? [];
    let best: { idx: number; t: number } | null = null;
    for (const nid of neighbors) {
      const d = renderableDate.get(nid);
      if (!d) continue;
      const key = bucketKeyOf(d);
      const idx = bucketIndex.get(key);
      if (idx === undefined) continue;
      const t = d.getTime();
      if (!best || t > best.t) best = { idx, t };
    }
    if (best) cellZOf.set(n.id, best.idx * TIME_BUCKET_SPACING);
  }

  // Fallback: ingestion order, appended after the time buckets.
  const baseCount = sortedBuckets.length;
  let fallbackIdx = baseCount;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (cellZOf.has(n.id)) continue;
    cellZOf.set(n.id, fallbackIdx * TIME_BUCKET_SPACING);
    fallbackIdx++;
  }

  return {
    cellZOf,
    bucketLabel,
    indexToBucket,
    bucketIndex,
    todayKey: bucketKeys.has(todayKey) ? todayKey : null,
    yesterdayKey: bucketKeys.has(yesterdayKey) ? yesterdayKey : null,
    todayMonthKey,
    yesterdayMonthKey,
  };
}

// ---------------------------------------------------------------------------
// Relationship-depth plan (cellZ — focus parallax)
// ---------------------------------------------------------------------------

interface DepthPlan {
  /** nodeId → depth bucket (0 = in-focus, 1 = 1 hop out, 2 = far). */
  depthOf: Map<string, number>;
}

/**
 * Assign each node a relationship-depth bucket relative to `selectedNodeId`,
 * used for the cellX (minor horizontal parallax) axis.
 *
 *  - depth 0: the focused node itself + its 1-hop neighbors.
 *  - depth 1: 2-hop neighbors (shifted one X-layer for parallax).
 *  - depth 2: everything else.
 *
 * When `selectedNodeId` is null/undefined or not in the graph, every node
 * gets depth 0 so the whole graph sits on one X plane.
 */
function buildDepthPlan(
  nodes: KGNode[],
  edges: KGEdge[],
  selectedNodeId?: string | null,
): DepthPlan {
  const depthOf = new Map<string, number>();

  if (!selectedNodeId) {
    for (const n of nodes) depthOf.set(n.id, 0);
    return { depthOf };
  }

  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    if (!adjacency.has(e.source)) adjacency.set(e.source, []);
    if (!adjacency.has(e.target)) adjacency.set(e.target, []);
    adjacency.get(e.source)!.push(e.target);
    adjacency.get(e.target)!.push(e.source);
  }

  const oneHop = new Set<string>(adjacency.get(selectedNodeId) ?? []);
  oneHop.add(selectedNodeId);

  const twoHop = new Set<string>();
  for (const id of oneHop) {
    for (const nbr of adjacency.get(id) ?? []) {
      if (!oneHop.has(nbr)) twoHop.add(nbr);
    }
  }

  for (const n of nodes) {
    if (oneHop.has(n.id)) depthOf.set(n.id, 0);
    else if (twoHop.has(n.id)) depthOf.set(n.id, 1);
    else depthOf.set(n.id, 2);
  }
  return { depthOf };
}

// ---------------------------------------------------------------------------
// Image URL resolution
// ---------------------------------------------------------------------------

/** Pick the source filename for a photo node, if any. */
function photoFilename(node: KGNode): string | null {
  const p = node.properties ?? {};
  const f =
    (p.source_id as string | undefined) ??
    (p.file_path as string | undefined) ??
    (p.filename as string | undefined) ??
    (p.file_source as string | undefined);
  if (typeof f === 'string' && f.length > 0) return f;
  return null;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface TimeIndex {
  /** Dense bucket index → human-readable date label. */
  readonly indexToLabel: readonly string[];
  /** Dense bucket index → raw bucket key (e.g. "2026-07", "today", "yesterday"). */
  readonly indexToBucket: readonly string[];
}

/**
 * Build a time-only index for the date indicator overlay. Returns the same
 * bucket ordering as `buildCanvasLayout` without the cost of computing
 * clusters/depth. Index 0 is the newest bucket.
 */
export function buildTimeIndex(nodes: KGNode[], edges: KGEdge[]): TimeIndex {
  const plan = buildTimePlan(nodes, edges);
  return {
    indexToLabel: plan.indexToBucket.map((k) => plan.bucketLabel.get(k) ?? k),
    indexToBucket: plan.indexToBucket,
  };
}

/**
 * Build the full canvas layout — a `CanvasNode[]` ready to hand to
 * `SceneManager.setNodes`.
 *
 * Layout axes — **time-depth layout** (zoom = time travel):
 *
 *  - cellZ = time bucket index (newest = 0, older = 1, 2, …). The camera
 *    starts facing the newest photos; zooming in (decreasing camera z) moves
 *    toward older photos. This is the primary browsing axis.
 *  - cellY = 0 (corridor is centered on the camera's Y). Wall rows are
 *    packed in localY, not extra Y cells.
 *  - cellX = conversations helix in the aisle (|X| < 90; cellX = 0 or
 *    −1). Library walls: even index → left (`WALL_CELL_X_LEFT`, yaw=+π/2),
 *    odd → right (`WALL_CELL_X_RIGHT`, yaw=-π/2). Dense YZ grid on each wall,
 *    no scatter. Time stays on Z — the corridor recedes with the chats.
 *
 * Conversations pack in a depth helix down the aisle. Wall tiles
 * sit coplanar on each wall so they read as perspective photo walls. Only
 * `photo`/`image` and `conversation` nodes are rendered to the canvas; other
 * entities (person/location/event/concept) still participate in the
 * time plan (via their edges) but do not get planes.
 *
 * @param nodes        all `KGNode`s in the graph (used for clustering + depth).
 * @param edges        all `KGEdge`s in the graph.
 * @param photoImages  `nodeId → thumbnail URL` for photo nodes.
 * @param personImages `nodeId → face-crop URL` for person nodes (reserved for
 *                     later phases; person nodes are not rendered on the canvas).
 * @param selectedNodeId unused (kept for call-site compatibility).
 * @param sourceOnline `sourceId → mounted/online`. Defaults to `{}` so
 *                     conversation+photo layout is unchanged with no sources.
 */
export function buildCanvasLayout(
  nodes: KGNode[],
  edges: KGEdge[],
  photoImages: Record<string, string>,
  _personImages: Record<string, string>,
  _selectedNodeId?: string | null,
  sourceOnline: Record<string, boolean> = {},
): CanvasNode[] {
  const ctx: BuildCtx = { photoImages, sourceOnline };
  const timePlan = buildTimePlan(nodes, edges);

  // Group renderable nodes (photos and conversations) by their time
  // bucket (cellZ) so we can spread each layer across the screen. Without
  // this, all nodes in a bucket share cellX=0 (when nothing is focused) and
  // collapse into a narrow column. Conversations share the photo timeline
  // (`createdAt` / library `taken_at` are read by `parseNodeDate`).
  // Renderability is delegated to each provider's `shouldRender` — e.g. the
  // photo provider hides stale `manual_creation` photos. pdf/document/video/
  // audio still receive cellZ in the time plan for later providers.
  const photosByBucket = new Map<number, KGNode[]>();
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const kind = classifyKind(node);
    const provider = getProvider(kind);
    if (!provider || !provider.shouldRender(node, ctx)) continue;
    const z = timePlan.cellZOf.get(node.id) ?? i;
    const arr = photosByBucket.get(z);
    if (arr) arr.push(node);
    else photosByBucket.set(z, [node]);
  }
  // Conversations join the parent month cluster; wall tiles do not (avoids double meshes).
  for (const [key, bucketIdx] of timePlan.bucketIndex) {
    if (key !== 'today' && key !== 'yesterday') continue;
    const dayNodes = photosByBucket.get(bucketIdx * TIME_BUCKET_SPACING);
    if (!dayNodes) continue;
    const mk = key === 'today' ? timePlan.todayMonthKey : timePlan.yesterdayMonthKey;
    const monthBucketIdx = timePlan.bucketIndex.get(mk);
    if (monthBucketIdx === undefined) continue;
    const extra = dayNodes.filter((n) => !isLibraryWallNode(n, classifyKind(n)));
    if (extra.length === 0) continue;
    const monthZ = monthBucketIdx * TIME_BUCKET_SPACING;
    const monthArr = photosByBucket.get(monthZ);
    if (monthArr) monthArr.push(...extra);
    else photosByBucket.set(monthZ, [...extra]);
  }
  // Photos and conversations pack onto left/right walls by time.
  // gridPosOf stores (col along Z, row along Y).
  // Nodes can appear in multiple buckets, so keys include cellZ.
  const gridPosOf = new Map<string, { x: number; y: number; worldZ: number }>();
  const wallMetaOf = new Map<string, { cols: number; rows: number }>();
  const wallSideOf = new Map<string, 'L' | 'R'>();
  const convPosOf = new Map<string, { x: number; y: number; worldZ: number }>();

  const wallNodes: KGNode[] = [];
  const convNodes: KGNode[] = [];
  const seenPack = new Set<string>();
  for (const bucketNodes of photosByBucket.values()) {
    for (const n of bucketNodes) {
      if (seenPack.has(n.id)) continue;
      seenPack.add(n.id);
      wallNodes.push(n);
    }
  }
  wallNodes.sort((a, b) => (parseNodeDate(a)?.getTime() ?? 0) - (parseNodeDate(b)?.getTime() ?? 0));
  const left: KGNode[] = [];
  const right: KGNode[] = [];
  for (let i = 0; i < wallNodes.length; i++) {
    if (i % 2 === 0) left.push(wallNodes[i]);
    else right.push(wallNodes[i]);
  }
  const packWallSide = (group: KGNode[], side: 'L' | 'R') => {
    const count = group.length;
    if (count === 0) return;
    const rows = Math.min(WALL_ROWS, Math.max(1, count));
    const cols = Math.ceil(count / rows);
    wallMetaOf.set(side, { cols, rows });
    for (let i = 0; i < count; i++) {
      const row = i % rows;
      const col = Math.floor(i / rows);
      gridPosOf.set(group[i].id, { x: col, y: row, worldZ: col * WALL_PITCH_Z });
      wallSideOf.set(group[i].id, side);
    }
  };
  packWallSide(left, 'L');
  packWallSide(right, 'R');

  const timeline: { t: number; z: number }[] = [];
  for (const n of wallNodes) {
    const t = parseNodeDate(n)?.getTime();
    const g = gridPosOf.get(n.id);
    if (t == null || !g) continue;
    timeline.push({ t, z: g.worldZ });
  }
  timeline.sort((a, b) => a.t - b.t);
  const zForTime = (t: number): number => {
    if (timeline.length === 0) return 0;
    if (t <= timeline[0].t) return timeline[0].z;
    const last = timeline[timeline.length - 1];
    if (t >= last.t) return last.z;
    for (let i = 1; i < timeline.length; i++) {
      if (t <= timeline[i].t) {
        const a = timeline[i - 1];
        const b = timeline[i];
        const span = b.t - a.t;
        const u = span > 0 ? (t - a.t) / span : 0;
        return a.z + u * (b.z - a.z);
      }
    }
    return last.z;
  };
  convNodes.sort((a, b) => (parseNodeDate(a)?.getTime() ?? 0) - (parseNodeDate(b)?.getTime() ?? 0));
  for (let i = 0; i < convNodes.length; i++) {
    const t = parseNodeDate(convNodes[i])?.getTime() ?? 0;
    const angle = i * CONV_GOLDEN_ANGLE;
    convPosOf.set(convNodes[i].id, {
      x: Math.cos(angle) * CONV_AISLE_X * 0.55,
      y: Math.sin(angle) * 28,
      worldZ: zForTime(t),
    });
  }

  const provisional: {
    node: KGNode;
    kind: NodeKind;
    cellX: number;
    cellY: number;
    cellZ: number;
    cellKey: string;
    yaw?: number;
  }[] = [];

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const kind = classifyKind(node);
    const provider = getProvider(kind);
    if (!provider || !provider.shouldRender(node, ctx)) continue;
    const cellZ = timePlan.cellZOf.get(node.id) ?? i;
    const onWall = wallSideOf.has(node.id);
    const side = onWall ? (wallSideOf.get(node.id) ?? 'L') : undefined;
    const cellX = onWall
      ? (side === 'R' ? WALL_CELL_X_RIGHT : WALL_CELL_X_LEFT)
      : 0;
    const cellY = 0;
    const yaw = onWall
      ? (side === 'R' ? WALL_YAW_RIGHT : WALL_YAW_LEFT)
      : undefined;
    const cellKey = `${cellX},${cellY},${cellZ}`;
    provisional.push({ node, kind, cellX, cellY, cellZ, cellKey, yaw });

    if (!onWall) {
      const nodeBucketZ = timePlan.cellZOf.get(node.id);
      if (nodeBucketZ !== undefined && (timePlan.todayKey || timePlan.yesterdayKey)) {
        const todayIdx = timePlan.todayKey ? timePlan.bucketIndex.get(timePlan.todayKey) : undefined;
        const yesterdayIdx = timePlan.yesterdayKey ? timePlan.bucketIndex.get(timePlan.yesterdayKey) : undefined;
        const todayZ = todayIdx !== undefined ? todayIdx * TIME_BUCKET_SPACING : -1;
        const yesterdayZ = yesterdayIdx !== undefined ? yesterdayIdx * TIME_BUCKET_SPACING : -1;
        let parentMonthKey: string | null = null;
        if (nodeBucketZ === todayZ) parentMonthKey = timePlan.todayMonthKey;
        else if (nodeBucketZ === yesterdayZ) parentMonthKey = timePlan.yesterdayMonthKey;
        if (parentMonthKey) {
          const monthIdx = timePlan.bucketIndex.get(parentMonthKey);
          if (monthIdx !== undefined) {
            const monthZ = monthIdx * TIME_BUCKET_SPACING;
            const monthCellKey = `0,0,${monthZ}`;
            provisional.push({
              node,
              kind,
              cellX: 0,
              cellY: 0,
              cellZ: monthZ,
              cellKey: monthCellKey,
            });
          }
        }
      }
    }
  }

  const out: CanvasNode[] = new Array(provisional.length);

  for (let i = 0; i < provisional.length; i++) {
    const p = provisional[i];
    const { node, kind, cellY } = p;
    let cellX = p.cellX;
    const cellZ0 = p.cellZ;
    const onWall = wallSideOf.has(node.id);
    const seed = hashStr(node.id);
    const side = onWall ? (wallSideOf.get(node.id) ?? 'L') : undefined;
    const yaw = onWall
      ? (side === 'R' ? WALL_YAW_RIGHT : WALL_YAW_LEFT)
      : p.yaw;

    let localX: number;
    let localY: number;
    let localZ: number;
    let cellZ = cellZ0;
    if (onWall) {
      const grid = gridPosOf.get(node.id) ?? { x: 0, y: 0, worldZ: 0 };
      const meta = wallMetaOf.get(side ?? 'L') ?? { cols: 1, rows: 1 };
      const row = grid.y;
      cellX = side === 'R' ? WALL_CELL_X_RIGHT : WALL_CELL_X_LEFT;
      localX = CHUNK_SIZE / 2;
      localY = (row - (meta.rows - 1) / 2) * WALL_PITCH_Y;
      const worldZ = grid.worldZ;
      cellZ = Math.floor(worldZ / CHUNK_SIZE);
      localZ = worldZ - cellZ * CHUNK_SIZE;
    } else {
      const grid = convPosOf.get(node.id) ?? { x: 0, y: 0, worldZ: 0 };
      const worldX = grid.x;
      cellX = worldX < 0 ? -1 : 0;
      localX = worldX - cellX * CHUNK_SIZE;
      localY = grid.y;
      const worldZ = grid.worldZ;
      cellZ = Math.floor(worldZ / CHUNK_SIZE);
      localZ = worldZ - cellZ * CHUNK_SIZE;
    }

    const pw = node.properties?.image_width ?? node.properties?.width;
    const ph = node.properties?.image_height ?? node.properties?.height;
    const base = 60 + seededRandom(seed + 4) * 60;
    let width: number;
    let height: number;
    if (onWall) {
      if (kind === 'conversation') {
        width = WALL_TILE_W * 1.12;
        height = WALL_TILE_W * 0.7;
      } else if (typeof pw === 'number' && typeof ph === 'number' && pw > 0 && ph > 0) {
        const aspect = pw / ph;
        if (aspect >= 1) {
          width = WALL_TILE_W;
          height = WALL_TILE_W / aspect;
        } else {
          height = WALL_TILE_W;
          width = WALL_TILE_W * aspect;
        }
      } else {
        width = WALL_TILE_W;
        height = WALL_TILE_W;
      }
    } else if (typeof pw === 'number' && typeof ph === 'number' && pw > 0 && ph > 0) {
      const aspect = pw / ph;
      height = base;
      width = Math.round(base * aspect);
    } else if (kind === 'conversation') {
      width = 210;
      height = 124;
    } else if (kind === 'document') {
      width = 156;
      height = 172;
    } else if (kind === 'audio') {
      width = 196;
      height = 118;
    } else if (kind === 'video') {
      width = Math.round(base * 1.15);
      height = Math.round(base * 1.15);
    } else if (kind === 'note') {
      height = base;
      width = Math.round(base / 1.4);
    } else {
      width = base;
      height = Math.round(base * 0.75);
    }

    let imageUrl: string | undefined;
    let fullUrl: string | undefined;
    let textContent: string | undefined;
    const fields = getProvider(kind)?.buildCanvasFields(node, ctx) ?? {};
    imageUrl = fields.imageUrl;
    fullUrl = fields.fullUrl;
    textContent = fields.textContent;

    out[i] = {
      id: node.id,
      labels: node.labels,
      properties: node.properties,
      kind,
      imageUrl,
      fullUrl,
      textContent,
      cellX,
      cellY,
      cellZ,
      localX,
      localY,
      localZ,
      width,
      height,
      ...(yaw != null ? { yaw } : {}),
    };
  }

  return out;
}