import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Config, Role } from "../config.ts";
import type { DB } from "../db/db.ts";
import { now } from "../util.ts";
import type { ChatMessage, ChatRequest, ChatResponse, ModelInfo, Provider, ToolDef, Usage } from "./types.ts";
import { textOf } from "./types.ts";

export interface CallLog {
  role: Role;
  model: string;
  provider?: string;
  usage: Usage;
  latencyMs: number;
  repaired: boolean;
  failed: boolean;
  error?: string;
}

/** What each role needs from its model. Startup fails fast without it. */
const ROLE_NEEDS: Partial<Record<Role, string[]>> = {
  planner: ["tools"],
  extractor: ["response_format"],
  verifier: ["response_format"],
  fast: ["response_format"],
};

export function extractJson(text: string): unknown {
  const t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : t;
  try {
    return JSON.parse(body);
  } catch {
    const start = body.search(/[[{]/);
    const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
    if (start >= 0 && end > start) return JSON.parse(body.slice(start, end + 1));
    throw new Error("Response is not JSON");
  }
}

export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const s = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete s.$schema;
  return s;
}

/**
 * The one door to every model. Calls go through a named role, whose model comes from
 * config. Every call is logged to `llm_calls` with tokens, cost and latency.
 */
export class LLM {
  db: DB | null = null;
  turn: number | null = null;
  private modelInfo = new Map<string, ModelInfo>();
  readonly calls: CallLog[] = [];

  constructor(
    readonly provider: Provider,
    readonly config: Config,
  ) {}

  attach(db: DB) {
    this.db = db;
    return this;
  }

  private log(c: CallLog) {
    this.calls.push(c);
    if (!this.db) return;
    this.db
      .query(
        `INSERT INTO llm_calls(at, turn, role, model, provider, tokens_in, tokens_out, tokens_cached, cost, latency_ms, repaired, failed, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        now(),
        this.turn,
        c.role,
        c.model,
        c.provider ?? null,
        c.usage.promptTokens,
        c.usage.completionTokens,
        c.usage.cachedTokens,
        c.usage.cost,
        c.latencyMs,
        c.repaired ? 1 : 0,
        c.failed ? 1 : 0,
        c.error ?? null,
      );
  }

  contextLength(role: Role): number {
    return this.modelInfo.get(this.config.roles[role].model)?.contextLength ?? 0;
  }

  /** Fetch model capabilities (cached on disk for a day) and fail fast on a bad role config. */
  async checkCapabilities(opts: { strict?: boolean } = {}): Promise<string[]> {
    const problems: string[] = [];
    let models: ModelInfo[] = [];
    const cache = join(this.config.cacheDir, `models-${this.provider.name}.json`);
    try {
      if (existsSync(cache) && Date.now() - JSON.parse(readFileSync(cache, "utf8")).at < 86_400_000) {
        models = JSON.parse(readFileSync(cache, "utf8")).models;
      } else {
        models = await this.provider.models();
        mkdirSync(this.config.cacheDir, { recursive: true });
        writeFileSync(cache, JSON.stringify({ at: Date.now(), models }));
      }
    } catch (e) {
      problems.push(`Could not fetch the model catalog: ${(e as Error).message}`);
      if (opts.strict) throw new Error(problems.join("\n"));
      return problems;
    }
    for (const m of models) this.modelInfo.set(m.id, m);
    for (const [role, needs] of Object.entries(ROLE_NEEDS) as [Role, string[]][]) {
      const id = this.config.roles[role].model;
      const info = this.modelInfo.get(id);
      if (!info) {
        problems.push(`${role}: model '${id}' is not in the catalog`);
        continue;
      }
      for (const n of needs) {
        const alt = n === "response_format" ? ["response_format", "structured_outputs"] : [n];
        if (!alt.some((a) => info.supportedParameters.includes(a))) problems.push(`${role}: '${id}' does not support ${n}`);
      }
    }
    if (problems.length && opts.strict) throw new Error(`Model configuration problems:\n- ${problems.join("\n- ")}`);
    return problems;
  }

  private request(role: Role, task: string, messages: ChatMessage[], extra: Partial<ChatRequest> = {}): ChatRequest {
    const rc = this.config.roles[role];
    return {
      role,
      task,
      model: rc.model,
      fallbacks: rc.fallbacks,
      messages,
      temperature: rc.temperature,
      maxTokens: rc.maxTokens,
      providerOrder: rc.providerOrder,
      quantizations: rc.quantizations,
      ...extra,
    };
  }

  private async send(req: ChatRequest, repaired = false): Promise<ChatResponse> {
    const t0 = performance.now();
    try {
      const r = await this.provider.chat(req);
      this.log({ role: req.role, model: r.model, provider: r.provider, usage: r.usage, latencyMs: Math.round(performance.now() - t0), repaired, failed: false });
      this.calibrate(req, r.usage.promptTokens);
      return r;
    } catch (e) {
      this.log({
        role: req.role,
        model: req.model,
        usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
        latencyMs: Math.round(performance.now() - t0),
        repaired,
        failed: true,
        error: (e as Error).message,
      });
      throw e;
    }
  }

  /** Learn chars-per-token per model from the real counts OpenRouter returns. */
  private calibrate(req: ChatRequest, promptTokens: number) {
    if (!this.db || !promptTokens) return;
    const chars = req.messages.reduce((s, m) => s + textOf(m.content).length, 0) + JSON.stringify(req.tools ?? []).length;
    const ratio = chars / promptTokens;
    if (!isFinite(ratio) || ratio <= 0) return;
    this.db
      .query(
        `INSERT INTO token_calibration(model, ratio, samples) VALUES (?, ?, 1)
         ON CONFLICT(model) DO UPDATE SET ratio = (ratio * samples + excluded.ratio) / (samples + 1), samples = MIN(samples + 1, 50)`,
      )
      .run(req.model, ratio);
  }

  charsPerToken(role: Role): number {
    if (!this.db) return 3.6;
    const r = this.db.query("SELECT ratio FROM token_calibration WHERE model = ?").get(this.config.roles[role].model) as {
      ratio: number;
    } | null;
    return r?.ratio ?? 3.6;
  }

  async text(role: Role, task: string, messages: ChatMessage[], meta?: Record<string, unknown>): Promise<string> {
    const r = await this.send(this.request(role, task, messages, { meta }));
    return r.content.trim();
  }

  async withTools(role: Role, task: string, messages: ChatMessage[], tools: ToolDef[], meta?: Record<string, unknown>): Promise<ChatResponse> {
    return this.send(this.request(role, task, messages, { tools, meta }));
  }

  /**
   * Structured output: JSON Schema from Zod, always validated with Zod. On failure,
   * one repair call with the errors; then the role's fallback model; then `fallback`.
   */
  async structured<T extends z.ZodType>(
    role: Role,
    task: string,
    messages: ChatMessage[],
    schema: T,
    opts: { meta?: Record<string, unknown>; fallback?: z.infer<T>; name?: string } = {},
  ): Promise<z.infer<T>> {
    const jsonSchema = { name: opts.name ?? task.replace(/[^a-zA-Z0-9_]/g, "_"), schema: jsonSchemaOf(schema) };
    const attempt = async (model: string | undefined, msgs: ChatMessage[], repaired: boolean) => {
      const req = this.request(role, task, msgs, { jsonSchema, meta: opts.meta });
      if (model) {
        req.model = model;
        req.fallbacks = undefined;
      }
      const r = await this.send(req, repaired);
      let parsed: unknown;
      try {
        parsed = extractJson(r.content);
      } catch (e) {
        return { ok: false as const, raw: r.content, errors: [(e as Error).message] };
      }
      const v = schema.safeParse(parsed);
      if (v.success) return { ok: true as const, value: v.data as z.infer<T> };
      return { ok: false as const, raw: r.content, errors: v.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
    };

    let errorText = "";
    try {
      const first = await attempt(undefined, messages, false);
      if (first.ok) return first.value;
      const repairMsgs: ChatMessage[] = [
        ...messages,
        { role: "assistant", content: first.raw },
        {
          role: "user",
          content: `Your JSON did not match the schema. Errors:\n- ${first.errors.join("\n- ")}\nReturn the corrected JSON only.`,
        },
      ];
      const second = await attempt(undefined, repairMsgs, true);
      if (second.ok) return second.value;
      errorText = second.errors.join("; ");
      const fb = this.config.roles[role].fallbacks?.[0];
      if (fb) {
        const third = await attempt(fb, messages, true);
        if (third.ok) return third.value;
        errorText = third.errors.join("; ");
      }
    } catch (e) {
      errorText = (e as Error).message;
    }
    if (opts.fallback !== undefined) return opts.fallback;
    throw new Error(`${role}/${task}: structured output failed: ${errorText}`);
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const model = this.config.roles.embed.model;
    const t0 = performance.now();
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 64) {
      const batch = texts.slice(i, i + 64);
      try {
        const r = await this.provider.embed(model, batch, this.config.embedDims);
        out.push(...r.vectors);
        this.log({ role: "embed", model, usage: r.usage, latencyMs: Math.round(performance.now() - t0), repaired: false, failed: false });
      } catch (e) {
        this.log({ role: "embed", model, usage: zero(), latencyMs: Math.round(performance.now() - t0), repaired: false, failed: true, error: (e as Error).message });
        throw e;
      }
    }
    return out;
  }

  async rerank(query: string, docs: string[]): Promise<{ index: number; score: number }[] | null> {
    if (!docs.length) return [];
    const model = this.config.roles.rerank.model;
    const t0 = performance.now();
    try {
      const r = await this.provider.rerank(model, query, docs);
      this.log({ role: "rerank", model, usage: r.usage, latencyMs: Math.round(performance.now() - t0), repaired: false, failed: false });
      return r.results;
    } catch (e) {
      this.log({ role: "rerank", model, usage: zero(), latencyMs: Math.round(performance.now() - t0), repaired: false, failed: true, error: (e as Error).message });
      return null; // caller falls back to its own ordering
    }
  }

  totals() {
    const by: Record<string, { calls: number; tokensIn: number; tokensOut: number; cost: number; ms: number; failed: number }> = {};
    for (const c of this.calls) {
      const b = (by[c.role] ??= { calls: 0, tokensIn: 0, tokensOut: 0, cost: 0, ms: 0, failed: 0 });
      b.calls++;
      b.tokensIn += c.usage.promptTokens;
      b.tokensOut += c.usage.completionTokens;
      b.cost += c.usage.cost;
      b.ms += c.latencyMs;
      b.failed += c.failed ? 1 : 0;
    }
    return by;
  }
}

function zero(): Usage {
  return { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 };
}
