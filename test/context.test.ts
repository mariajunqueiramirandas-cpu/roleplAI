import { describe, expect, test } from "bun:test";
import { buildContext, type Understanding } from "../src/context/builder.ts";
import { estimateTokens, fitText, summaryOf } from "../src/context/tokens.ts";
import { runComponentEvals } from "../src/eval/components.ts";
import { insertFact } from "../src/memory/facts.ts";
import { diversify, recencyFactor, retrieve, rrf, type Scored } from "../src/retrieval/retrieve.ts";
import { currentOrigin } from "../src/turn/pipeline.ts";
import { PLAYER } from "../src/util.ts";
import { applyPlan, newGame } from "./helpers.ts";

const U: Understanding = { intent: "action", mentions: [], target: null, refersToPast: false, queries: [] };

describe("retrieval pieces", () => {
  test("reciprocal rank fusion rewards agreement between lists", () => {
    const f = rrf([["a", "b", "c"], ["b", "a"], ["b"]]);
    expect([...f.entries()].sort((x, y) => y[1] - x[1]).map(([k]) => k)).toEqual(["b", "a", "c"]);
  });

  test("diversify caps items per subject and drops repeated text", () => {
    const items = [
      ...Array.from({ length: 6 }, (_, i) => ({ subject: "npc_mira", score: 10 - i, text: `Mira fact ${["one", "two", "three", "four", "five", "six"][i]}` })),
      { subject: null, score: 3, text: "Player: I wait.\nGM: You wait." },
      { subject: null, score: 2.9, text: "Player: I wait.\nGM: You wait." },
      { subject: "npc_vyr", score: 1, text: "Vyr smiles." },
    ];
    const out = diversify(items, 4);
    expect(out.filter((i) => i.subject === "npc_mira")).toHaveLength(4);
    expect(out.filter((i) => i.text.includes("wait"))).toHaveLength(1);
    expect(out.at(-1)!.subject).toBe("npc_vyr");
  });

  test("recency decays more slowly for important memories", () => {
    const day = 1440;
    expect(recencyFactor(10 * day, 0, 9, 3 * day)).toBeGreaterThan(recencyFactor(10 * day, 0, 2, 3 * day));
    expect(recencyFactor(0, 0, 5, day)).toBeCloseTo(1);
  });

  test("keyword search finds invented names; closed facts only for questions about the past", async () => {
    const g = await newGame();
    const o = currentOrigin(g.ctx);
    insertFact(g.db, { subject: "place_ruined_tower", statement: "Xal'thuun, a bound spirit, sleeps beneath the Ruined Tower.", authority: "canon", importance: 8, knownBy: ["*"] }, o);
    const r = await retrieve(g.ctx, { queries: ["Who is Xal'thuun?"], sceneEntities: [], linked: [], refersToPast: false, excludeTurns: [] });
    expect(r[0].text).toContain("Xal'thuun");
    expect(r[0].sources).toContain("keyword");

    applyPlan(g, [{ tool: "move", entity: "npc_mira", to: "place_sleeping_fox" }]);
    applyPlan(g, [{ tool: "move", entity: "npc_mira", to: "place_oakvale" }]);
    const now = await retrieve(g.ctx, { queries: ["Where is Mira?"], sceneEntities: ["npc_mira"], linked: ["npc_mira"], refersToPast: false, excludeTurns: [] });
    expect(now.some((m) => m.text === "Mira is at The Sleeping Fox.")).toBe(false);
    const past = await retrieve(g.ctx, { queries: ["Where was Mira before?"], sceneEntities: ["npc_mira"], linked: ["npc_mira"], refersToPast: true, excludeTurns: [] });
    const old = past.find((m) => m.text === "Mira is at The Sleeping Fox.");
    expect(old?.validTo).not.toBeNull();
  });

  test("component evals run end to end (retrieval recall, linking, contradiction labels)", async () => {
    // Offline embeddings are bags of words: paraphrase queries miss. This checks the harness, not model quality.
    const r = await runComponentEvals({ provider: "mock" });
    expect(r.retrieval.ranks.slice(0, 3)).toEqual([1, 1, 2]);
    expect(r.linking.accuracy).toBeGreaterThanOrEqual(0.9);
    expect(r.contradiction.n).toBe(6);
  });
});

describe("context builder", () => {
  async function scene() {
    const g = await newGame();
    applyPlan(g, [{ tool: "move", entity: "player", to: "place_sleeping_fox" }]);
    const memories = await retrieve(g.ctx, { queries: ["Who sold my map?", "Tomas"], sceneEntities: [PLAYER, "npc_vyr", "npc_tomas", "place_sleeping_fox"], linked: ["npc_tomas"], refersToPast: false, excludeTurns: [] });
    return { g, memories };
  }

  test("layout: cacheable prefix first, player input last; secrets marked for the planner", async () => {
    const { g, memories } = await scene();
    const b = buildContext(g.ctx, { role: "planner", input: "Who sold my map?", understanding: U, sceneEntities: [PLAYER, "npc_vyr", "npc_tomas"], linked: ["npc_tomas"], memories, stubs: [] });
    const [sys, user] = b.messages;
    expect(Array.isArray(sys.content) && sys.content[0].cache).toBe(true);
    expect(String(user.content).trim().endsWith("Plan this turn now with tool calls (or none if nothing mechanical happens).")).toBe(true);
    const text = String(user.content);
    expect(text.indexOf("SCENE")).toBeLessThan(text.indexOf("RELEVANT MEMORIES"));
    expect(text.indexOf("HARD STATE")).toBeLessThan(text.indexOf("PLAYER INPUT"));
    expect(text).toContain("[SECRET");
    expect(text).toMatch(/Vyr \[npc_vyr\]/);
  });

  test("the narrator doesn't get secrets of people outside the scene, and an NPC speaking only knows their own", async () => {
    const { g, memories } = await scene();
    const narr = buildContext(g.ctx, { role: "narrator", input: "\"Vyr, who sold my map?\"", understanding: { ...U, intent: "dialogue", target: "Vyr" }, sceneEntities: [PLAYER, "npc_vyr", "npc_tomas"], linked: ["npc_vyr"], memories, stubs: [], mechanics: [], speaker: "npc_vyr" });
    expect(narr.text).not.toContain("sold the player's map"); // Mira's secret
    expect(narr.text).not.toContain("sold the map to the Red Hands"); // Tomas's secret, unknown to Vyr
    expect(narr.text).toContain("RESOLVED OUTCOME");
  });

  test("the token budget holds, must-haves survive, and what doesn't fit is summarised first", async () => {
    const { g, memories } = await scene();
    const tight = { ...g.ctx, config: { ...g.ctx.config, contextBudget: 2000 } };
    const b = buildContext(tight, { role: "planner", input: "I look around.", understanding: U, sceneEntities: [PLAYER], linked: [], memories, stubs: [] });
    expect(b.budget).toBe(2000); // the floor that keeps the must-haves
    expect(b.tokens).toBeLessThanOrEqual(b.budget);
    expect(b.text).toContain("HARD STATE");
    expect(b.text).toContain("I look around.");
    const roomy = buildContext(g.ctx, { role: "planner", input: "I look around.", understanding: U, sceneEntities: [PLAYER], linked: [], memories, stubs: [] });
    expect(roomy.includedKeys.length).toBeGreaterThan(b.includedKeys.length);
  });

  test("token helpers", () => {
    expect(estimateTokens("x".repeat(360), 3.6)).toBe(110);
    expect(fitText("One. Two. Three. Four.", 3, 3.6).length).toBeLessThan(12);
    expect(summaryOf("First sentence here. Second one.")).toBe("First sentence here.");
  });

  test("scored items carry their sources for debugging", async () => {
    const { memories } = await scene();
    expect((memories as Scored[]).every((m) => Array.isArray(m.sources))).toBe(true);
  });
});
