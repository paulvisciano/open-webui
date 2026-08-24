/**
 * GraphStore — the data hub for the infinite-canvas graph view.
 *
 * Orchestrates nodes + edges: conversations come from OWUI's chat table
 * (projected as KGNode[] with `entity_type: 'Conversation'`), and images /
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
import { isNoteNode } from '../renderer/Layout';
import { getGraph, getConversations, getImageUrl } from '$lib/apis/graph';
import { graphSyncClient } from '../services/sync-client.svelte';

class GraphStore {
  nodes = $state<KGNode[]>([]);
  edges = $state<KGEdge[]>([]);
  selectedNode: KGNode | null = $state(null);
  hoveredNode: KGNode | null = $state(null);
  searchQuery = $state('');
  isLoading = $state(false);
  /** nodeId → thumbnail URL for Photo node images (loaded on demand). */
  photoImages = $state<Record<string, string>>({});
  /** nodeId → dataUrl for Person face-crop images. */
  personImages = $state<Record<string, string>>({});
  /** Currently-active conversation id (highlights the node). */
  activeConversationId = $state('');
  /** Conversation IDs currently streaming (shows thinking indicator). */
  streamingConversationIds = $state<Set<string>>(new Set());

  filteredNodes = $derived.by(() => {
    if (!this.searchQuery.trim()) return this.nodes;
    const q = this.searchQuery.toLowerCase();
    return this.nodes.filter((n) => {
      const label = n.labels?.join(' ').toLowerCase() ?? '';
      const props = JSON.stringify(n.properties).toLowerCase();
      return label.includes(q) || props.includes(q) || n.id.toLowerCase().includes(q);
    });
  });

  filteredEdges = $derived.by(() => {
    if (!this.searchQuery.trim()) return this.edges;
    const nodeIds = new Set(this.filteredNodes.map((n) => n.id));
    return this.edges.filter((e) => nodeIds.has(e.source) || nodeIds.has(e.target));
  });

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

  /** Merge conversation nodes from `getConversations(token)` into
   *  `this.nodes`. Photos and other LightRAG-derived nodes are preserved —
   *  only conversation nodes are replaced. Safe to call repeatedly. */
  async loadConversations(token: string): Promise<void> {
    const convs = await getConversations(token);
    if (!convs) return;

    const convNodes: KGNode[] = convs.map((c: any) => {
      const p = c.properties ?? {};
      return {
        id: c.id,
        labels: c.labels ?? ['Conversation'],
        properties: {
          entity_type: 'Conversation',
          name: p.title ?? p.name,
          title: p.title ?? p.name,
          createdAt: p.created_at ? (p.created_at > 1e12 ? p.created_at : p.created_at * 1000) : Date.now(),
          updatedAt: p.updated_at ? (p.updated_at > 1e12 ? p.updated_at : p.updated_at * 1000) : Date.now(),
          isActive: c.id === this.activeConversationId,
          isStreaming: this.streamingConversationIds.has(c.id)
        }
      };
    });

    const kept = this.nodes.filter(
      (n) => n.properties?.entity_type !== 'Conversation' &&
             !(n.labels ?? []).some((l) => l === 'Conversation')
    );
    this.nodes = [...kept, ...convNodes];
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

  searchEntities(query: string) {
    this.searchQuery = query;
  }

  clearSearch() {
    this.searchQuery = '';
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
    this.nodes = [];
    this.edges = [];
    this.selectedNode = null;
    this.hoveredNode = null;
    this.searchQuery = '';
  }
}

export const graphStore = new GraphStore();