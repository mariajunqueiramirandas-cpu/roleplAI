import { existsSync, readFileSync } from "node:fs";

export const ROLES = ["narrator", "planner", "extractor", "verifier", "fast", "embed", "rerank"] as const;
export type Role = (typeof ROLES)[number];

export interface RoleConfig {
  model: string;
  /** OpenRouter `models` fallback list. */
  fallbacks?: string[];
  temperature?: number;
  maxTokens?: number;
  /** Pin providers for consistency (OpenRouter provider.order). */
  providerOrder?: string[];
  /** Exclude heavily quantized providers (OpenRouter provider.quantizations). */
  quantizations?: string[];
}

export interface Components {
  graph: boolean;
  keyword: boolean;
  vector: boolean;
  rerank: boolean;
  verify: boolean;
  reflections: boolean;
  consolidation: boolean;
  extraction: boolean;
  /** Skip the planner on pure-dialogue turns (latency option). */
  skipPlannerOnDialogue: boolean;
}

export interface Config {
  provider: "openrouter" | "mock";
  roles: Record<Role, RoleConfig>;
  embedDims: number;
  /** Target input tokens per prompt (capped by the model's context length). */
  contextBudget: number;
  /** Recent turns kept word for word in every prompt. */
  recentTurns: number;
  /** The must-have subset of recent turns when the budget is tight. */
  mustHaveRecentTurns: number;
  snapshotEvery: number;
  permadeath: boolean;
  components: Components;
  retrieval: {
    perList: number;
    rerankTop: number;
    maxPerSubject: number;
    graphHops: number;
    rrfK: number;
    /** Recency half-life in in-game minutes, for importance 5. */
    recencyHalfLife: number;
    sceneBoost: number;
    threadBoost: number;
  };
  consolidation: {
    everyTurns: number;
    chapterScenes: number;
    arcChapters: number;
    sagaArcs: number;
    reflectionMinEpisodes: number;
    staleThreadTurns: number;
    duplicateThreshold: number;
  };
  /** Turns of unextracted memory tolerated before the next turn waits. */
  extractionLag: number;
  cacheDir: string;
  attributes: string[];
}

/**
 * Default models are a starting point: Phase 1 picks them with the evals from the
 * live catalog. `roleplai models` checks them against OpenRouter.
 */
export const DEFAULT_CONFIG: Config = {
  provider: "openrouter",
  roles: {
    narrator: { model: "anthropic/claude-sonnet-5.5", fallbacks: ["anthropic/claude-opus-5.5"], temperature: 0.9, maxTokens: 900 },
    planner: { model: "anthropic/claude-sonnet-5.5", fallbacks: ["anthropic/claude-opus-5.5"], temperature: 0.2, maxTokens: 1500 },
    extractor: { model: "anthropic/claude-sonnet-5.5", fallbacks: ["anthropic/claude-opus-5.5"], temperature: 0, maxTokens: 2500 },
    verifier: { model: "anthropic/claude-haiku-5.5", fallbacks: ["anthropic/claude-sonnet-5.5"], temperature: 0, maxTokens: 800 },
    fast: { model: "anthropic/claude-haiku-5.5", fallbacks: ["anthropic/claude-sonnet-5.5"], temperature: 0, maxTokens: 500 },
    embed: { model: "qwen/qwen3-embedding-8b" },
    rerank: { model: "cohere/rerank-v3.5" },
  },
  embedDims: 1024,
  contextBudget: 16000,
  recentTurns: 8,
  mustHaveRecentTurns: 4,
  snapshotEvery: 20,
  permadeath: false,
  components: {
    graph: true,
    keyword: true,
    vector: true,
    rerank: true,
    verify: true,
    reflections: true,
    consolidation: true,
    extraction: true,
    skipPlannerOnDialogue: false,
  },
  retrieval: {
    perList: 40,
    rerankTop: 100,
    maxPerSubject: 4,
    graphHops: 2,
    rrfK: 60,
    recencyHalfLife: 1440 * 3,
    sceneBoost: 1.5,
    threadBoost: 1.3,
  },
  consolidation: {
    everyTurns: 25,
    chapterScenes: 8,
    arcChapters: 5,
    sagaArcs: 5,
    reflectionMinEpisodes: 3,
    staleThreadTurns: 60,
    duplicateThreshold: 0.85,
  },
  extractionLag: 8,
  cacheDir: ".roleplai",
  attributes: ["body", "agility", "mind", "presence"],
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function merge<T>(base: T, over: DeepPartial<T> | undefined): T {
  if (!over) return base;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === "object" && !Array.isArray(v) && typeof (base as any)[k] === "object") out[k] = merge((base as any)[k], v as any);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Defaults ← roleplai.config.json ← overrides. Environment can pick the provider. */
export function loadConfig(overrides?: DeepPartial<Config>, path = "roleplai.config.json"): Config {
  let file: DeepPartial<Config> | undefined;
  if (existsSync(path)) file = JSON.parse(readFileSync(path, "utf8"));
  let cfg = merge(merge(DEFAULT_CONFIG, file), overrides);
  if (process.env.ROLEPLAI_PROVIDER === "mock" || process.env.ROLEPLAI_PROVIDER === "openrouter") {
    cfg = { ...cfg, provider: process.env.ROLEPLAI_PROVIDER };
  }
  return cfg;
}

export type { DeepPartial };
