/**
 * Connection status store — adapted from Knowledge Graph `connection.svelte.ts`.
 *
 * KG polled three separate services (LightRAG, Llama, KG API) for health.
 * OWUI's graph stack exposes a single `/api/v1/graph/health` endpoint via
 * the graph API client (`getGraphHealth`), and the sync-client surfaces
 * the Socket.IO connection status. This store unifies both signals.
 *
 * Removed KG-specific imports: `lightragClient`, `llamaClient`,
 * `kgApiClient`, `mcpClient` — none exist in OWUI.
 *
 * Svelte 5 runes module (`.svelte.ts`) — uses `$state`.
 */

import { getGraphHealth } from '$lib/apis/graph';
import { graphSyncClient } from '../services/sync-client.svelte';

class ConnectionStore {
  /** Graph backend (LightRAG pipeline) reachable. */
  graphBackendConnected = $state(false);
  /** Pipeline currently busy processing (image ingestion, etc.). */
  pipelineBusy = $state(false);
  /** Socket.IO graph sync connection status (mirrors sync client). */
  syncConnected = $state(false);
  /** Last error message from a health check, if any. */
  lastError = $state<string | null>(null);

  private intervalId: ReturnType<typeof setInterval> | null = null;
  private unsubscribeSync: (() => void) | null = null;

  /** Check the graph backend health endpoint. */
  async checkGraphHealth(token: string = ''): Promise<void> {
    try {
      const status = await getGraphHealth(token);
      if (status) {
        this.graphBackendConnected = status.status === 'healthy';
        this.pipelineBusy = status.pipeline_busy ?? false;
        this.lastError = null;
      } else {
        this.graphBackendConnected = false;
      }
    } catch (err) {
      this.graphBackendConnected = false;
      this.lastError = err instanceof Error ? err.message : String(err);
    }
  }

  /** Start polling the graph backend health at a fixed interval. */
  startPolling(tokenFn: () => string, intervalMs: number = 300_000): void {
    this.stopPolling();
    const poll = () => this.checkGraphHealth(tokenFn());
    poll();
    this.intervalId = setInterval(poll, intervalMs);

    // Subscribe to sync client status changes.
    this.unsubscribeSync = effectSubscribe(() => graphSyncClient.status, (status) => {
      this.syncConnected = status === 'connected';
    });
  }

  /** Stop polling and detach the sync subscription. */
  stopPolling(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.unsubscribeSync) {
      this.unsubscribeSync();
      this.unsubscribeSync = null;
    }
  }
}

/**
 * Subscribe to a Svelte 5 `$state` getter and call `callback` on changes.
 * Returns an unsubscribe function. Uses `$effect.root` so it can be called
 * outside a component context (e.g. from a store method).
 */
function effectSubscribe<T>(getter: () => T, callback: (value: T) => void): () => void {
  return $effect.root(() => {
    $effect(() => {
      const value = getter();
      callback(value);
    });
  });
}

export const connectionStore = new ConnectionStore();