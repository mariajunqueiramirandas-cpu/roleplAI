import type { Role } from "../config.ts";

export interface ContentPart {
  type: "text";
  text: string;
  /** Mark the end of a stable, cacheable prefix. */
  cache?: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatRequest {
  role: Role;
  /** What the call is for; used for logging and by the offline provider. */
  task: string;
  model: string;
  fallbacks?: string[];
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  tools?: ToolDef[];
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  providerOrder?: string[];
  quantizations?: string[];
  /** Structured context for the offline provider. Never sent to a real API. */
  meta?: Record<string, unknown>;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cost: number;
}

export interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
  usage: Usage;
  model: string;
  provider?: string;
}

export interface ModelInfo {
  id: string;
  contextLength: number;
  supportedParameters: string[];
  pricing?: { prompt: number; completion: number };
}

export interface Provider {
  name: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
  embed(model: string, inputs: string[], dims: number): Promise<{ vectors: number[][]; usage: Usage }>;
  rerank(model: string, query: string, docs: string[]): Promise<{ results: { index: number; score: number }[]; usage: Usage }>;
  models(): Promise<ModelInfo[]>;
}

export function textOf(c: string | ContentPart[]): string {
  return typeof c === "string" ? c : c.map((p) => p.text).join("\n\n");
}

/** Truncate to `dims` and renormalise (for Matryoshka-trained models such as Qwen3-Embedding). */
export function fitDims(v: number[], dims: number): number[] {
  const out = v.length > dims ? v.slice(0, dims) : v.length < dims ? [...v, ...new Array(dims - v.length).fill(0)] : v;
  const n = Math.sqrt(out.reduce((s, x) => s + x * x, 0)) || 1;
  return out.map((x) => x / n);
}
