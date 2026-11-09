import { Game } from "../src/game.ts";
import type { Config, DeepPartial } from "../src/config.ts";
import type { Provider } from "../src/llm/types.ts";
import { resolvePlan, type Resolution } from "../src/state/engine.ts";
import { ActionSchema, type Action } from "../src/state/tools.ts";
import { commitTurn } from "../src/turn/commit.ts";
import { sampleWorld } from "../src/world/sample.ts";

export async function newGame(opts: { config?: DeepPartial<Config>; provider?: Provider; seed?: number } = {}): Promise<Game> {
  const { game } = await Game.create(
    ":memory:",
    { premise: "test", character: "a sellsword named Ash", fixed: sampleWorld("Ash") },
    { config: { provider: "mock", ...(opts.config ?? {}) }, provider: opts.provider, rngSeed: opts.seed ?? 42 },
  );
  return game;
}

/** Parse loose action objects the way the planner's tool calls are parsed. */
export function actions(...raw: Record<string, unknown>[]): Action[] {
  return raw.map((r) => ActionSchema.parse(r));
}

export function resolve(game: Game, raw: Record<string, unknown>[], seed = 1): Resolution {
  return resolvePlan(game.db, actions(...raw), { seed, permadeath: game.ctx.config.permadeath });
}

/** Resolve and commit a plan as one turn, without any model calls. */
export function applyPlan(game: Game, raw: Record<string, unknown>[], seed = 1, input = "(test)") {
  const r = resolve(game, raw, seed);
  const c = commitTurn(game.db, game.ctx.config, {
    input,
    intent: {},
    plan: raw,
    outcome: { mechanics: r.mechanics, present: ["player"], sceneEntities: [], linked: [], sceneEnded: r.sceneBreak, notes: [], rejections: [], checks: [], contextKeys: [], created: [] },
    prose: "",
    resolution: r,
  });
  return { ...r, turn: c.turn };
}
