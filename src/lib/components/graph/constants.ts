/**
 * Graph type definitions ported from the Knowledge Graph project.
 *
 * Only the graph/canvas-related types are included here. Chat, MCP,
 * audio, and LLM-specific types (ChatMessage, MCPToolCall,
 * OllamaChatRequest, OllamaChatChunk, etc.) are NOT ported — they belong
 * to the chat layer and are out of scope for the canvas integration.
 */

export type QueryMode = 'naive' | 'local' | 'global' | 'hybrid' | 'mix' | 'bypass';

export interface KGNode {
  id: string;
  labels: string[];
  properties: Record<string, unknown>;
}

export interface KGEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  properties: Record<string, unknown>;
}

export interface KGGraph {
  nodes: KGNode[];
  edges: KGEdge[];
}

export interface QueryRequest {
  query: string;
  mode: QueryMode;
  only_need_context?: boolean;
  only_need_prompt?: boolean;
  response_type?: string;
  stream?: boolean;
  top_k?: number;
  conversation_history?: Message[];
  history_turns?: number;
  include_references?: boolean;
  include_chunk_content?: boolean;
}

export interface KgEntity {
  entity_name: string;
  entity_type: string;
  description: string;
  source_id: string;
  file_path: string;
  created_at: string;
  reference_id: string;
}

export interface KgRelationship {
  src_id: string;
  tgt_id: string;
  description: string;
  keywords: string;
  weight: number;
  source_id: string;
  file_path: string;
  created_at: string;
  reference_id: string;
}

export interface KgChunk {
  content: string;
  file_path: string;
  chunk_id: string;
  reference_id: string;
}

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}