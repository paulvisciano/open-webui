/**
 * GraphStore — the data hub for the infinite-canvas graph view.
 *
 * Orchestrates nodes + edges: conversations come from OWUI's chat table
 * (projected as KGNode[] with `entity_type: 'Conversation'`), library assets
 * from GET /canvas (`asset:{uuid}` + `properties.taken_at` as Z), and images /
 * entities come from LightRAG via the graph API client.
 *
 * Ported from Knowledge Graph `graph.svelte.ts`. Key adaptations:
 *  - KG imports (`lightragClient`, `API`, `syncClient`) replaced with
 *    `$lib/apis/graph` (`getGraph`, `getConversations`) and the OWUI
 *    sync-client singleton (`graphSyncClient`).
 *  - `loadGraph` calls `getGraph(token)` instead of `lightragClient.getGraph`.
 *  - `loadConversations` fetches from `getConversations(token)` (OWUI graph
 *    conversations endpoint) rather than reading `syncClient.conversations`.
 *  - `fetchPersonImages` uses `getImageUrl` from the graph API client instead
 *    of KG's `API.kg.faceCropById` / `lightragClient.personPhotoUrl`.
 *  - Satisfies `GraphStoreLike` (sync-client interface): addNode, addEdge,
 *    updateNode, removeNode, removeEdge.
 *
 * Svelte 5 runes module (`.svelte.ts`) — uses `$state`, `$derived`, `$effect`.
 */

import type { KGNode, KGEdge } from '../constants';
import { isNoteNode, isLocalAssetNode } from '../renderer/Layout';
import { getGraph, getConversations, getImageUrl, getCanvas, listSources, searchGraph } from '$lib/apis/graph';
import { assetToKgNode, type GraphSource } from '../assets';
import { collectSearchMatchIds } from '../search-match';
import { searchHighlight } from '../renderer/search-highlight-flag';
import { graphSyncClient } from '../services/sync-client.svelte';
import { diffPresence, mergeSources, PRESENCE_POLL_MS } from '../presence';
import { scanProgressStore } from './scan-progress.svelte';

export const SCAN_POLL_MS = 2000;

class GraphStore {
  nodes = $state<KGNode[]>([]);
  edges = $state<KGEdge[]>([]);
  selectedNode: KGNode | null = $state(null);
  hoveredNode: KGNode | null = $state(null);
  searchQuery = $state('');
  /** Matching node ids from GET /graph/search + local title/kind. null = no search. */
  searchMatchIds = $state<Set<string> | null>(null);
  focusRequest = $state<string | null>(null);
  isLoading = $state(false);
  private searchGen = 0;
  /** nodeId → thumbnail URL for Photo node images (loaded on demand). */
  photoImages = $state<Record<string, string>>({});
  /** nodeId → dataUrl for Person face-crop images. */
  personImages = $state<Record<string, string>>({});
  /** sourceId → mounted/online for in-place library volumes. Empty = no sources. */
  sourceOnline = $state<Record<string, boolean>>({});
  /** Attached library volumes from GET /canvas. */
  sources = $state<GraphSource[]>([]);
  /** Currently-active conversation id (highlights the node). */
  activeConversationId = $state('');
  /** Conversation IDs currently streaming (shows thinking indicator). */
  streamingConversationIds = $state<Set<string>>(new Set());
  scanningSourceIds = $state<Set<string>>(new Set());

  /** Always the full graph — search dims in NodePlane, never unmounts. */
  filteredNodes = $derived.by(() => this.nodes);

  filteredEdges = $derived.by(() => this.edges);

  /** Load graph data (nodes + edges) from the OWUI graph API. */
  async loadGraph(token: string): Promise<void> {
    this.isLoading = true;
    try {
      const graph = await getGraph(token);
      if (!graph) return;

      const apiNodeIds = new Set(graph.nodes.map((n: KGNode) => n.id));
      const apiEdgeIds = new Set(graph.edges.map((e: KGEdge) => e.id));

      // Preserve locally-added nodes not yet in the backend response, but
      // drop stale optimistic Photo nodes whose source_id is
      // "manual_creation" (image processing that never persisted).
      const isStalePhotoNode = (n: KGNode): boolean => {
        if (
          !n.labels?.some((l) => /^(Photo|Image)$/i.test(l)) &&
          n.properties?.entity_type !== 'Photo' &&
          n.properties?.entity_type !== 'Image'
        )
          return false;
        if (isNoteNode(n)) return true;
        const sourceId = n.properties?.source_id ?? n.properties?.file_path;
        return !sourceId || sourceId === 'manual_creation';
      };

      const preservedNodes = this.nodes.filter(
        (n) => !apiNodeIds.has(n.id) && !isStalePhotoNode(n)
      );
      const preservedEdges = this.edges.filter((e) => !apiEdgeIds.has(e.id));
      this.nodes = [...graph.nodes, ...preservedNodes];
      this.edges = [...graph.edges, ...preservedEdges];
    } catch (err) {
      console.error('Graph load failed:', err);
    } finally {
      this.isLoading = false;
    }
  }

  private isConversationNode(n: KGNode): boolean {
    return (
      n.properties?.entity_type === 'Conversation' ||
      (n.labels ?? []).some((l) => l === 'Conversation')
    );
  }

  private toConversationNode(c: KGNode | { id: string; labels?: string[]; properties?: Record<string, any> }): KGNode {
    const p = c.properties ?? {};
    const createdRaw = p.created_at ?? p.createdAt;
    const updatedRaw = p.updated_at ?? p.updatedAt;
    const toMs = (v: unknown): number => {
      if (typeof v !== 'number' || !Number.isFinite(v)) return Date.now();
      return v > 1e12 ? v : v * 1000;
    };
    return {
      id: c.id,
      labels: c.labels ?? ['Conversation'],
      properties: {
        entity_type: 'Conversation',
        name: p.title ?? p.name,
        title: p.title ?? p.name,
        createdAt: toMs(createdRaw),
        updatedAt: toMs(updatedRaw),
        isActive: c.id === this.activeConversationId,
        isStreaming: this.streamingConversationIds.has(c.id)
      }
    };
  }

  /** Merge conversation nodes from `getConversations(token)` into
   *  `this.nodes`. Photos and other LightRAG-derived nodes are preserved —
   *  only conversation nodes are replaced. Safe to call repeatedly. */
  async loadConversations(token: string): Promise<void> {
    const convs = await getConversations(token);
    if (!convs) return;

    const convNodes: KGNode[] = convs.map((c: KGNode) => this.toConversationNode(c));

    const kept = this.nodes.filter((n) => !this.isConversationNode(n));
    this.nodes = [...kept, ...convNodes];
  }

  /** Merge library assets + conversations from GET /canvas.
   *  Additive for `asset:` nodes. Never drops conversations when assets are
   *  empty or when `canvas.conversations` is empty (failed/partial payload).
   *  LightRAG entities from `loadGraph` are preserved. Time stays on
   *  `properties.taken_at` — do not remap onto x/y. */
  async loadCanvas(token: string): Promise<void> {
    let canvas;
    try {
      canvas = await getCanvas(token);
    } catch (err) {
      console.error('Canvas load failed:', err);
      return;
    }
    if (!canvas) return;

    this.sources = canvas.sources ?? [];
    const sourceById = new Map(this.sources.map((s) => [s.id, s]));
    const online: Record<string, boolean> = {};
    for (const s of this.sources) online[s.id] = s.online;
    this.sourceOnline = online;

    const assetNodes = (canvas.assets ?? []).map((a) =>
      assetToKgNode(a, sourceById.get(a.sourceId) ?? null)
    );

    const rawConvs = canvas.conversations ?? [];
    const convNodes = rawConvs.length > 0 ? rawConvs.map((c) => this.toConversationNode(c)) : null;

    const kept = this.nodes.filter((n) => {
      if (isLocalAssetNode(n)) return false;
      if (convNodes && this.isConversationNode(n)) return false;
      return true;
    });

    this.nodes = convNodes
      ? [...kept, ...assetNodes, ...convNodes]
      : [...kept, ...assetNodes];
  }

  /** Single `$state` write for scan batches — avoids 1:1 churn via addNode. */
  addNodesBatch(nodes: KGNode[]) {
    if (!nodes.length) return;
    const incoming = new Map(nodes.map((n) => [n.id, n]));
    const kept = this.nodes.filter((n) => !incoming.has(n.id));
    this.nodes = [...kept, ...nodes];
  }

  applyPresence(nextSources: GraphSource[]): { wentOffline: string[]; cameOnline: string[] } {
    const { wentOffline, cameOnline, nextOnline } = diffPresence(
      this.sourceOnline,
      nextSources
    );
    const merged = mergeSources(this.sources, nextSources, nextOnline);

    let sourcesDirty = merged.length !== this.sources.length;
    if (!sourcesDirty) {
      const cur = new Map(this.sources.map((s) => [s.id, s]));
      for (const s of merged) {
        const prev = cur.get(s.id);
        if (
          !prev ||
          prev.online !== s.online ||
          prev.name !== s.name ||
          prev.lastAbsPath !== s.lastAbsPath ||
          prev.fingerprint !== s.fingerprint
        ) {
          sourcesDirty = true;
          break;
        }
      }
    }
    if (sourcesDirty) this.sources = merged;

    const onlineDirty =
      Object.keys(nextOnline).length !== Object.keys(this.sourceOnline).length ||
      Object.keys(nextOnline).some((id) => this.sourceOnline[id] !== nextOnline[id]);
    if (onlineDirty) this.sourceOnline = nextOnline;

    for (const id of wentOffline) {
      // Task 16: fade then dispose
      void this.vanishThenRemove(id);
    }

    return { wentOffline, cameOnline };
  }

  private presenceTimer: ReturnType<typeof setInterval> | null = null;
  private presenceInFlight = false;
  private vanishSourceFn: ((sourceId: string) => Promise<void>) | null = null;
  private vanishing = new Set<string>();

  setVanishHandler(fn: ((sourceId: string) => Promise<void>) | null): void {
    this.vanishSourceFn = fn;
  }

  get isVanishing(): boolean {
    return this.vanishing.size > 0;
  }

  async pollPresence(token: string): Promise<{ wentOffline: string[]; cameOnline: string[] }> {
    if (this.presenceInFlight) return { wentOffline: [], cameOnline: [] };
    this.presenceInFlight = true;
    try {
      const next = await listSources(token);
      const flips = this.applyPresence(next ?? []);
      if (flips.cameOnline.length) await this.loadCanvas(token);
      return flips;
    } catch (err) {
      console.error('Presence poll failed:', err);
      return { wentOffline: [], cameOnline: [] };
    } finally {
      this.presenceInFlight = false;
    }
  }

  startPresencePoll(tokenFn: () => string, intervalMs: number = PRESENCE_POLL_MS): void {
    this.stopPresencePoll();
    const tick = () => {
      void this.pollPresence(tokenFn());
    };
    tick();
    this.presenceTimer = setInterval(tick, intervalMs);
  }

  stopPresencePoll(): void {
    if (this.presenceTimer !== null) {
      clearInterval(this.presenceTimer);
      this.presenceTimer = null;
    }
  }

  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private scanInFlight = false;
  private scanIdleTicks = 0;
  private scanTickCount = 0;
  private scanSawRunning = false;

  async pollScanCanvas(token: string): Promise<{ added: number }> {
    if (this.scanInFlight) return { added: 0 };
    this.scanInFlight = true;
    try {
      const canvas = await getCanvas(token);
      if (!canvas) return { added: 0 };

      const sourceById = new Map((canvas.sources ?? []).map((s) => [s.id, s]));
      const assetNodes = (canvas.assets ?? []).map((a) =>
        assetToKgNode(a, sourceById.get(a.sourceId) ?? null)
      );
      const have = new Set(this.nodes.map((n) => n.id));
      const fresh = assetNodes.filter((n) => !have.has(n.id));
      this.addNodesBatch(fresh);

      const tracked = this.scanningSourceIds;
      if (tracked.size > 0) {
        const countBySource = new Map<string, number>();
        try {
          const listed = await listSources(token);
          for (const s of listed) {
            if (s.assetCount != null) countBySource.set(s.id, s.assetCount);
          }
        } catch {}
        for (const sid of tracked) {
          const src = sourceById.get(sid);
          const fromCanvas = (canvas.assets ?? []).filter((a) => a.sourceId === sid).length;
          const seen = countBySource.get(sid) ?? fromCanvas;
          scanProgressStore.applyPoll(sid, {
            scanning: src == null ? true : Boolean(src.scanning),
            seen,
            upserted: seen,
            name: src?.name
          });
        }
        const runningNow = (canvas.sources ?? []).some(
          (s) => tracked.has(s.id) && s.scanning
        );
        if (runningNow) this.scanSawRunning = true;
        else if (this.scanSawRunning) this.stopScanPoll();
      }

      return { added: fresh.length };
    } catch (err) {
      console.error('Scan canvas poll failed:', err);
      return { added: 0 };
    } finally {
      this.scanInFlight = false;
    }
  }

  startScanPoll(
    tokenFn: () => string,
    sourceId?: string,
    intervalMs: number = SCAN_POLL_MS
  ): void {
    if (sourceId) {
      const next = new Set(this.scanningSourceIds);
      next.add(sourceId);
      this.scanningSourceIds = next;
      const name = this.sources.find((s) => s.id === sourceId)?.name;
      scanProgressStore.ensure(sourceId, name || sourceId);
    }
    if (this.scanTimer !== null) {
      void this.pollScanCanvas(tokenFn());
      return;
    }
    this.scanIdleTicks = 0;
    this.scanTickCount = 0;
    this.scanSawRunning = false;
    const tick = () => {
      void this.pollScanCanvas(tokenFn()).then(({ added }) => {
        if (this.scanTimer === null) return;
        this.scanTickCount += 1;
        if (added === 0) this.scanIdleTicks += 1;
        else this.scanIdleTicks = 0;
        if (this.scanIdleTicks >= 2 && this.scanTickCount >= 3) {
          this.stopScanPoll();
        }
      });
    };
    this.scanTimer = setInterval(tick, intervalMs);
    tick();
  }

  stopScanPoll(): void {
    if (this.scanTimer !== null) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    if (this.scanningSourceIds.size) this.scanningSourceIds = new Set();
    this.scanIdleTicks = 0;
    this.scanTickCount = 0;
    this.scanSawRunning = false;
    scanProgressStore.completeActive();
  }

  async dropSource(sourceId: string): Promise<void> {
    if (!sourceId) return;
    await this.vanishThenRemove(sourceId);
    this.sources = this.sources.filter((s) => s.id !== sourceId);
    if (sourceId in this.sourceOnline) {
      const nextOnline = { ...this.sourceOnline };
      delete nextOnline[sourceId];
      this.sourceOnline = nextOnline;
    }
    if (this.scanningSourceIds.has(sourceId)) {
      const next = new Set(this.scanningSourceIds);
      next.delete(sourceId);
      this.scanningSourceIds = next;
    }
  }

  private async vanishThenRemove(sourceId: string): Promise<void> {
    if (!sourceId || this.vanishing.has(sourceId)) return;
    this.vanishing.add(sourceId);
    try {
      const fn = this.vanishSourceFn;
      if (fn) await fn(sourceId);
    } finally {
      this.vanishing.delete(sourceId);
      this.removeNodesBySource(sourceId);
    }
  }

  /** Drop in-place library nodes for a vanished source. Never removes conversations. */
  removeNodesBySource(sourceId: string) {
    if (!sourceId) return;
    const gone = new Set<string>();
    this.nodes = this.nodes.filter((n) => {
      if (this.isConversationNode(n) || !isLocalAssetNode(n)) return true;
      if (n.properties?.source_id !== sourceId) return true;
      gone.add(n.id);
      return false;
    });
    if (!gone.size) return;

    this.edges = this.edges.filter((e) => !gone.has(e.source) && !gone.has(e.target));

    const nextPhotos = { ...this.photoImages };
    const nextPeople = { ...this.personImages };
    let imgDirty = false;
    for (const id of gone) {
      if (id in nextPhotos) {
        delete nextPhotos[id];
        imgDirty = true;
      }
      if (id in nextPeople) {
        delete nextPeople[id];
        imgDirty = true;
      }
    }
    if (imgDirty) {
      this.photoImages = nextPhotos;
      this.personImages = nextPeople;
    }
    if (this.selectedNode && gone.has(this.selectedNode.id)) this.selectedNode = null;
    if (this.hoveredNode && gone.has(this.hoveredNode.id)) this.hoveredNode = null;
  }

  selectNode(node: KGNode | null) {
    this.selectedNode = node;
  }

  /** Set the active conversation, updating only the old and new node objects. */
  setActiveConversation(id: string) {
    if (this.activeConversationId === id) return;
    const prevId = this.activeConversationId;
    this.activeConversationId = id;
    this.nodes = this.nodes.map((n) => {
      if (n.properties?.entity_type !== 'Conversation') return n;
      if (n.id === prevId || n.id === id) {
        return {
          ...n,
          properties: {
            ...n.properties,
            isActive: n.id === id
          }
        };
      }
      return n;
    });
  }

  setStreamingConversations(ids: Set<string>) {
    if (this.streamingConversationIds === ids) return;
    if (
      this.streamingConversationIds.size === ids.size &&
      [...this.streamingConversationIds].every((id) => ids.has(id))
    )
      return;
    this.streamingConversationIds = ids;
  }

  setHoveredNode(node: KGNode | null) {
    this.hoveredNode = node;
  }

  private setSearchMatchIds(ids: Set<string> | null) {
    this.searchMatchIds = ids;
    searchHighlight.matchIds = ids ? new Set(ids) : null;
  }

  searchEntities(query: string) {
    this.searchQuery = query;
    const q = query.trim();
    if (!q) {
      this.searchGen += 1;
      this.setSearchMatchIds(null);
      return;
    }
    this.setSearchMatchIds(collectSearchMatchIds([], this.nodes, q));
  }

  async runServerSearch(token: string, query: string): Promise<void> {
    const q = query.trim();
    if (!q) {
      this.searchGen += 1;
      this.setSearchMatchIds(null);
      return;
    }
    const gen = ++this.searchGen;
    try {
      const hits = await searchGraph(token, q);
      if (gen !== this.searchGen) return;
      this.setSearchMatchIds(collectSearchMatchIds(hits, this.nodes, q));
    } catch (err) {
      if (gen !== this.searchGen) return;
      console.error('Graph search failed:', err);
      if (this.searchMatchIds === null) {
        this.setSearchMatchIds(collectSearchMatchIds([], this.nodes, q));
      }
    }
  }

  clearSearch() {
    this.searchGen += 1;
    this.searchQuery = '';
    this.setSearchMatchIds(null);
  }

  requestFocus(id: string) {
    this.focusRequest = id;
  }

  pendingOpenChatId = $state<string | null>(null);

  requestOpenChat(id: string) {
    this.pendingOpenChatId = id;
  }

  async refresh(token: string) {
    await this.loadGraph(token);
  }

  pipelineDone = $state(false);

  // ── GraphStoreLike interface (sync-client) ─────────────────────────

  addNode(node: KGNode) {
    this.nodes = [...this.nodes.filter((n) => n.id !== node.id), node];
  }

  addEdge(edge: KGEdge) {
    this.edges = [...this.edges.filter((e) => e.id !== edge.id), edge];
  }

  updateNode(node: KGNode) {
    this.nodes = [...this.nodes.filter((n) => n.id !== node.id), node];
  }

  removeNode(id: string) {
    this.nodes = this.nodes.filter((n) => n.id !== id);
    this.edges = this.edges.filter((e) => e.source !== id && e.target !== id);
    delete this.photoImages[id];
    this.photoImages = { ...this.photoImages };
    delete this.personImages[id];
    this.personImages = { ...this.personImages };
  }

  removeEdge(id: string) {
    this.edges = this.edges.filter((e) => e.id !== id);
  }

  // ── Upsert helpers ──────────────────────────────────────────────────

  upsertNode(id: string, labels: string[], properties: Record<string, unknown>) {
    const node: KGNode = { id, labels, properties };
    this.nodes = [...this.nodes.filter((n) => n.id !== id), node];
  }

  mergeNodeProperties(id: string, labels: string[], properties: Record<string, unknown>) {
    const existing = this.nodes.find((n) => n.id === id);
    if (!existing) {
      this.upsertNode(id, labels, properties);
      return;
    }
    existing.properties = { ...existing.properties, ...properties };
    this.nodes = [...this.nodes];
  }

  upsertEdge(source: string, target: string, type: string, properties: Record<string, unknown> = {}) {
    const id = `${source}-${type}-${target}`;
    const edge: KGEdge = { id, source, target, type, properties };
    this.edges = [...this.edges.filter((e) => e.id !== id), edge];
  }

  // ── Photo / Person image helpers ───────────────────────────────────

  /** Optimistically remove a photo node (and its edges + cached images). */
  removePhoto(fileSource: string): void {
    const nodeId = this.nodes.find(
      (n) =>
        (n.properties?.source_id as string) === fileSource ||
        (n.properties?.file_path as string) === fileSource ||
        n.id === fileSource
    )?.id;
    if (!nodeId) return;
    this.nodes = this.nodes.filter((n) => n.id !== nodeId);
    this.edges = this.edges.filter((e) => e.source !== nodeId && e.target !== nodeId);
    delete this.photoImages[nodeId];
    this.photoImages = { ...this.photoImages };
    delete this.personImages[nodeId];
    this.personImages = { ...this.personImages };
  }

  setPhotoImage(nodeId: string, url: string) {
    this.photoImages = { ...this.photoImages, [nodeId]: url };
  }

  setPersonImage(nodeId: string, dataUrl: string) {
    this.personImages = { ...this.personImages, [nodeId]: dataUrl };
  }

  /** Fetch face-crop images for person nodes that don't have one yet. */
  private async fetchPersonImages(nodes: KGNode[]) {
    const personNodes = nodes.filter((n) => {
      const et = n.properties?.entity_type;
      if (typeof et === 'string') return et.toLowerCase() === 'person';
      return n.labels?.some((l) => l.toLowerCase() === 'person') ?? false;
    });
    if (personNodes.length === 0) return;

    const updates: Record<string, string> = {};
    await Promise.all(
      personNodes.map(async (node) => {
        if (this.personImages[node.id]) return;
        try {
          const faceId = node.properties?.face_id as string | undefined;
          const fname = node.properties?.file_path as string | undefined;
          const url = faceId
            ? getImageUrl(faceId)
            : fname
              ? getImageUrl(fname)
              : null;
          if (!url) return;
          const resp = await fetch(url);
          if (!resp.ok) return;
          const blob = await resp.blob();
          const dataUrl = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.readAsDataURL(blob);
          });
          updates[node.id] = dataUrl;
        } catch {
          // Skip on fetch failure.
        }
      })
    );
    if (Object.keys(updates).length > 0) {
      this.personImages = { ...this.personImages, ...updates };
    }
  }

  // ── Sync client integration ────────────────────────────────────────

  /** Connect the graph sync client to receive real-time updates. */
  connectSync(): void {
    graphSyncClient.connect(this);
  }

  /** Disconnect the graph sync client. */
  disconnectSync(): void {
    graphSyncClient.disconnect();
  }

  reset() {
    this.stopScanPoll();
    this.nodes = [];
    this.edges = [];
    this.selectedNode = null;
    this.hoveredNode = null;
    this.searchQuery = '';
    this.setSearchMatchIds(null);
    this.focusRequest = null;
    this.pendingOpenChatId = null;
    this.searchGen += 1;
  }
}

export const graphStore = new GraphStore();