/**
 * GraphSyncClient — real-time graph update client for Open WebUI.
 *
 * Adapted from the Knowledge Graph `sync-client.svelte.ts` pattern but
 * re-targeted at OWUI's existing Socket.IO connection rather than KG's
 * custom HTTP-polling sync server. The backend graph router (Wave 3) is
 * expected to emit Socket.IO events to the user's `user:{id}` room when
 * graph data changes; this client subscribes to those events and forwards
 * them to a `GraphStore` consumer.
 *
 * Event contract (backend → client):
 *   - `graph:node_added`    { node: KGNode }
 *   - `graph:edge_added`    { edge: KGEdge }
 *   - `graph:node_updated`  { node: KGNode }
 *   - `graph:node_removed`  { id: string }
 *   - `graph:edge_removed`  { id: string }
 *
 * The client uses Svelte 5 runes (`$state`) so it is authored as a
 * `.svelte.ts` module and must be imported from a Svelte component or
 * another `.svelte.ts` module.
 */

import { get } from 'svelte/store';
import { socket, socketConnected } from '$lib/stores';
import type { Socket } from 'socket.io-client';
import type { KGNode, KGEdge } from '../constants';

/**
 * Minimal GraphStore surface that the sync client drives.
 *
 * The real GraphStore (ported by a parallel task) implements these
 * methods. We depend only on this narrow interface so the sync client
 * can be landed before the store is fully ported.
 */
export interface GraphStoreLike {
	addNode(node: KGNode): void;
	addEdge(edge: KGEdge): void;
	updateNode(node: KGNode): void;
	removeNode(id: string): void;
	removeEdge(id: string): void;
}

/** Connection status surfaced to the UI. */
export type GraphSyncStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';

/** Inbound graph event payloads (must match backend `sio.emit` shapes). */
interface NodeAddedEvent {
	node: KGNode;
}
interface EdgeAddedEvent {
	edge: KGEdge;
}
interface NodeUpdatedEvent {
	node: KGNode;
}
interface NodeRemovedEvent {
	id: string;
}
interface EdgeRemovedEvent {
	id: string;
}

/** Graph Socket.IO events we subscribe to. */
const GRAPH_EVENTS = [
	'graph:node_added',
	'graph:edge_added',
	'graph:node_updated',
	'graph:node_removed',
	'graph:edge_removed'
] as const;

type GraphEventName = (typeof GRAPH_EVENTS)[number];

/**
 * Manages real-time graph updates over OWUI's Socket.IO connection.
 *
 * Lifecycle:
 *   1. `connect(graphStore)` — call once after the graph view mounts.
 *      Subscribes to the shared `socket` store and binds event handlers.
 *   2. The socket store's value may change (e.g. on reauth); this client
 *      re-binds automatically when a new socket instance appears.
 *   3. `disconnect()` — call when the graph view unmounts. Removes all
 *      listeners so we never leak handlers onto the shared socket.
 */
class GraphSyncClient {
	/** Current connection status, reactive for UI binding. */
	status = $state<GraphSyncStatus>('disconnected');

	/** Last error message, if any. Cleared on successful connect. */
	error = $state<string | null>(null);

	/** Number of updates received since connect (useful for debugging / badges). */
	updatesReceived = $state(0);

	/** Active socket subscription handle (unsubscribe function). */
	private unsubscribeSocket: (() => void) | null = null;

	/** The store instance we forward updates to. */
	private graphStore: GraphStoreLike | null = null;

	/** Currently-bound socket (so we can clean up its listeners on swap). */
	private boundSocket: Socket | null = null;

	/**
	 * Subscribe to graph updates and forward them to `graphStore`.
	 *
	 * Safe to call multiple times — re-binding to a new store will first
	 * detach listeners from the previous socket.
	 */
	connect(graphStore: GraphStoreLike): void {
		this.graphStore = graphStore;
		this.status = 'connecting';
		this.error = null;

		// If we were already bound, tear down the old binding first.
		this.detachFromSocket();

		// Subscribe to the shared socket store so we re-bind whenever the
		// app creates a fresh socket (e.g. after re-authentication).
		this.unsubscribeSocket = socket.subscribe((sock) => {
			this.bindToSocket(sock);
		});
	}

	/** Detach all listeners and stop forwarding updates. */
	disconnect(): void {
		this.detachFromSocket();
		if (this.unsubscribeSocket) {
			this.unsubscribeSocket();
			this.unsubscribeSocket = null;
		}
		this.graphStore = null;
		this.status = 'disconnected';
	}

	/**
	 * Re-bind event handlers to a socket instance (or mark disconnected
	 * when the socket store has no value yet).
	 */
	private bindToSocket(sock: Socket | null): void {
		// Always detach from any previous socket first.
		this.detachFromSocket();

		if (!sock) {
			this.status = 'disconnected';
			return;
		}

		this.boundSocket = sock;

		// If the socket is already connected, reflect that immediately.
		if (sock.connected) {
			this.status = 'connected';
		} else {
			this.status = sock.io.opts.reconnection ? 'reconnecting' : 'connecting';
		}

		// Track connection lifecycle for status reporting.
		sock.on('connect', this.onSocketConnect);
		sock.on('disconnect', this.onSocketDisconnect);
		sock.io.on('reconnect_attempt', this.onReconnectAttempt);
		sock.io.on('reconnect_failed', this.onReconnectFailed);

		// Graph data events.
		sock.on('graph:node_added', this.onNodeAdded);
		sock.on('graph:edge_added', this.onEdgeAdded);
		sock.on('graph:node_updated', this.onNodeUpdated);
		sock.on('graph:node_removed', this.onNodeRemoved);
		sock.on('graph:edge_removed', this.onEdgeRemoved);
	}

	private detachFromSocket(): void {
		const sock = this.boundSocket;
		if (!sock) return;

		sock.off('connect', this.onSocketConnect);
		sock.off('disconnect', this.onSocketDisconnect);
		sock.io.off('reconnect_attempt', this.onReconnectAttempt);
		sock.io.off('reconnect_failed', this.onReconnectFailed);

		for (const evt of GRAPH_EVENTS) {
			sock.off(evt as GraphEventName);
		}

		this.boundSocket = null;
	}

	// ── Connection lifecycle handlers ───────────────────────────────

	private onSocketConnect = (): void => {
		this.status = 'connected';
		this.error = null;
	};

	private onSocketDisconnect = (): void => {
		// OWUI's socket auto-reconnects; reflect that as "reconnecting".
		this.status = 'reconnecting';
	};

	private onReconnectAttempt = (): void => {
		this.status = 'reconnecting';
	};

	private onReconnectFailed = (): void => {
		this.status = 'error';
		this.error = 'Graph sync reconnection failed';
	};

	// ── Graph event handlers → GraphStore ────────────────────────────

	private onNodeAdded = (data: NodeAddedEvent): void => {
		if (!this.graphStore) return;
		this.graphStore.addNode(data.node);
		this.updatesReceived++;
	};

	private onEdgeAdded = (data: EdgeAddedEvent): void => {
		if (!this.graphStore) return;
		this.graphStore.addEdge(data.edge);
		this.updatesReceived++;
	};

	private onNodeUpdated = (data: NodeUpdatedEvent): void => {
		if (!this.graphStore) return;
		this.graphStore.updateNode(data.node);
		this.updatesReceived++;
	};

	private onNodeRemoved = (data: NodeRemovedEvent): void => {
		if (!this.graphStore) return;
		this.graphStore.removeNode(data.id);
		this.updatesReceived++;
	};

	private onEdgeRemoved = (data: EdgeRemovedEvent): void => {
		if (!this.graphStore) return;
		this.graphStore.removeEdge(data.id);
		this.updatesReceived++;
	};
}

/** Shared singleton — mirrors the KG `syncClient` export pattern. */
export const graphSyncClient = new GraphSyncClient();

/**
 * Convenience: read the current connection status from the OWUI socket
 * store without subscribing. Useful for components that want a one-shot
 * snapshot (e.g. to decide whether to show an offline banner).
 */
export function getGraphSyncConnected(): boolean {
	return get(socketConnected);
}