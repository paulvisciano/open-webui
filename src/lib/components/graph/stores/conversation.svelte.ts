/**
 * Conversation store — adapted for Open WebUI's chat API.
 *
 * KG's original used a local `Conversation` interface with `ChatMessage[]`
 * and managed conversations in-memory. OWUI persists chats in the backend
 * `chat` table, so this store is a thin reactive cache that mirrors chat
 * list state and delegates CRUD to `$lib/apis/chats`.
 *
 * Key adaptations:
 *  - `createNewChat(token, chat, folderId)` replaces KG's local
 *    `createConversation()` (which only generated a UUID + unshifted).
 *  - `getChatList(token)` replaces KG's sync-client conversation list.
 *  - `getChatById(token, id)` loads a full chat (with messages) on demand.
 *  - `deleteChatById(token, id)` replaces the local filter removal.
 *  - `ChatMessage` type dropped — OWUI chat messages are `chat.chat[]` in
 *    the backend response shape and are not needed by the graph canvas
 *    (which only needs id/title/createdAt for node projection).
 */

import { createNewChat, getChatList, getChatById, deleteChatById } from '$lib/apis/chats';
import { getConversations } from '$lib/apis/graph';

/** Minimal chat metadata used by the graph canvas for node projection. */
export interface GraphConversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

/** KGNode shape returned by the graph API's /conversations endpoint. */
export interface KGNode {
  id: string;
  labels: string[];
  properties: Record<string, unknown>;
}

class ConversationStore {
  conversations = $state<GraphConversation[]>([]);
  activeConversationId = $state('');
  unreadConversations = $state<Set<string>>(new Set());
  navigateCount = $state(0);
  nodeToChatId = $state<Map<string, string>>(new Map());

  get activeConversation(): GraphConversation | undefined {
    return this.conversations.find((c) => c.id === this.activeConversationId);
  }

  /** Load the chat list from OWUI backend and cache it as GraphConversation[]. */
  async loadConversations(token: string): Promise<void> {
    const chats = await getChatList(token);
    if (!chats) return;
    this.conversations = chats.map((c: any) => ({
      id: c.id,
      title: c.title ?? '',
      createdAt: c.created_at ? new Date(c.created_at).getTime() : Date.now(),
      updatedAt: c.updated_at ? new Date(c.updated_at).getTime() : Date.now()
    }));
  }

  /** Load conversations from the graph API (/conversations) as KGNode[] and
   *  cache them, populating nodeToChatId so the canvas can link nodes to chats. */
  async loadConversationsFromGraph(token: string): Promise<KGNode[]> {
    const nodes = await getConversations(token);
    if (!Array.isArray(nodes)) return [];
    this.conversations = nodes.map((n: KGNode) => {
      const p = n.properties || {};
      const chatId = String(n.id);
      this.nodeToChatId.set(n.id, chatId);
      return {
        id: chatId,
        title: String(p.title ?? ''),
        createdAt: p.created_at ? new Date(p.created_at as number).getTime() : Date.now(),
        updatedAt: p.updated_at ? new Date(p.updated_at as number).getTime() : Date.now()
      };
    });
    return nodes;
  }

  /** Create a new chat via OWUI backend and add it to the cache. */
  async createConversation(
    token: string,
    chat: object,
    folderId: string | null = null
  ): Promise<GraphConversation | null> {
    const res = await createNewChat(token, chat, folderId);
    if (!res) return null;
    const conv: GraphConversation = {
      id: res.id,
      title: res.title ?? '',
      createdAt: res.created_at ? new Date(res.created_at).getTime() : Date.now(),
      updatedAt: res.updated_at ? new Date(res.updated_at).getTime() : Date.now()
    };
    this.conversations.unshift(conv);
    this.activeConversationId = conv.id;
    this.nodeToChatId.set(conv.id, conv.id);
    return conv;
  }

  /** Load a full chat (with messages) from OWUI backend. */
  async loadChat(token: string, id: string): Promise<any | null> {
    return await getChatById(token, id);
  }

  switchConversation(id: string): void {
    this.activeConversationId = id;
    this.navigateCount++;
    if (this.unreadConversations.has(id)) {
      this.unreadConversations = new Set(
        [...this.unreadConversations].filter((cid) => cid !== id)
      );
    }
  }

  markUnread(id: string): void {
    this.unreadConversations = new Set([...this.unreadConversations, id]);
  }

  updateConversation(id: string, updater: (conv: GraphConversation) => void): void {
    const conv = this.conversations.find((c) => c.id === id);
    if (conv) {
      updater(conv);
      conv.updatedAt = Date.now();
      this.conversations = [...this.conversations];
    }
  }

  setConversations(conversations: GraphConversation[]): void {
    this.conversations = conversations;
  }

  async deleteConversation(token: string, id: string): Promise<void> {
    await deleteChatById(token, id);
    this.conversations = this.conversations.filter((c) => c.id !== id);
    if (this.activeConversationId === id) {
      this.activeConversationId = this.conversations[0]?.id ?? '';
    }
  }
}

export const conversationStore = new ConversationStore();