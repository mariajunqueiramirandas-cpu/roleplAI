import { describe, expect, test } from "bun:test";
import { getHead } from "../src/db/lineage.ts";
import { MockProvider } from "../src/llm/mock.ts";
import type { ChatRequest, ChatResponse } from "../src/llm/types.ts";
import { unextractedTurns } from "../src/memory/episodes.ts";
import { factsAbout, insertFact } from "../src/memory/facts.ts";
import { getEntity, holding } from "../src/state/read.ts";
import { currentOrigin } from "../src/turn/pipeline.ts";
import { GOLD, PLAYER } from "../src/util.ts";
import { newGame } from "./helpers.ts";

/** The offline provider, with per-task overrides. */
class Custom extends MockProvider {
  constructor(private over: Partial<Record<string, (req: ChatRequest, n: number) => Partial<ChatResponse> | null>>) {
    super();
  }
  counts: Record<string, number> = {};
  requests: ChatRequest[] = [];
  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.requests.push(req);
    const n = (this.counts[req.task] = (this.counts[req.task] ?? 0) + 1);
    const base = await super.chat(req);
    const o = this.over[req.task]?.(req, n);
    return o ? { ...base, ...o } : base;
  }
}
const call = (name: string, args: unknown) => ({ id: `c_${name}`, name, arguments: JSON.stringify(args) });

describe("turn pipeline", () => {
  test("a turn runs end to end and is remembered in the background", async () => {
    const g = await newGame();
    const r = await g.play("I walk to The Rusty Anvil.");
    expect(r.turn).toBe(getHead(g.db));
    expect(getEntity(g.db, PLAYER)!.location).toBe("place_rusty_anvil");
    expect(r.linked["The Rusty Anvil"]).toBe("place_rusty_anvil");
    expect(r.planner!.text).toContain("PLAYER INPUT");
    expect(r.narrator!.text).toContain("RESOLVED OUTCOME");
    await g.idle();
    expect(unextractedTurns(g.db)).toHaveLength(0);
    expect(g.reports[0].turn).toBe(r.turn!);
    expect(g.db.query("SELECT COUNT(*) n FROM llm_calls WHERE role = 'narrator'").get()).toEqual({ n: 1 });
  });

  test("invalid changes go back to the planner once as the truth, not as an error", async () => {
    const p = new Custom({
      plan: () => ({ toolCalls: [call("transfer", { from: "player", to: "npc_mira", item: "gold", quantity: 9999 })] }),
    });
    const g = await newGame({ provider: p });
    const gold = holding(g.db, PLAYER, GOLD);
    const r = await g.play("I give Mira all the gold in the world.");
    expect(r.rejections[0].reason).toContain(`has ${gold} gold, not 9999`);
    const replan = p.requests.filter((q) => q.task === "plan");
    expect(replan).toHaveLength(2);
    expect(String(replan[1].messages.at(-1)!.content)).toContain("Here is the truth");
    // Still invalid after the second try: dropped, with a note to the narrator.
    expect(r.dropped).toHaveLength(1);
    expect(r.narrator!.text).toContain("did NOT happen");
    expect(holding(g.db, PLAYER, GOLD)).toBe(gold);
    expect(r.prose.length).toBeGreaterThan(0);
  });

  test("invalid tool arguments get one repair call", async () => {
    const p = new Custom({
      plan: () => ({ toolCalls: [call("adjust", { entity: "player", stat: "hp", direction: "sideways", severity: "minor" })] }),
      plan_repair: () => ({ toolCalls: [call("adjust", { entity: "player", stat: "hp", direction: "down", severity: "minor" })] }),
    });
    const g = await newGame({ provider: p });
    const r = await g.play("I trip.");
    expect(p.counts.plan_repair).toBe(1);
    expect(r.plan[0]).toMatchObject({ tool: "adjust", direction: "down" });
    expect(r.mechanics[0]).toContain("HP");
  });

  test("planned facts that contradict canon are rejected and the planner retries", async () => {
    const p = new Custom({
      plan: (req) => ({
        toolCalls: [call("record_fact", { subject: "place_ruined_tower", statement: (req.meta as any).rejections ? "The Ruined Tower's stair is collapsed." : "The Ruined Tower has five floors." })],
      }),
    });
    const g = await newGame({ provider: p });
    insertFact(g.db, { subject: "place_ruined_tower", statement: "The Ruined Tower has three floors.", authority: "canon", knownBy: ["*"] }, currentOrigin(g.ctx));
    const r = await g.play("I ask about the tower.");
    expect(r.rejections[0].reason).toContain("contradicts canon");
    const facts = factsAbout(g.db, "place_ruined_tower").map((f) => f.statement);
    expect(facts).toContain("The Ruined Tower's stair is collapsed.");
    expect(facts).not.toContain("The Ruined Tower has five floors.");
  });

  test("prose is verified before the player sees it and regenerated once with the problems", async () => {
    const p = new Custom({
      narrate: (_req, n) => ({ content: n === 1 ? "You count your purse: you now have 999 gold." : "You count your purse." }),
    });
    const g = await newGame({ provider: p });
    const r = await g.play("I count my gold.");
    expect(r.verification.regenerated).toBe(true);
    expect(r.verification.problems[0]).toContain("999 gold");
    expect(r.prose).toBe("You count your purse.");
    expect(String(p.requests.filter((q) => q.task === "narrate")[1].messages.at(-1)!.content)).toContain("PROBLEMS WITH YOUR LAST DRAFT");
  });

  test("the narrator sees the state after this turn's changes", async () => {
    const g = await newGame();
    const gold = holding(g.db, PLAYER, GOLD);
    await g.play("I walk to The Rusty Anvil.");
    const r = await g.play("I buy a lantern for 5 gold from Mira.");
    expect(r.narrator!.text).toContain(`Gold ${gold - 5}`);
    expect(r.planner!.text).toContain(`Gold ${gold}`);
  });

  test("out-of-character questions are answered without a turn", async () => {
    const g = await newGame();
    const head = g.head;
    const r = await g.play("(( how do checks work?");
    expect(r.ooc).toBe(true);
    expect(r.turn).toBeNull();
    expect(g.head).toBe(head);
  });

  test("no gap in memory: a turn waits when extraction falls behind the verbatim window", async () => {
    const p = new Custom({});
    const slow = p.chat.bind(p);
    p.chat = async (req) => {
      if (req.task === "extract") await new Promise((r) => setTimeout(r, 30));
      return slow(req);
    };
    const g = await newGame({ provider: p, config: { extractionLag: 2 } });
    for (let i = 0; i < 5; i++) {
      await g.play("I look around.");
      expect(unextractedTurns(g.db).length).toBeLessThanOrEqual(2);
    }
    await g.idle();
    expect(unextractedTurns(g.db)).toHaveLength(0);
  });

  test("the planner can be skipped on pure dialogue (latency option)", async () => {
    const p = new Custom({});
    const g = await newGame({ provider: p, config: { components: { skipPlannerOnDialogue: true } } as any });
    await g.play('"Good morning, Mira."');
    expect(p.counts.plan ?? 0).toBe(0);
    expect(p.counts.narrate).toBe(1);
  });
});
