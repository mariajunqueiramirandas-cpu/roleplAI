import { describe, expect, test } from "bun:test";
import { getHead, timelineTurnIds } from "../src/db/lineage.ts";
import { allOpenFacts, insertFact } from "../src/memory/facts.ts";
import { rebuildProjections, stateFingerprint } from "../src/state/projection.ts";
import { getEntity, holding } from "../src/state/read.ts";
import { currentOrigin } from "../src/turn/pipeline.ts";
import { GOLD, PLAYER } from "../src/util.ts";
import { applyPlan, newGame } from "./helpers.ts";

const PLANS: Record<string, unknown>[][] = [
  [{ tool: "move", entity: "player", to: "place_rusty_anvil" }],
  [{ tool: "transfer", from: "player", to: "npc_mira", item: "gold", quantity: 7 }],
  [{ tool: "check", description: "Haggle", attribute: "presence", difficulty: "medium", onSuccess: [{ tool: "transfer", from: "world", to: "player", item: "gold", reward: "small" }], onFailure: [{ tool: "adjust", entity: "player", stat: "hp", direction: "down", severity: "minor" }] }],
  [{ tool: "add_status", entity: "player", label: "bleeding", durationMinutes: 240, effects: [{ type: "periodic", stat: "hp", amount: -1, everyMinutes: 30 }] }],
  [{ tool: "advance_time", minutes: 90 }],
  [{ tool: "create", kind: "npc", name: "Old Bren", description: "A ferryman." }, { tool: "move", entity: "Old Bren", to: "place_oakvale" }],
  [{ tool: "thread", status: "open", kind: "quest", title: "Ferry across", entities: ["Old Bren"] }],
  [{ tool: "set_alive", entity: "npc_tomas", alive: false, cause: "a knife in the dark" }],
  [{ tool: "advance_time", span: "hours" }],
  [{ tool: "adjust", entity: "player", stat: "xp", direction: "up", reward: "huge" }],
];

describe("event log and replay", () => {
  test("replaying the log rebuilds identical state, with or without snapshots", async () => {
    const g = await newGame({ config: { snapshotEvery: 3 } });
    for (let i = 0; i < 25; i++) applyPlan(g, PLANS[i % PLANS.length], i + 1);
    const live = stateFingerprint(g.db);
    expect(g.db.query("SELECT COUNT(*) n FROM snapshots").get()).not.toEqual({ n: 0 });
    rebuildProjections(g.db, { useSnapshots: true });
    expect(stateFingerprint(g.db)).toBe(live);
    rebuildProjections(g.db, { useSnapshots: false });
    expect(stateFingerprint(g.db)).toBe(live);
  });

  test("events are append-only", async () => {
    const g = await newGame();
    const before = g.db.query("SELECT id, payload FROM events ORDER BY id").all();
    applyPlan(g, PLANS[1]);
    const after = g.db.query("SELECT id, payload FROM events ORDER BY id").all();
    expect(after.slice(0, before.length)).toEqual(before);
  });
});

describe("branches", () => {
  test("rewind, act, and switch between timelines: state is rebuilt exactly", async () => {
    const g = await newGame({ config: { snapshotEvery: 2 } });
    for (let i = 0; i < 6; i++) applyPlan(g, PLANS[i], i + 1);
    const forkAt = g.head;
    const atFork = stateFingerprint(g.db);
    for (let i = 6; i < 10; i++) applyPlan(g, PLANS[i], i + 1);
    const tipA = g.head;
    const stateA = stateFingerprint(g.db);
    expect(getEntity(g.db, "npc_tomas")!.alive).toBe(0);

    await g.rewind(forkAt);
    expect(stateFingerprint(g.db)).toBe(atFork);
    expect(getEntity(g.db, "npc_tomas")!.alive).toBe(1);

    // Acting from an earlier turn starts a new segment.
    applyPlan(g, [{ tool: "transfer", from: "player", to: "world", item: "gold", quantity: 1 }], 99);
    const tipB = g.head;
    expect(g.branches().length).toBe(2);
    expect(timelineTurnIds(g.db)).not.toContain(tipA);
    const stateB = stateFingerprint(g.db);

    await g.rewind(tipA);
    expect(stateFingerprint(g.db)).toBe(stateA);
    await g.rewind(tipB);
    expect(stateFingerprint(g.db)).toBe(stateB);
  });

  test("memories don't leak between timelines", async () => {
    const g = await newGame();
    applyPlan(g, PLANS[0]);
    const fork = g.head;
    applyPlan(g, PLANS[1]);
    insertFact(g.db, { subject: "npc_mira", statement: "Mira told Ash the password is Moonfish.", authority: "narrative", knownBy: [PLAYER] }, currentOrigin(g.ctx));
    expect(allOpenFacts(g.db).some((f) => f.statement.includes("Moonfish"))).toBe(true);
    await g.rewind(fork);
    expect(allOpenFacts(g.db).some((f) => f.statement.includes("Moonfish"))).toBe(false);
    applyPlan(g, PLANS[4]);
    expect(allOpenFacts(g.db).some((f) => f.statement.includes("Moonfish"))).toBe(false);
  });

  test("a fact closed on one timeline stays open on another", async () => {
    const g = await newGame();
    applyPlan(g, [{ tool: "move", entity: "npc_mira", to: "place_sleeping_fox" }]);
    const fork = g.head;
    const where = () => allOpenFacts(g.db).filter((f) => f.subject === "npc_mira" && f.authority === "state").map((f) => f.statement);
    expect(where()).toEqual(["Mira is at The Sleeping Fox."]);
    applyPlan(g, [{ tool: "move", entity: "npc_mira", to: "place_oakvale" }]);
    expect(where()).toEqual(["Mira is at Oakvale."]);
    await g.rewind(fork);
    expect(where()).toEqual(["Mira is at The Sleeping Fox."]);
  });

  test("undo, save slots and load", async () => {
    const g = await newGame();
    const start = holding(g.db, PLAYER, GOLD);
    applyPlan(g, PLANS[1]);
    g.save("after-pay");
    applyPlan(g, PLANS[1]);
    expect(holding(g.db, PLAYER, GOLD)).toBe(start - 14);
    await g.undo();
    expect(holding(g.db, PLAYER, GOLD)).toBe(start - 7);
    await g.undo(5); // never goes past the world's creation
    expect(getHead(g.db)).toBe(1);
    expect(holding(g.db, PLAYER, GOLD)).toBe(start);
    await g.load("after-pay");
    expect(holding(g.db, PLAYER, GOLD)).toBe(start - 7);
  });

  test("the campaign file is the save file", async () => {
    const path = `${import.meta.dir}/../.roleplai/test-${Date.now()}.db`;
    const { Game } = await import("../src/game.ts");
    const { sampleWorld } = await import("../src/world/sample.ts");
    const { game } = await Game.create(path, { premise: "p", character: "c", fixed: sampleWorld() }, { config: { provider: "mock" }, rngSeed: 3 });
    applyPlan(game, PLANS[1]);
    const fp = stateFingerprint(game.db);
    game.close();
    const again = Game.open(path, { config: { provider: "mock" } });
    expect(stateFingerprint(again.db)).toBe(fp);
    again.close();
    const fs = await import("node:fs");
    for (const s of ["", "-wal", "-shm"]) fs.rmSync(path + s, { force: true });
  });
});
