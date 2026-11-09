import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMeta } from "../src/db/db.ts";
import { parseLoCoMo, parseLongMemEval, runBenchmark } from "../src/eval/benchmarks.ts";
import { CAMPAIGN_DIR, loadCampaign, regressions, runCampaign, type EvalReport } from "../src/eval/runner.ts";
import { Game } from "../src/game.ts";
import { MockProvider } from "../src/llm/mock.ts";
import type { ChatRequest, ChatResponse } from "../src/llm/types.ts";
import { factsAbout, knowersOf } from "../src/memory/facts.ts";
import { activeThreads, getEntity, getStat, holding, traitsOf } from "../src/state/read.ts";
import { GOLD, PLAYER } from "../src/util.ts";

describe("world generation", () => {
  test("a chain of steps, each seeing the earlier ones, stored as entities, canon, secrets and threads", async () => {
    const seen: ChatRequest[] = [];
    const p = new (class extends MockProvider {
      async chat(req: ChatRequest): Promise<ChatResponse> {
        seen.push(req);
        const r = await super.chat(req);
        if (req.task === "world_consistency") r.content = JSON.stringify({ problems: [{ description: "Mira's age", fix: "Mira is fifty-two." }] });
        return r;
      }
    })();
    const { game, world } = await Game.create(":memory:", { premise: "low fantasy", character: "a sailor named Wren" }, { provider: p, config: { provider: "mock" }, rngSeed: 5 });
    const steps = seen.filter((r) => r.task.startsWith("world_")).map((r) => r.task);
    expect(steps).toEqual(["world_frame", "world_geography", "world_factions", "world_history", "world_npcs", "world_start", "world_character", "world_consistency"]);
    expect(String(seen.find((r) => r.task === "world_npcs")!.messages[1].content)).toContain("FACTIONS:");
    expect(world.frame.title).toBe("The Ember Vale");
    expect(getMeta(game.db, "frame")).toContain("World rules:");

    // Player: labels → engine numbers.
    expect(getEntity(game.db, PLAYER)!.name).toBe("Wren");
    expect(getStat(game.db, PLAYER, "body")!.value).toBe(1);
    expect(getStat(game.db, PLAYER, "hp")!.max).toBe(25);
    expect(holding(game.db, PLAYER, GOLD)).toBe(25);
    expect(traitsOf(game.db, PLAYER)).toEqual([{ label: "ex-sailor", bonus: 2 }]);
    expect(getEntity(game.db, PLAYER)!.location).toBe("place_oakvale");

    // Canon, secrets and stubs.
    const mira = factsAbout(game.db, "npc_mira");
    const secret = mira.find((f) => f.statement.includes("sold the player's map"))!;
    expect(secret.authority).toBe("canon");
    expect(knowersOf(game.db, "fact", secret.id)).toEqual(["npc_mira"]);
    expect(getEntity(game.db, "place_ruined_tower")!.stub).toBe(1);
    expect(activeThreads(game.db).map((t) => t.title).sort()).toEqual(["The Ruined Tower", "Who stole the map"]);
    expect(factsAbout(game.db, "place_ember_vale").some((f) => f.statement.includes("fifty-two"))).toBe(true);
  });
});

describe("campaign evals", () => {
  test("the scripted campaign runs and every probe type passes offline", async () => {
    const c = loadCampaign(join(CAMPAIGN_DIR, "ember-vale.json"));
    const r = await runCampaign(c, { config: { provider: "mock" } });
    const types = new Set(r.probes.map((p) => p.type));
    expect([...types].sort()).toEqual(["aliases", "branch", "consistency", "injected", "recall", "secrets", "state", "thread"]);
    for (const p of r.probes) expect({ type: p.type, pass: p.pass, detail: p.detail }).toMatchObject({ pass: true });
    expect(r.metrics.recallAt["@20"]).toBe(1);
    expect(r.metrics.proseStateMismatchesPer100).toBe(0);
  });

  test("ablations turn components off, and regressions are flagged beyond noise", async () => {
    const c = loadCampaign(join(CAMPAIGN_DIR, "ember-vale.json"));
    const off = await runCampaign(c, { config: { provider: "mock" }, ablate: ["graph", "keyword", "vector"] });
    expect(off.ablated).toEqual(["graph", "keyword", "vector"]);
    expect(off.metrics.recallAt["@20"]).toBeLessThan(1);
    const base = { metrics: { passRate: 1, recallAt: { "@5": 0.5, "@10": 1, "@20": 1 }, contradictionsPer100: 0, proseStateMismatchesPer100: 0, duplicateEntities: 0, latencyMsPerTurn: 1, tokensPerTurn: 1, costPerTurn: 0 } } as unknown as EvalReport;
    const worse = { metrics: { ...base.metrics, passRate: 0.9, duplicateEntities: 2 } } as unknown as EvalReport;
    const noisy = { metrics: { ...base.metrics, passRate: 0.99 } } as unknown as EvalReport;
    expect(regressions(base, worse)).toHaveLength(2);
    expect(regressions(base, noisy)).toEqual([]);
  });
});

describe("external benchmarks", () => {
  test("LongMemEval and LoCoMo files are parsed and run through the write path", async () => {
    const lme = [
      {
        question_id: "q1",
        question_type: "single-session-user",
        question: "What is my dog's name?",
        answer: "Biscuit",
        haystack_dates: ["2023/05/20 (Sat) 02:21", "2023/05/21 (Sun) 10:00"],
        haystack_sessions: [
          [{ role: "user", content: "My dog Biscuit chewed my shoes." }, { role: "assistant", content: "Oh no, Biscuit!" }],
          [{ role: "user", content: "I bought a new lamp." }, { role: "assistant", content: "Nice." }],
        ],
      },
    ];
    const loc = [
      {
        sample_id: "s1",
        conversation: {
          speaker_a: "Ana",
          speaker_b: "Ben",
          session_1_date_time: "1:56 pm on 8 May, 2023",
          session_1: [{ speaker: "Ana", dia_id: "D1:1", text: "I started pottery classes." }, { speaker: "Ben", dia_id: "D1:2", text: "Cool!" }],
        },
        qa: [{ question: "What classes did Ana start?", answer: "pottery", evidence: ["D1:1"], category: 1 }],
      },
    ];
    expect(parseLongMemEval(lme)[0].sessions).toHaveLength(2);
    expect(parseLoCoMo(loc)[0].sessions[0][0].speaker).toBe("user");
    const dir = mkdtempSync(join(tmpdir(), "roleplai-bench-"));
    writeFileSync(join(dir, "lme.json"), JSON.stringify(lme));
    const r = await runBenchmark("longmemeval", join(dir, "lme.json"), { config: { provider: "mock" } });
    expect(r.n).toBe(1);
    expect(r.results[0].retrieved).toBe(true);
  });
});
