import type { ChatMessage, ChatRequest, ChatResponse, ModelInfo, Provider, Usage } from "./types.ts";
import { fitDims, textOf } from "./types.ts";

const BASE = "https://openrouter.ai/api/v1";

/** Providers that need explicit cache breakpoints; the rest cache automatically. */
function needsCacheBreakpoints(model: string) {
  return model.startsWith("anthropic/") || model.startsWith("google/");
}

function toWireMessages(model: string, msgs: ChatMessage[]) {
  const explicit = needsCacheBreakpoints(model);
  return msgs.map((m) => {
    const base: Record<string, unknown> = { role: m.role };
    if (typeof m.content === "string" || !explicit) base.content = textOf(m.content);
    else
      base.content = m.content.map((p) => ({
        type: "text",
        text: p.text,
        ...(p.cache ? { cache_control: { type: "ephemeral" } } : {}),
      }));
    if (m.tool_calls?.length)
      base.tool_calls = m.tool_calls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: t.arguments } }));
    if (m.tool_call_id) base.tool_call_id = m.tool_call_id;
    return base;
  });
}

function usageOf(u: any): Usage {
  return {
    promptTokens: u?.prompt_tokens ?? 0,
    completionTokens: u?.completion_tokens ?? 0,
    cachedTokens: u?.prompt_tokens_details?.cached_tokens ?? 0,
    cost: u?.cost ?? 0,
  };
}

export class OpenRouterProvider implements Provider {
  name = "openrouter";
  constructor(
    private apiKey = process.env.OPENROUTER_API_KEY ?? "",
    private base = process.env.OPENROUTER_BASE_URL ?? BASE,
  ) {}

  private async post(path: string, body: unknown, attempt = 0): Promise<any> {
    if (!this.apiKey) throw new Error("OPENROUTER_API_KEY is not set. Set it in the environment, or run with --mock.");
    const res = await fetch(`${this.base}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/roleplai",
        "X-Title": "roleplAI",
      },
      body: JSON.stringify(body),
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      return this.post(path, body, attempt + 1);
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`OpenRouter ${path} ${res.status}: ${text.slice(0, 500)}`);
    const data = JSON.parse(text);
    if (data.error) throw new Error(`OpenRouter ${path}: ${JSON.stringify(data.error).slice(0, 500)}`);
    return data;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: toWireMessages(req.model, req.messages),
      temperature: req.temperature,
      max_tokens: req.maxTokens,
      usage: { include: true },
      provider: {
        require_parameters: true,
        ...(req.providerOrder?.length ? { order: req.providerOrder } : {}),
        ...(req.quantizations?.length ? { quantizations: req.quantizations } : {}),
      },
    };
    if (req.fallbacks?.length) body.models = [req.model, ...req.fallbacks];
    if (req.tools?.length) {
      body.tools = req.tools;
      body.tool_choice = "auto";
    }
    if (req.jsonSchema) {
      body.response_format = { type: "json_schema", json_schema: { name: req.jsonSchema.name, strict: false, schema: req.jsonSchema.schema } };
    }
    const data = await this.post("/chat/completions", body);
    const msg = data.choices?.[0]?.message ?? {};
    return {
      content: typeof msg.content === "string" ? msg.content : Array.isArray(msg.content) ? msg.content.map((p: any) => p.text ?? "").join("") : "",
      toolCalls: (msg.tool_calls ?? []).map((t: any, i: number) => ({
        id: t.id ?? `call_${i}`,
        name: t.function?.name,
        arguments: t.function?.arguments ?? "{}",
      })),
      usage: usageOf(data.usage),
      model: data.model ?? req.model,
      provider: data.provider,
    };
  }

  async embed(model: string, inputs: string[], dims: number) {
    const data = await this.post("/embeddings", { model, input: inputs, dimensions: dims });
    const rows = [...(data.data ?? [])].sort((a: any, b: any) => (a.index ?? 0) - (b.index ?? 0));
    return { vectors: rows.map((r: any) => fitDims(r.embedding as number[], dims)), usage: usageOf(data.usage) };
  }

  async rerank(model: string, query: string, docs: string[]) {
    const data = await this.post("/rerank", { model, query, documents: docs });
    const results = (data.results ?? data.data ?? []).map((r: any) => ({
      index: r.index,
      score: r.relevance_score ?? r.score ?? 0,
    }));
    return { results, usage: usageOf(data.usage) };
  }

  async models(): Promise<ModelInfo[]> {
    const res = await fetch(`${this.base}/models`, {
      headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
    });
    if (!res.ok) throw new Error(`OpenRouter /models ${res.status}`);
    const data = (await res.json()) as { data: any[] };
    return data.data.map((m) => ({
      id: m.id,
      contextLength: m.context_length ?? m.top_provider?.context_length ?? 0,
      supportedParameters: m.supported_parameters ?? [],
      pricing: m.pricing ? { prompt: Number(m.pricing.prompt), completion: Number(m.pricing.completion) } : undefined,
    }));
  }
}
