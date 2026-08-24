/**
 * UI state store — adapted from Knowledge Graph `ui.ts`.
 *
 * Ported state: activeTab, selectedNodeId, rightPanelOpen, historyPanelOpen.
 * Removed state: navDrawerOpen (OWUI sidebar handles navigation),
 * settingsDrawerOpen (no graph settings UI in OWUI), lightragStatus /
 * llamaStatus / mcpStatus (replaced by `connectionStore`).
 *
 * Converted from Svelte 4 `writable` stores to Svelte 5 runes (`$state`)
 * to match the rest of the graph stores.
 */

export type GraphTabId = 'graph' | 'ingestion';

class UIStore {
  activeTab = $state<GraphTabId>('graph');
  selectedNodeId = $state<string | null>(null);
  rightPanelOpen = $state(true);
  historyPanelOpen = $state(false);

  setTab(tab: GraphTabId): void {
    this.activeTab = tab;
  }

  selectNode(id: string | null): void {
    this.selectedNodeId = id;
  }

  toggleRightPanel(): void {
    this.rightPanelOpen = !this.rightPanelOpen;
  }

  toggleHistoryPanel(): void {
    this.historyPanelOpen = !this.historyPanelOpen;
  }
}

export const uiStore = new UIStore();