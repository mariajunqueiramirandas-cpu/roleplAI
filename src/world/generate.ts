import { z } from "zod";
import { WORLD_SYSTEM } from "../context/prompts.ts";
import type { Ctx } from "../ctx.ts";
import { setMeta, tx } from "../db/db.ts";
import { advanceHead, nextPosition } from "../db/lineage.ts";
import { addAlias, newEntityId, type Origin } from "../memory/entities.ts";
import { insertFact } from "../memory/facts.ts";
import { storeEmbeddings } from "../memory/vectors.ts";
import type { GameEvent } from "../state/events.ts";
import { appendEvent, takeSnapshot } from "../state/projection.ts";
import { getEntity } from "../state/read.ts";
import { ATTRIBUTE_LABELS, ATTRIBUTE_MOD, baseMaxHp, baseMaxMana, WEALTH, WEALTH_GOLD } from "../state/rules.ts";
import { GOLD, norm, now, PLAYER, slug } from "../util.ts";

// ── step schemas ────────────────────────────────────────────────────────────

export const FrameSchema = z.object({
  title: z.string(),
  genre: z.string(),
  tone: z.string(),
  themes: z.array(z.string()).min(1).max(6),
  rules: z.array(z.string()).min(2).max(10).describe("How magic/technology works; what is and isn't possible"),
  summary: z.string().describe("The world's frame in 3–5 sentences"),
});

const Place = z.object({
  name: z.string(),
  kind: z.string().default("place"),
  description: z.string(),
  stub: z.boolean().describe("true for places only named for now"),
});
export const GeographySchema = z.object({
  regions: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      starting: z.boolean().describe("Exactly one region is the starting region"),
      places: z.array(Place).default([]).describe("Detailed places for the starting region; leave empty or stubs elsewhere"),
    }),
  ).min(2).max(8),
});

export const FactionsSchema = z.object({
  factions: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      wants: z.string(),
      base: z.string().nullish().describe("Region or place name"),
      relations: z.array(z.object({ other: z.string(), stance: z.string() })).default([]),
    }),
  ).min(2).max(8),
});

export const HistorySchema = z.object({
  events: z.array(z.object({ statement: z.string(), importance: z.number().min(1).max(10) })).min(2).max(8),
  tensions: z.array(z.string()).min(1).max(6),
});

export const NpcsSchema = z.object({
  npcs: z.array(
    z.object({
      name: z.string(),
      aliases: z.array(z.string()).default([]),
      role: z.string(),
      description: z.string(),
      location: z.string().describe("Name of a place or region from the geography"),
      goal: z.string(),
      faction: z.string().nullish(),
      relationships: z.array(z.object({ other: z.string(), relation: z.string() })).default([]),
      secrets: z.array(z.string()).default([]),
      toughness: z.enum(["minor", "moderate", "major", "massive"]).default("moderate"),
    }),
  ).min(3).max(15),
});

export const StartSchema = z.object({
  location: z.string().describe("Name of the starting place (from the geography, or a new one)"),
  locationDescription: z.string(),
  scene: z.string().describe("The opening situation in 2–4 sentences"),
  threads: z.array(
    z.object({
      kind: z.enum(["quest", "promise", "debt", "mystery", "foreshadowing", "goal"]),
      title: z.string(),
      summary: z.string(),
      hiddenTruth: z.string().nullish().describe("The secret behind a mystery"),
      entities: z.array(z.string()).default([]),
    }),
  ).min(2).max(3),
});

export const CharacterSchema = z.object({
  name: z.string(),
  description: z.string(),
  attributes: z.object({
    body: z.enum(ATTRIBUTE_LABELS),
    agility: z.enum(ATTRIBUTE_LABELS),
    mind: z.enum(ATTRIBUTE_LABELS),
    presence: z.enum(ATTRIBUTE_LABELS),
  }),
  traits: z.array(z.object({ label: z.string(), bonus: z.number().int().min(1).max(3) })).min(1).max(4),
  wealth: z.enum(WEALTH),
  inventory: z.array(z.object({ name: z.string(), quantity: z.number().int().min(1).default(1), description: z.string().default("") })).max(8),
  background: z.array(z.string()).min(2).max(8).describe("Background facts, full sentences"),
});

export const ConsistencySchema = z.object({
  problems: z.array(z.object({ description: z.string(), fix: z.string() })).default([]),
});

export interface WorldSeed {
  premise: string;
  character: string;
  /** Optional fixed world (tests, scripted campaigns): skips the model calls. */
  fixed?: Partial<GeneratedWorld>;
}

export interface GeneratedWorld {
  frame: z.infer<typeof FrameSchema>;
  geography: z.infer<typeof GeographySchema>;
  factions: z.infer<typeof FactionsSchema>;
  history: z.infer<typeof HistorySchema>;
  npcs: z.infer<typeof NpcsSchema>;
  start: z.infer<typeof StartSchema>;
  character: z.infer<typeof CharacterSchema>;
  consistency: z.infer<typeof ConsistencySchema>;
}

/**
 * World generation: a chain of steps, each returning validated JSON and seeing all
 * earlier results. Then everything is stored as entities, canon facts, threads and
 * secrets, and a consistency pass checks the world before play starts.
 */
export async function generateWorld(ctx: Ctx, seed: WorldSeed): Promise<GeneratedWorld> {
  const so: Partial<GeneratedWorld> = { ...(seed.fixed ?? {}) };
  const step = async <T extends z.ZodType>(key: keyof GeneratedWorld, schema: T, instruction: string): Promise<z.infer<T>> => {
    if (so[key]) return so[key] as z.infer<T>;
    const prior = Object.entries(so)
      .map(([k, v]) => `${k.toUpperCase()}:\n${JSON.stringify(v)}`)
      .join("\n\n");
    const v = await ctx.llm.structured(
      "extractor",
      `world_${key}`,
      [
        { role: "system", content: WORLD_SYSTEM },
        { role: "user", content: `PREMISE: ${seed.premise}\nCHARACTER CONCEPT: ${seed.character}\n\n${prior ? `DECIDED SO FAR:\n${prior}\n\n` : ""}STEP: ${instruction}` },
      ],
      schema,
      { meta: { premise: seed.premise, character: seed.character, prior: so } },
    );
    (so as any)[key] = v;
    return v;
  };
  await step("frame", FrameSchema, "The frame: genre, tone, themes, and the world's rules (how magic or technology works, what is and isn't possible). Keep it short.");
  await step("geography", GeographySchema, "Geography: regions. Detail the starting region with 3–6 places; name the other regions with stubs.");
  await step("factions", FactionsSchema, "Factions: who holds power, what they want, how they relate to each other.");
  await step("history", HistorySchema, "History and tensions: a few key past events and what is unstable now.");
  await step("npcs", NpcsSchema, "Key NPCs (5–15): goals, relationships and secrets. Place most in the starting region.");
  await step("start", StartSchema, "Starting point: the starting location in detail and 2–3 opening threads, including at least one hidden truth behind a mystery.");
  await step("character", CharacterSchema, "The player character, from the concept: attribute labels, starting traits, wealth label, inventory and background facts.");
  await step("consistency", ConsistencySchema, "Consistency pass: list internal contradictions in everything above (none if it is consistent), each with a fix.");
  return so as GeneratedWorld;
}

/** Store a generated world as the genesis turn of a new campaign. */
export async function storeWorld(ctx: Ctx, w: GeneratedWorld, seed: WorldSeed): Promise<{ turn: number; entities: number }> {
  const { db } = ctx;
  const embeds: { type: "fact" | "profile"; item: string | number; text: string }[] = [];
  let origin!: Origin;
  const names = new Map<string, string>();
  const find = (n: string | null | undefined): string | null => (n ? (names.get(norm(n)) ?? null) : null);

  tx(db, () => {
    const pos = nextPosition(db);
    const r = db
      .query("INSERT INTO turns(segment, parent, scene, game_time, kind, input, prose, created_at) VALUES (?, ?, 1, ?, 'genesis', ?, ?, ?)")
      .run(pos.segment, pos.parent, 8 * 60, `${seed.premise}\n${seed.character}`, w.start.scene, now());
    const turn = Number(r.lastInsertRowid);
    advanceHead(db, turn, pos.segment);
    origin = { segment: pos.segment, turn, gameTime: 8 * 60 };
    const ev = (e: GameEvent) => appendEvent(db, e, turn, pos.segment, origin.gameTime);
    const create = (kind: string, name: string, description: string, location: string | null, stub = false, aliases: string[] = []) => {
      const existing = find(name);
      if (existing) return existing;
      const id = newEntityId(db, kind, name);
      ev({ type: "entity_created", id, kind, name, description, location, alive: true, stub });
      for (const a of [name, ...aliases]) {
        addAlias(db, id, a, origin);
        names.set(norm(a), id);
      }
      if (description) embeds.push({ type: "profile", item: id, text: `${name} (${kind}): ${description}` });
      return id;
    };
    const canon = (subject: string, statement: string, importance = 6, opts: { secret?: boolean; knownBy?: string[]; predicate?: string; object?: string | null } = {}) => {
      const id = insertFact(
        db,
        { subject, statement, authority: "canon", importance, secret: opts.secret, knownBy: opts.knownBy ?? ["*"], predicate: opts.predicate, object: opts.object ?? null },
        origin,
      );
      embeds.push({ type: "fact", item: id, text: statement });
    };

    ev({ type: "time_set", from: 0, to: origin.gameTime });
    setMeta(db, "frame", [
      `${w.frame.title} — ${w.frame.genre}; tone: ${w.frame.tone}; themes: ${w.frame.themes.join(", ")}.`,
      w.frame.summary,
      "World rules:",
      ...w.frame.rules.map((r) => `- ${r}`),
    ].join("\n"));
    setMeta(db, "title", w.frame.title);

    // Geography
    for (const reg of w.geography.regions) {
      const rid = create("region", reg.name, reg.description, null, !reg.starting);
      canon(rid, `${reg.name}: ${reg.description}`, reg.starting ? 6 : 4);
      for (const p of reg.places) {
        const pid = create(p.kind || "place", p.name, p.description, rid, p.stub);
        canon(pid, `${p.name} is in ${reg.name}. ${p.description}`, 5, { predicate: "is in", object: rid });
      }
    }
    // Factions
    for (const f of w.factions.factions) {
      const fid = create("faction", f.name, f.description, find(f.base));
      canon(fid, `${f.name}: ${f.description} They want ${f.wants.replace(/^to /, "to ")}.`, 6);
    }
    for (const f of w.factions.factions)
      for (const rel of f.relations) {
        const a = find(f.name), b = find(rel.other);
        if (a && b) canon(a, `${f.name} and ${rel.other}: ${rel.stance}.`, 5, { predicate: "relation", object: b });
      }
    // History (facts about the world's frame: subject is the starting region)
    const startRegion = w.geography.regions.find((r) => r.starting) ?? w.geography.regions[0];
    const regionId = find(startRegion.name)!;
    for (const h of w.history.events) canon(regionId, h.statement, h.importance);
    for (const t of w.history.tensions) canon(regionId, `Current tension: ${t}`, 7);

    // Starting location
    let startLoc = find(w.start.location);
    if (!startLoc) startLoc = create("place", w.start.location, w.start.locationDescription, regionId);
    else ev({ type: "described", entity: startLoc, description: w.start.locationDescription });
    if (getEntity(db, startLoc)?.stub) ev({ type: "stub_filled", entity: startLoc });
    canon(startLoc, `${w.start.location}: ${w.start.locationDescription}`, 6);

    // NPCs
    for (const n of w.npcs.npcs) {
      const loc = find(n.location) ?? regionId;
      const nid = create("npc", n.name, `${n.role}. ${n.description}`, loc, false, n.aliases);
      const hp = { minor: 6, moderate: 14, major: 30, massive: 60 }[n.toughness];
      ev({ type: "stat_set", entity: nid, stat: "hp", toward: "", value: hp, max: hp, category: "core" });
      canon(nid, `${n.name} is ${n.role}. ${n.description}`, 6);
      canon(nid, `${n.name} wants ${n.goal.replace(/^to /, "to ")}.`, 6, { secret: true, knownBy: [nid] });
      if (n.faction && find(n.faction)) canon(nid, `${n.name} belongs to ${n.faction}.`, 5, { predicate: "member of", object: find(n.faction) });
      for (const s of n.secrets) canon(nid, s, 7, { secret: true, knownBy: [nid] });
    }
    for (const n of w.npcs.npcs)
      for (const rel of n.relationships) {
        const a = find(n.name), b = find(rel.other);
        if (a && b) canon(a, `${n.name} — ${rel.other}: ${rel.relation}.`, 5, { predicate: "relationship", object: b, knownBy: [a, b] });
      }

    // Player character
    const c = w.character;
    ev({ type: "entity_created", id: PLAYER, kind: "player character", name: c.name, description: c.description, location: startLoc, alive: true, stub: false });
    addAlias(db, PLAYER, c.name, origin);
    names.set(norm(c.name), PLAYER);
    for (const [attr, label] of Object.entries(c.attributes)) {
      ev({ type: "stat_set", entity: PLAYER, stat: attr, toward: "", value: ATTRIBUTE_MOD[label], max: null, category: "attribute" });
    }
    const body = ATTRIBUTE_MOD[c.attributes.body];
    const mind = ATTRIBUTE_MOD[c.attributes.mind];
    ev({ type: "stat_set", entity: PLAYER, stat: "hp", toward: "", value: baseMaxHp(body, 1), max: baseMaxHp(body, 1), category: "core" });
    ev({ type: "stat_set", entity: PLAYER, stat: "mana", toward: "", value: baseMaxMana(mind, 1), max: baseMaxMana(mind, 1), category: "core" });
    ev({ type: "stat_set", entity: PLAYER, stat: "level", toward: "", value: 1, max: null, category: "core" });
    ev({ type: "stat_set", entity: PLAYER, stat: "xp", toward: "", value: 0, max: null, category: "core" });
    for (const t of c.traits) ev({ type: "trait_added", entity: PLAYER, label: t.label, bonus: t.bonus });
    const gold = WEALTH_GOLD[c.wealth];
    if (gold) ev({ type: "holding_set", holder: PLAYER, item: GOLD, qty: gold });
    for (const it of c.inventory) {
      const iid = newEntityId(db, "item", it.name);
      ev({ type: "entity_created", id: iid, kind: "item", name: it.name, description: it.description, location: null, alive: true, stub: false });
      addAlias(db, iid, it.name, origin);
      names.set(norm(it.name), iid);
      ev({ type: "holding_set", holder: PLAYER, item: iid, qty: it.quantity });
    }
    for (const b of c.background) canon(PLAYER, b, 6, { knownBy: [PLAYER] });
    setMeta(db, "background", `${c.name}: ${c.description}\n${c.background.map((b) => `- ${b}`).join("\n")}`);

    // Opening threads and the hidden truths behind them
    for (const t of w.start.threads) {
      const ents = t.entities.map((x) => find(x)).filter((x): x is string => !!x);
      ev({ type: "thread_set", id: `th_${slug(t.title).slice(0, 30)}`, kind: t.kind, title: t.title, status: "open", summary: t.summary, entities: ents, hidden: false });
      if (t.hiddenTruth) canon(ents[0] ?? regionId, t.hiddenTruth, 8, { secret: true, knownBy: ents.length ? ents : [regionId] });
    }
    // Consistency fixes are kept as canon notes the planner sees.
    for (const p of w.consistency.problems) canon(regionId, `Canon clarification: ${p.fix}`, 5);
    ev({ type: "scene_started", scene: 1, reason: "the story begins", location: startLoc });
    takeSnapshot(db, turn, pos.segment);
  });
  await storeEmbeddings(db, ctx.llm, embeds, origin).catch(() => undefined);
  return { turn: origin.turn, entities: names.size };
}
