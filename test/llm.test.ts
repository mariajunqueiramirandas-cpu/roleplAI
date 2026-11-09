import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { DEFAULT_CONFIG, loadConfig, type Config } from "../src/config.ts";
import { openDb } from "../src/db/db.ts";
import { extractJson, LLM } from "../src/llm/client.ts";
import { MockProvider } from "../src/llm/mock.ts";
import { OpenRouterProvider } from "../src/llm/openrouter.ts";
import type { ChatRequest, ChatResponse, Provider } from "../src/llm/types.ts";
import { fitDims } from "../src/llm/types.ts";

class Scripted extends MockProvider {
  replies: string[] = [];
  seen: ChatRequest[] = [];
  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.seen.push(req);
    const content = this.replies.shift() ?? "{}";
    return { content, toolCalls: [], usage: { promptTokens: 100, completionTokens: 10, cachedTokens: 0, cost: 0.001 }, model: req.model };
  }
}

const cfg = (): Config => loadConfig({ provider: "mock" }, "/nonexistent.json");
const Schema = z.object({ n: z.number(), word: z.string() });

describe("structured output", () => {
  test("validates with Zod and repairs once with the errors", async () => {
    const p = new Scripted();
    p.replies = ['{"n": "seven"}', '```json\n{"n": 7, "word": "ok"}\n```'];
    const llm = new LLM(p, cfg()).attach(openDb(":memory:"));
    const r = await llm.structured("fast", "t", [{ role: "user", content: "x" }], Schema);
    expect(r).toEqual({ n: 7, word: "ok" });
    expect(p.seen).toHaveLength(2);
    expect(String(p.seen[1].messages.at(-1)!.content)).toContain("n:");
    expect(p.seen[0].jsonSchema!.schema).toHaveProperty("properties");
    const log = llm.db!.query("SELECT role, repaired, cost FROM llm_calls ORDER BY id").all();
    expect(log).toEqual([
      { role: "fast", repaired: 0, cost: 0.001 },
      { role: "fast", repaired: 1, cost: 0.001 },
    ]);
  });

  test("after the repair fails it tries the fallback model, then the fallback value", async () => {
    const p = new Scripted();
    p.replies = ["nope", "still nope", "{}"];
    const llm = new LLM(p, cfg());
    const r = await llm.structured("planner", "t", [{ role: "user", content: "x" }], Schema, { fallback: { n: 0, word: "fallback" } });
    expect(r.word).toBe("fallback");
    expect(p.seen[2].model).toBe(DEFAULT_CONFIG.roles.planner.fallbacks![0]);
    await expect(llm.structured("planner", "t", [{ role: "user", content: "x" }], Schema)).rejects.toThrow("structured output failed");
  });

  test("extractJson tolerates fences and surrounding text", () => {
    expect(extractJson('Sure! {"a": 1} hope that helps')).toEqual({ a: 1 });
    expect(() => extractJson("no json here")).toThrow();
  });

  test("token calibration learns chars per token from real counts", async () => {
    const p = new Scripted();
    p.replies = ['{"n":1,"word":"a"}'];
    const llm = new LLM(p, cfg()).attach(openDb(":memory:"));
    await llm.structured("fast", "t", [{ role: "user", content: "x".repeat(720) }], Schema);
    expect(llm.charsPerToken("fast")).toBeCloseTo(7.2, 0);
  });
});

describe("capabilities", () => {
  test("startup fails fast when a role's model lacks what the role needs", async () => {
    const p: Provider = Object.assign(new MockProvider(), {
      models: async () => [{ id: DEFAULT_CONFIG.roles.planner.model, contextLength: 1000, supportedParameters: ["response_format"] }],
    });
    const c = { ...cfg(), cacheDir: `/tmp/roleplai-test-${Date.now()}` };
    const llm = new LLM(p, c);
    await expect(llm.checkCapabilities({ strict: true })).rejects.toThrow("planner: 'anthropic/claude-sonnet-5.5' does not support tools");
  });

  test("the offline provider passes the check and reports context length", async () => {
    const c = { ...cfg(), cacheDir: `/tmp/roleplai-test-${Date.now()}-b` };
    const llm = new LLM(new MockProvider(), c);
    expect(await llm.checkCapabilities()).toEqual([]);
    expect(llm.contextLength("planner")).toBe(200_000);
  });
});

describe("OpenRouter client", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function capture(response: unknown) {
    const calls: { url: string; body: any; headers: any }[] = [];
    globalThis.fetch = (async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
      return new Response(JSON.stringify(response), { status: 200 });
    }) as any;
    return calls;
  }

  test("chat: routing, fallbacks, cache breakpoints, tool calls and usage", async () => {
    const calls = capture({
      model: "anthropic/claude-sonnet-5.5",
      provider: "Anthropic",
      choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "move", arguments: '{"entity":"player","to":"x"}' } }] } }],
      usage: { prompt_tokens: 1200, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 1000 }, cost: 0.004 },
    });
    const p = new OpenRouterProvider("sk-test", "https://openrouter.test/api/v1");
    const r = await p.chat({
      role: "planner",
      task: "plan",
      model: "anthropic/claude-sonnet-5.5",
      fallbacks: ["openai/gpt-5"],
      messages: [{ role: "system", content: [{ type: "text", text: "rules", cache: true }, { type: "text", text: "scene" }] }, { role: "user", content: "go" }],
      tools: [{ type: "function", function: { name: "move", description: "", parameters: {} } }],
      providerOrder: ["Anthropic"],
      meta: { secret: "never sent" },
    });
    const b = calls[0].body;
    expect(calls[0].url).toBe("https://openrouter.test/api/v1/chat/completions");
    expect(calls[0].headers.Authorization).toBe("Bearer sk-test");
    expect(b.models).toEqual(["anthropic/claude-sonnet-5.5", "openai/gpt-5"]);
    expect(b.provider).toEqual({ require_parameters: true, order: ["Anthropic"] });
    expect(b.messages[0].content[0]).toEqual({ type: "text", text: "rules", cache_control: { type: "ephemeral" } });
    expect(b.messages[0].content[1].cache_control).toBeUndefined();
    expect(JSON.stringify(b)).not.toContain("never sent");
    expect(r.toolCalls[0]).toEqual({ id: "c1", name: "move", arguments: '{"entity":"player","to":"x"}' });
    expect(r.usage).toEqual({ promptTokens: 1200, completionTokens: 30, cachedTokens: 1000, cost: 0.004 });
  });

  test("models that cache automatically get plain text content", async () => {
    const calls = capture({ choices: [{ message: { content: "hi" } }] });
    await new OpenRouterProvider("k", "https://x/api/v1").chat({
      role: "narrator",
      task: "n",
      model: "openai/gpt-5",
      messages: [{ role: "system", content: [{ type: "text", text: "a", cache: true }, { type: "text", text: "b" }] }],
      jsonSchema: { name: "s", schema: { type: "object" } },
    });
    expect(calls[0].body.messages[0].content).toBe("a\n\nb");
    expect(calls[0].body.response_format.type).toBe("json_schema");
  });

  test("embeddings are truncated to the stored dimension and renormalised", async () => {
    capture({ data: [{ index: 0, embedding: [3, 4, 12] }] });
    const r = await new OpenRouterProvider("k", "https://x/api/v1").embed("qwen/qwen3-embedding-8b", ["hi"], 2);
    expect(r.vectors[0][0]).toBeCloseTo(0.6);
    expect(r.vectors[0][1]).toBeCloseTo(0.8);
    expect(fitDims([1, 0], 4)).toEqual([1, 0, 0, 0]);
  });

  test("without a key it says so", async () => {
    await expect(new OpenRouterProvider("", "https://x").chat({ role: "fast", task: "t", model: "m", messages: [] })).rejects.toThrow("OPENROUTER_API_KEY");
  });

  test("a failing reranker falls back to the caller's own order", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 404 })) as any;
    const llm = new LLM(new OpenRouterProvider("k", "https://x"), cfg());
    expect(await llm.rerank("q", ["a"])).toBeNull();
    expect(llm.calls.at(-1)!.failed).toBe(true);
  });
});
