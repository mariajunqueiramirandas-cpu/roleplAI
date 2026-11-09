import { describe, expect, test } from "bun:test";
import { effectiveMax, getEntity, getStat, holding, statusesOf } from "../src/state/read.ts";
import { TARGET } from "../src/state/rules.ts";
import { parseToolCall, toolDefinitions } from "../src/state/tools.ts";
import { GOLD, PLAYER } from "../src/util.ts";
import { applyPlan, newGame, resolve } from "./helpers.ts";

describe("story-mode rules", () => {
  test("HP stays between 0 and max, and 0 HP downs the player instead of killing them", async () => {
    const g = await newGame();
    const r = applyPlan(g, [{ tool: "adjust", entity: "player", stat: "hp", direction: "down", amount: 999 }]);
    expect(getStat(g.db, PLAYER, "hp")!.value).toBe(0);
    expect(getEntity(g.db, PLAYER)!.alive).toBe(1);
    expect(statusesOf(g.db, PLAYER).map((s) => s.label)).toContain("downed");
    expect(r.notes.join(" ")).toContain("DOWNED");
    applyPlan(g, [{ tool: "adjust", entity: "player", stat: "hp", direction: "up", amount: 999 }]);
    expect(getStat(g.db, PLAYER, "hp")!.value).toBe(getStat(g.db, PLAYER, "hp")!.max!);
  });

  test("permadeath turns 0 HP into death", async () => {
    const g = await newGame({ config: { permadeath: true } });
    applyPlan(g, [{ tool: "adjust", entity: "player", stat: "hp", direction: "down", amount: 999 }]);
    expect(getEntity(g.db, PLAYER)!.alive).toBe(0);
  });

  test("story mode refuses to kill the player outright and downs them", async () => {
    const g = await newGame();
    const r = applyPlan(g, [{ tool: "set_alive", entity: "player", alive: false, cause: "dragon" }]);
    expect(r.rejections[0].reason).toContain("Story mode");
    expect(getEntity(g.db, PLAYER)!.alive).toBe(1);
    expect(getStat(g.db, PLAYER, "hp")!.value).toBe(0);
  });

  test("you can't spend what you don't have; the truth comes back, not an error", async () => {
    const g = await newGame();
    const gold = holding(g.db, PLAYER, GOLD);
    const r = applyPlan(g, [{ tool: "transfer", from: "player", to: "npc_mira", item: "gold", quantity: gold + 1 }]);
    expect(r.rejections).toHaveLength(1);
    expect(r.rejections[0].reason).toContain(`has ${gold} gold`);
    expect(holding(g.db, PLAYER, GOLD)).toBe(gold);
    const ok = applyPlan(g, [{ tool: "transfer", from: "player", to: "npc_mira", item: "gold", quantity: 5 }]);
    expect(ok.rejections).toHaveLength(0);
    expect(holding(g.db, PLAYER, GOLD)).toBe(gold - 5);
    expect(holding(g.db, "npc_mira", GOLD)).toBe(5);
  });

  test("items: give what you hold, not more; world creates and destroys", async () => {
    const g = await newGame();
    expect(holding(g.db, PLAYER, "item_wolf_pelt")).toBe(3);
    const bad = applyPlan(g, [{ tool: "transfer", from: "player", to: "npc_mira", item: "Wolf pelt", quantity: 4 }]);
    expect(bad.rejections).toHaveLength(1);
    applyPlan(g, [{ tool: "transfer", from: "player", to: "npc_mira", item: "wolf pelt", quantity: 3 }]);
    expect(holding(g.db, PLAYER, "item_wolf_pelt")).toBe(0);
    expect(holding(g.db, "npc_mira", "item_wolf_pelt")).toBe(3);
    const made = applyPlan(g, [{ tool: "transfer", from: "world", to: "player", item: "Silver key" }]);
    expect(made.created).toEqual(["item_silver_key"]);
    expect(holding(g.db, PLAYER, "item_silver_key")).toBe(1);
    const missing = applyPlan(g, [{ tool: "transfer", from: "player", to: "world", item: "Dragon egg" }]);
    expect(missing.rejections[0].reason).toContain("no 'Dragon egg'");
  });

  test("the dead stay dead unless explicitly revived", async () => {
    const g = await newGame();
    applyPlan(g, [{ tool: "set_alive", entity: "npc_tomas", alive: false, cause: "fell from the tower" }]);
    const heal = applyPlan(g, [{ tool: "adjust", entity: "npc_tomas", stat: "hp", direction: "up", severity: "major" }]);
    expect(heal.rejections[0].reason).toContain("dead");
    const act = applyPlan(g, [{ tool: "check", actor: "npc_tomas", description: "Tomas runs", attribute: "agility", difficulty: "easy" }]);
    expect(act.rejections[0].reason).toContain("dead");
    applyPlan(g, [{ tool: "set_alive", entity: "npc_tomas", alive: true, cause: "the Hollow Saint's bargain" }]);
    expect(getEntity(g.db, "npc_tomas")!.alive).toBe(1);
    expect(getStat(g.db, "npc_tomas", "hp")!.value).toBeGreaterThan(0);
  });

  test("time only moves forward", async () => {
    const g = await newGame();
    const r = resolve(g, [{ tool: "advance_time" }]);
    expect(r.rejections[0].reason).toContain("forward");
    const ok = applyPlan(g, [{ tool: "advance_time", span: "hour" }]);
    expect(ok.timeAfter - ok.timeBefore).toBe(60);
  });

  test("an entity is in one place, and never inside itself", async () => {
    const g = await newGame();
    applyPlan(g, [{ tool: "move", entity: "npc_mira", to: "place_sleeping_fox" }]);
    expect(getEntity(g.db, "npc_mira")!.location).toBe("place_sleeping_fox");
    const r = resolve(g, [{ tool: "move", entity: "place_ember_vale", to: "place_rusty_anvil" }]); // the smithy is in the vale
    expect(r.rejections[0].reason).toContain("inside");
  });

  test("moving the player ends the scene", async () => {
    const g = await newGame();
    const r = applyPlan(g, [{ tool: "move", entity: "player", to: "place_sleeping_fox" }]);
    expect(r.sceneBreak).toContain("Sleeping Fox");
    expect(r.events.some((e) => e.type === "scene_started")).toBe(true);
  });
});

describe("labels, not numbers", () => {
  test("severity is rolled and scaled by the engine, deterministically per seed", async () => {
    const g = await newGame();
    const a = resolve(g, [{ tool: "adjust", entity: "npc_captain_hale", stat: "hp", direction: "down", severity: "moderate" }], 9);
    const b = resolve(g, [{ tool: "adjust", entity: "npc_captain_hale", stat: "hp", direction: "down", severity: "moderate" }], 9);
    expect(a.events).toEqual(b.events);
    const d = (a.events[0] as any).delta;
    expect(-d).toBeGreaterThanOrEqual(2);
    expect(-d).toBeLessThanOrEqual(12);
  });

  test("adjust needs exactly one of severity, reward or amount", async () => {
    const g = await newGame();
    const r = resolve(g, [{ tool: "adjust", entity: "player", stat: "hp", direction: "down", severity: "minor", amount: 3 }]);
    expect(r.rejections[0].reason).toContain("exactly one");
  });

  test("XP rewards level the player up and raise max HP", async () => {
    const g = await newGame();
    const before = getStat(g.db, PLAYER, "hp")!.max!;
    applyPlan(g, [{ tool: "adjust", entity: "player", stat: "xp", direction: "up", amount: 130 }]);
    expect(getStat(g.db, PLAYER, "level")!.value).toBe(2);
    expect(getStat(g.db, PLAYER, "xp")!.value).toBe(30);
    expect(getStat(g.db, PLAYER, "hp")!.max!).toBeGreaterThan(before);
  });

  test("gold rewards come from the engine's table", async () => {
    const g = await newGame();
    const before = holding(g.db, PLAYER, GOLD);
    applyPlan(g, [{ tool: "transfer", from: "world", to: "player", item: "gold", reward: "fair" }]);
    const gained = holding(g.db, PLAYER, GOLD) - before;
    expect(gained).toBeGreaterThanOrEqual(12);
    expect(gained).toBeLessThanOrEqual(18);
  });
});

describe("checks", () => {
  test("stakes are declared before the roll and only the rolled branch happens", async () => {
    const g = await newGame();
    const plan = [
      {
        tool: "check",
        description: "Persuade Vyr",
        attribute: "presence",
        traits: ["ex-sailor"],
        difficulty: "very_hard",
        onSuccess: [{ tool: "transfer", from: "npc_vyr", to: "player", item: "gold", quantity: 0 + 1 }],
        onFailure: [{ tool: "adjust", entity: "player", stat: "hp", direction: "down", amount: 2 }],
      },
    ];
    for (let seed = 1; seed <= 30; seed++) {
      const r = resolve(g, plan, seed);
      const roll = r.events.find((e) => e.type === "check_rolled") as any;
      expect(roll.target).toBe(TARGET.very_hard);
      expect(roll.bonus).toBe(1 + 2); // presence +1, ex-sailor +2
      expect(roll.total).toBe(roll.roll + 3);
      expect(roll.success).toBe(roll.total >= roll.target);
      expect(r.mechanics[0]).toMatch(/Persuade Vyr \(presence, very hard\): \d+\+3 = \d+ vs 19 → (SUCCESS|FAILURE)/);
      if (roll.success) expect(r.rejections[0]?.reason).toContain("has 0 gold"); // Vyr has no gold
      else expect(r.events.some((e) => e.type === "stat_set" && e.stat === "hp")).toBe(true);
    }
  });

  test("status check modifiers and unknown traits", async () => {
    const g = await newGame();
    applyPlan(g, [{ tool: "add_status", entity: "player", label: "blessed", effects: [{ type: "check_modifier", attribute: "all", bonus: 2 }] }]);
    const r = resolve(g, [{ tool: "check", description: "Climb", attribute: "agility", traits: ["acrobat"], difficulty: "easy" }]);
    const roll = r.events.find((e) => e.type === "check_rolled") as any;
    expect(roll.bonus).toBe(2);
    expect(r.notes.join(" ")).toContain("no trait 'acrobat'");
  });
});

describe("effects", () => {
  test("periodic change ticks with time and expiry removes the status", async () => {
    const g = await newGame();
    applyPlan(g, [{ tool: "define_stat", entity: "player", name: "sanity", value: 10, max: 10 }]);
    applyPlan(g, [{ tool: "add_status", entity: "player", label: "lost in the fog", durationMinutes: 180, effects: [{ type: "periodic", stat: "sanity", amount: -1, everyMinutes: 60 }] }]);
    applyPlan(g, [{ tool: "advance_time", minutes: 120 }]);
    expect(getStat(g.db, PLAYER, "sanity")!.value).toBe(8);
    applyPlan(g, [{ tool: "advance_time", minutes: 300 }]);
    expect(getStat(g.db, PLAYER, "sanity")!.value).toBe(7); // only one more hour before it expired
    expect(statusesOf(g.db, PLAYER).some((s) => s.label === "lost in the fog")).toBe(false);
  });

  test("max modifier lowers the max and clamps the value, and lifts on removal", async () => {
    const g = await newGame();
    const max = getStat(g.db, PLAYER, "hp")!.max!;
    applyPlan(g, [{ tool: "add_status", entity: "player", label: "poisoned", effects: [{ type: "max_modifier", stat: "hp", amount: -5 }] }]);
    expect(effectiveMax(g.db, PLAYER, "hp")).toBe(max - 5);
    expect(getStat(g.db, PLAYER, "hp")!.value).toBe(max - 5);
    applyPlan(g, [{ tool: "remove_status", entity: "player", label: "poisoned" }]);
    expect(effectiveMax(g.db, PLAYER, "hp")).toBe(max);
  });
});

describe("open-ended tools", () => {
  test("create, then refer to the new entity by name in the same plan", async () => {
    const g = await newGame();
    const r = applyPlan(g, [
      { tool: "create", kind: "dragon mount", name: "Cinder", description: "A young red drake.", hp: "major" },
      { tool: "define_stat", entity: "Cinder", name: "patience", toward: "player", value: 5, max: 5 },
      { tool: "add_status", entity: "Cinder", label: "cursed: speaks only in rhymes" },
    ]);
    expect(r.rejections).toEqual([]);
    const id = r.created[0];
    expect(getEntity(g.db, id)!.kind).toBe("dragon mount");
    expect(getStat(g.db, id, "patience", PLAYER)!.value).toBe(5);
    expect(getStat(g.db, id, "hp")!.max).toBeGreaterThan(20);
  });

  test("threads open and update by id or title", async () => {
    const g = await newGame();
    applyPlan(g, [{ tool: "thread", status: "open", kind: "debt", title: "Tomas owes Ash", summary: "10 gold" }]);
    applyPlan(g, [{ tool: "thread", id: "wrong_id", status: "resolved", kind: "debt", title: "Tomas owes Ash" }]);
    const t = g.db.query("SELECT * FROM p_threads WHERE title = 'Tomas owes Ash'").all() as any[];
    expect(t).toHaveLength(1);
    expect(t[0].status).toBe("resolved");
    expect(t[0].summary).toBe("10 gold");
  });

  test("record_fact with a trait attaches a check bonus", async () => {
    const g = await newGame();
    const r = applyPlan(g, [{ tool: "record_fact", subject: "player", statement: "Ash is fire-touched.", trait: { label: "fire-touched", bonus: 1 } }]);
    expect(r.memory).toHaveLength(1);
    expect(g.db.query("SELECT bonus FROM p_traits WHERE entity = 'player' AND label = 'fire-touched'").get()).toEqual({ bonus: 1 });
  });

  test("tool definitions convert to JSON Schema and parse back", () => {
    const defs = toolDefinitions();
    expect(defs.map((d) => d.function.name)).toContain("check");
    const check = defs.find((d) => d.function.name === "check")!;
    expect(JSON.stringify(check.function.parameters)).toContain("onSuccess");
    expect(parseToolCall("adjust", { entity: "player", stat: "hp", direction: "sideways" }).ok).toBe(false);
    expect(parseToolCall("teleport", {}).ok).toBe(false);
  });
});
