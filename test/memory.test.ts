import { describe, expect, test } from "bun:test";
import { mergeDuplicates, reflect, resolveConflicts, rollSummaries } from "../src/ingest/consolidate.ts";
import { rememberFact } from "../src/ingest/contradiction.ts";
import { linkMention } from "../src/ingest/link.ts";
import { addAlias, resolveRef } from "../src/memory/entities.ts";
import { insertEpisode } from "../src/memory/episodes.ts";
import { factsAbout, getFact, insertFact, isOpen, knowersOf, sourceCount } from "../src/memory/facts.ts";
import { storeEmbeddings } from "../src/memory/vectors.ts";
import { knownTo, loadItems } from "../src/retrieval/retrieve.ts";
import { canonical } from "../src/state/read.ts";
import { currentOrigin } from "../src/turn/pipeline.ts";
import { PLAYER } from "../src/util.ts";
import { touchedStubs } from "../src/world/stubs.ts";
import { applyPlan, newGame } from "./helpers.ts";

describe("contradiction checks", () => {
  test("a narrative fact that contradicts state is rejected and logged as narrator drift", async () => {
    const g = await newGame();
    applyPlan(g, [{ tool: "move", entity: "player", to: "place_rusty_anvil" }]);
    const r = await rememberFact(g.ctx, { subject: PLAYER, statement: "Ash is at The Sleeping Fox.", authority: "narrative", knownBy: [PLAYER] }, currentOrigin(g.ctx));
    expect(r.decision.action).toBe("reject");
    expect(r.id).toBeNull();
    expect(g.db.query("SELECT statement FROM drift_log").all()).toEqual([{ statement: "Ash is at The Sleeping Fox." }]);
  });

  test("narrative vs canon: canon wins; once said, it's true", async () => {
    const g = await newGame();
    const o = currentOrigin(g.ctx);
    const canon = insertFact(g.db, { subject: "place_ruined_tower", statement: "The Ruined Tower has three floors.", authority: "canon", knownBy: ["*"] }, o);
    await storeEmbeddings(g.db, g.llm, [{ type: "fact", item: canon, text: "The Ruined Tower has three floors." }], o);
    const r = await rememberFact(g.ctx, { subject: "place_ruined_tower", statement: "The Ruined Tower has five floors.", authority: "narrative", knownBy: [PLAYER] }, o);
    expect(r.decision).toMatchObject({ action: "reject", against: canon });
    expect(isOpen(g.db, canon)).toBe(true);
  });

  test("narrative vs narrative: keep the old one and queue the conflict", async () => {
    const g = await newGame();
    const o = currentOrigin(g.ctx);
    const old = insertFact(g.db, { subject: "npc_vyr", statement: "Vyr has two daughters.", authority: "narrative", knownBy: [PLAYER] }, o);
    const r = await rememberFact(g.ctx, { subject: "npc_vyr", statement: "Vyr has four daughters.", authority: "narrative", knownBy: [PLAYER] }, o);
    expect(r.decision.action).toBe("conflict");
    expect(isOpen(g.db, old)).toBe(true);
    expect(isOpen(g.db, r.id!)).toBe(false);
    expect(await resolveConflicts(g.ctx, o)).toBe(1);
    expect(await resolveConflicts(g.ctx, o)).toBe(0); // resolved once
  });

  test("an update closes the old fact and links it to the new one; nothing is deleted", async () => {
    const g = await newGame();
    const o = currentOrigin(g.ctx);
    const old = insertFact(g.db, { subject: "npc_mira", statement: "Mira lives in Oakvale.", authority: "narrative", knownBy: [PLAYER] }, o);
    const r = await rememberFact(g.ctx, { subject: "npc_mira", statement: "Mira now lives in the Grey Marches, having moved after the fire.", authority: "narrative", knownBy: [PLAYER] }, o);
    expect(r.decision.action).toBe("update");
    const closed = getFact(g.db, old)!;
    expect(closed.valid_to_turn).toBe(o.turn);
    expect(closed.superseded_by).toBe(r.id);
    expect(factsAbout(g.db, "npc_mira", { includeClosed: true }).map((f) => f.id)).toContain(old);
    expect(factsAbout(g.db, "npc_mira").map((f) => f.id)).not.toContain(old);
  });

  test("a duplicate adds this turn as another source", async () => {
    const g = await newGame();
    const o = currentOrigin(g.ctx);
    const id = insertFact(g.db, { subject: "npc_tomas", statement: "Tomas owes 200 gold to a card dealer.", authority: "narrative", knownBy: [PLAYER] }, o);
    const r = await rememberFact(g.ctx, { subject: "npc_tomas", statement: "Tomas owes 200 gold to a card dealer.", authority: "narrative", knownBy: ["npc_mira"] }, o);
    expect(r.decision).toEqual({ action: "duplicate", of: id });
    expect(sourceCount(g.db, id)).toBe(2);
    expect(knowersOf(g.db, "fact", id).sort()).toEqual(["npc_mira", PLAYER].sort());
  });
});

describe("knowledge and secrets", () => {
  test("NPC context is limited to what that NPC knows", async () => {
    const g = await newGame();
    const secrets = factsAbout(g.db, "npc_mira").filter((f) => f.secret);
    expect(secrets.length).toBeGreaterThan(0);
    const items = [...loadItems(g.db, secrets.map((f) => `fact:${f.id}`)).values()];
    expect(knownTo(g.db, items, "npc_mira").length).toBe(items.length);
    expect(knownTo(g.db, items, "npc_vyr").length).toBe(0);
  });

  test("facts recorded by the planner are known by everyone present, unless secret", async () => {
    const g = await newGame();
    applyPlan(g, [{ tool: "move", entity: "player", to: "place_rusty_anvil" }]);
    applyPlan(g, [
      { tool: "record_fact", subject: "npc_mira", statement: "Mira's hammer was her father's." },
      { tool: "record_fact", subject: "npc_mira", statement: "Mira poisons the duke's horses.", secret: true },
    ]);
    const facts = factsAbout(g.db, "npc_mira");
    const hammer = facts.find((f) => f.statement.includes("hammer"))!;
    const poison = facts.find((f) => f.statement.includes("poisons"))!;
    expect(knowersOf(g.db, "fact", hammer.id).sort()).toEqual(["npc_mira", PLAYER].sort());
    expect(knowersOf(g.db, "fact", poison.id)).toEqual(["npc_mira"]);
    expect(poison.secret).toBe(1);
  });
});

describe("linking", () => {
  test("aliases, pronouns, keyword names, and new mentions", async () => {
    const g = await newGame();
    const link = (m: string, scene: string[] = []) => linkMention(g.ctx, m, scene, "").then((r) => r.id);
    expect(await link("the old smith")).toBe("npc_mira");
    expect(await link("The Blacksmith")).toBe("npc_mira");
    expect(await link("her", [PLAYER, "npc_mira", "place_rusty_anvil"])).toBe("npc_mira");
    expect(await link("me")).toBe(PLAYER);
    expect(await link("Hale")).toBe("npc_captain_hale");
    expect(await link("Zebediah the tinker")).toBeNull();
  });
});

describe("consolidation", () => {
  test("duplicate entities are merged by an undoable event", async () => {
    const g = await newGame();
    const before = g.head;
    const r = applyPlan(g, [{ tool: "create", kind: "npc", name: "Mira Ironhand", location: "place_oakvale", description: "x" }]);
    const dup = r.created[0];
    const o = currentOrigin(g.ctx);
    const text = "Mira (npc): the blacksmith of Oakvale. Broad-shouldered, grey-haired, blunt.";
    await storeEmbeddings(g.db, g.llm, [{ type: "profile", item: "npc_mira", text }, { type: "profile", item: dup, text }], o);
    insertFact(g.db, { subject: dup, statement: "Mira Ironhand drinks at noon.", authority: "narrative", knownBy: [PLAYER] }, o);
    const merges = await mergeDuplicates(g.ctx, o);
    expect(merges).toEqual([{ from: dup, into: "npc_mira" }]);
    expect(canonical(g.db, dup)).toBe("npc_mira");
    expect(resolveRef(g.db, "Mira Ironhand")).toBe("npc_mira");
    expect(factsAbout(g.db, "npc_mira").some((f) => f.statement.includes("noon"))).toBe(true);
    await g.rewind(before);
    expect(canonical(g.db, "npc_mira")).toBe("npc_mira");
  });

  test("NPC reflections become inferred facts only the NPC knows", async () => {
    const g = await newGame();
    const o = currentOrigin(g.ctx);
    for (let i = 0; i < 3; i++)
      insertEpisode(g.db, { scene: i + 2, summary: `Episode ${i}`, participants: JSON.stringify([PLAYER, "npc_vyr"]), place: null, start_time: 0, end_time: 0, start_turn: 1, end_turn: 1, importance: 5 }, [PLAYER, "npc_vyr"], o);
    expect(await reflect(g.ctx, "npc_vyr", o)).toBe(1);
    const f = factsAbout(g.db, "npc_vyr").find((x) => x.authority === "inferred")!;
    expect(knowersOf(g.db, "fact", f.id)).toEqual(["npc_vyr"]);
    expect(await reflect(g.ctx, "npc_vyr", o)).toBe(0); // nothing new since
  });

  test("scenes roll up into chapters", async () => {
    const g = await newGame({ config: { consolidation: { chapterScenes: 3 } } as any });
    const o = currentOrigin(g.ctx);
    for (let i = 0; i < 7; i++)
      insertEpisode(g.db, { scene: i, summary: `Scene ${i}.`, participants: "[]", place: null, start_time: i, end_time: i, start_turn: i, end_turn: i, importance: 3 }, [PLAYER], o);
    expect(await rollSummaries(g.ctx, o)).toBe(2);
    const { storySoFar } = await import("../src/memory/summaries.ts");
    expect(storySoFar(g.db).map((s) => s.level)).toEqual(["chapter", "chapter", "scene"]);
  });
});

describe("world while playing", () => {
  test("stubs are filled on first touch", async () => {
    const g = await newGame();
    expect(touchedStubs(g.db, [], [])).toEqual([]);
    applyPlan(g, [{ tool: "move", entity: "player", to: "place_ruined_tower" }]);
    expect(touchedStubs(g.db, [], [])).toEqual(["place_ruined_tower"]);
    applyPlan(g, [{ tool: "record_fact", subject: "place_ruined_tower", statement: "The Ruined Tower has three floors." }]);
    expect(touchedStubs(g.db, [], [])).toEqual([]);
  });

  test("aliases are memory: an alias added on one branch is not seen on another", async () => {
    const g = await newGame();
    const fork = g.head;
    applyPlan(g, []);
    addAlias(g.db, "npc_vyr", "the weasel", currentOrigin(g.ctx));
    expect(resolveRef(g.db, "the weasel")).toBe("npc_vyr");
    await g.rewind(fork);
    expect(resolveRef(g.db, "the weasel")).toBeNull();
  });
});
