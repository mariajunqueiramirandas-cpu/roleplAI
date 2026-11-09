import { z } from "zod";
import type { Ctx } from "../ctx.ts";
import { vis } from "../db/lineage.ts";
import { addAlias, aliasesOf, allEntities, kindPrefix, type Origin } from "../memory/entities.ts";
import { episodes } from "../memory/episodes.ts";
import { closeFact, factsAbout, getFact, insertFact } from "../memory/facts.ts";
import { insertSummary, unrolled, unrolledEpisodes, type SummaryLevel } from "../memory/summaries.ts";
import { storeEmbeddings, vectorOf } from "../memory/vectors.ts";
import { appendEvent, getWorld } from "../state/projection.ts";
import { activeThreads, getEntity, type ThreadRow } from "../state/read.ts";
import { cosine, PLAYER, words } from "../util.ts";
import { rememberFact } from "./contradiction.ts";

const SummarySchema = z.object({ summary: z.string() });
const ProfileSchema = z.object({ profile: z.string().describe("At most 80 words, present tense") });
const SameSchema = z.object({ same: z.boolean(), reason: z.string().default("") });
const ConflictSchema = z.object({ keep: z.enum(["old", "new", "both"]), reason: z.string().default("") });
const ReflectionSchema = z.object({
  beliefs: z.array(z.object({ statement: z.string(), importance: z.number().min(1).max(10).default(5) })).max(5),
});

export interface ConsolidationReport {
  summaries: number;
  profiles: number;
  merges: { from: string; into: string }[];
  conflicts: number;
}

/** Roll scenes into chapters, chapters into arcs, arcs into sagas. Never deletes. */
export async function rollSummaries(ctx: Ctx, o: Origin): Promise<number> {
  const { db, config } = ctx;
  let made = 0;
  const roll = async (level: SummaryLevel, items: { id: number; text: string; start: number; end: number }[], size: number) => {
    while (items.length >= size) {
      const batch = items.splice(0, size);
      const r = await ctx.llm.structured(
        "extractor",
        `summary_${level}`,
        [
          { role: "system", content: `Summarise these consecutive parts of a role-playing game's story into one ${level} summary of 3–6 sentences. Keep names, decisions, consequences and open questions. Third person, past tense.` },
          { role: "user", content: batch.map((b, i) => `${i + 1}. ${b.text}`).join("\n") },
        ],
        SummarySchema,
        { fallback: { summary: batch.map((b) => b.text).join(" ").slice(0, 1200) }, meta: { items: batch.map((b) => b.text) } },
      );
      insertSummary(db, level, r.summary, batch.map((b) => b.id), batch[0].start, batch[batch.length - 1].end, o);
      made++;
    }
  };
  const C = config.consolidation;
  await roll("chapter", unrolledEpisodes(db).map((e) => ({ id: e.id, text: e.summary, start: e.start_turn, end: e.end_turn })), C.chapterScenes);
  await roll("arc", unrolled(db, "chapter").map((s) => ({ id: s.id, text: s.text, start: s.start_turn, end: s.end_turn })), C.arcChapters);
  await roll("saga", unrolled(db, "arc").map((s) => ({ id: s.id, text: s.text, start: s.start_turn, end: s.end_turn })), C.sagaArcs);
  return made;
}

/** Rebuild an entity's profile (a cache) from its currently valid, non-secret facts. */
export async function rebuildProfile(ctx: Ctx, entity: string, o: Origin): Promise<boolean> {
  const { db } = ctx;
  const e = getEntity(db, entity);
  if (!e) return false;
  const facts = factsAbout(db, entity).filter((f) => !f.secret);
  if (!facts.length && !e.description) return false;
  const top = facts.sort((a, b) => b.importance - a.importance || b.id - a.id).slice(0, 25);
  const r = await ctx.llm.structured(
    "extractor",
    "profile",
    [
      { role: "system", content: "Write a compact profile of a game-world entity from its facts. Only use the facts given. At most 80 words." },
      { role: "user", content: `${e.name} (${e.kind})${e.description ? `: ${e.description}` : ""}\nFacts:\n${top.map((f) => `- ${f.statement}`).join("\n")}` },
    ],
    ProfileSchema,
    { fallback: { profile: [e.description, ...top.slice(0, 6).map((f) => f.statement)].filter(Boolean).join(" ") }, meta: { name: e.name, description: e.description, facts: top.map((f) => f.statement) } },
  );
  appendEvent(db, { type: "profile_set", entity, profile: r.profile }, o.turn, o.segment, o.gameTime);
  appendEvent(db, { type: "world_set", key: `profiled:${entity}`, value: String(o.turn) }, o.turn, o.segment, o.gameTime);
  await storeEmbeddings(db, ctx.llm, [{ type: "profile", item: entity, text: `${e.name} (${e.kind}): ${r.profile}` }], o).catch(() => undefined);
  return true;
}

/** Entities whose facts changed since their profile was last built. */
export function staleProfiles(ctx: Ctx): string[] {
  const { db } = ctx;
  const out: string[] = [];
  for (const e of allEntities(db)) {
    const last = Number(getWorld(db, `profiled:${e.id}`) ?? 0);
    const newer = db.query(`SELECT 1 FROM facts f WHERE f.subject = ? AND f.turn > ? AND ${vis("f")} LIMIT 1`).get(e.id, last);
    if (newer) out.push(e.id);
  }
  return out;
}

/** Likely duplicate entities, confirmed by the verifier, merged by an (undoable) event. */
export async function mergeDuplicates(ctx: Ctx, o: Origin): Promise<{ from: string; into: string }[]> {
  const { db, config } = ctx;
  const ents = allEntities(db).filter((e) => e.id !== PLAYER);
  const model = config.roles.embed.model;
  const merges: { from: string; into: string }[] = [];
  const done = new Set<string>();
  const vecs = new Map(ents.map((e) => [e.id, vectorOf(db, "profile", e.id, model)]));
  const names = new Map(ents.map((e) => [e.id, aliasesOf(db, e.id).flatMap((x) => words(x))]));
  for (let i = 0; i < ents.length; i++) {
    for (let j = i + 1; j < ents.length; j++) {
      const a = ents[i],
        b = ents[j];
      if (done.has(a.id) || done.has(b.id)) continue;
      if (kindPrefix(a.kind) !== kindPrefix(b.kind)) continue;
      // Two living beings standing in the same place are two different beings.
      if (a.location && a.location === b.location && a.alive && b.alive && kindPrefix(a.kind) === "npc") continue;
      const an = new Set(names.get(a.id));
      const nameOverlap = names.get(b.id)!.filter((w) => an.has(w) && w.length > 2).length;
      const va = vecs.get(a.id);
      const vb = vecs.get(b.id);
      const sim = va && vb ? cosine(va, vb) : 0;
      if (!(sim >= config.consolidation.duplicateThreshold || (nameOverlap > 0 && sim >= config.consolidation.duplicateThreshold - 0.2))) continue;
      const r = await ctx.llm.structured(
        "verifier",
        "duplicate",
        [
          { role: "system", content: "Decide whether two entity records in a role-playing game's memory are the same entity under different names. Only say same when the evidence is clear." },
          { role: "user", content: [a, b].map((e) => `${e.id}: ${e.name} (${e.kind}) aka ${aliasesOf(db, e.id).join(", ")} — ${e.profile || e.description}`).join("\n") },
        ],
        SameSchema,
        { fallback: { same: false, reason: "" }, meta: { a: a.id, b: b.id, sim, nameOverlap } },
      );
      if (!r.same) continue;
      // The older entity survives.
      const [into, from] = a.created_turn <= b.created_turn ? [a, b] : [b, a];
      appendEvent(db, { type: "entities_merged", from: from.id, into: into.id }, o.turn, o.segment, o.gameTime);
      for (const al of aliasesOf(db, from.id)) addAlias(db, into.id, al, o);
      merges.push({ from: from.id, into: into.id });
      done.add(from.id);
    }
  }
  return merges;
}

/** Resolve queued narrative-vs-narrative conflicts. */
export async function resolveConflicts(ctx: Ctx, o: Origin): Promise<number> {
  const { db } = ctx;
  const open = db
    .query(
      `SELECT c.* FROM conflicts c WHERE ${vis("c")}
       AND NOT EXISTS (SELECT 1 FROM conflict_resolutions r WHERE r.conflict = c.id AND ${vis("r")})`,
    )
    .all() as { id: number; fact_a: number; fact_b: number }[];
  for (const c of open) {
    const a = getFact(db, c.fact_a);
    const b = getFact(db, c.fact_b);
    if (!a || !b) continue;
    const r = await ctx.llm.structured(
      "verifier",
      "conflict",
      [
        { role: "system", content: "Two remembered facts from a role-playing game conflict. Decide which is right given the rest of what is known: keep the old one, the new one, or both if they can both be true." },
        { role: "user", content: `OLD: ${a.statement}\nNEW: ${b.statement}\nOther facts:\n${factsAbout(db, a.subject).slice(0, 15).map((f) => `- ${f.statement}`).join("\n")}` },
      ],
      ConflictSchema,
      { fallback: { keep: "old", reason: "" }, meta: { old: a.statement, new: b.statement } },
    );
    if (r.keep !== "old") {
      const copy = insertFact(db, { subject: b.subject, predicate: b.predicate, object: b.object, statement: b.statement, authority: b.authority, importance: b.importance, secret: !!b.secret, knownBy: [PLAYER] }, o);
      if (r.keep === "new") closeFact(db, a.id, copy, o);
    }
    db.query("INSERT INTO conflict_resolutions(conflict, resolution, segment, turn) VALUES (?, ?, ?, ?)").run(c.id, r.keep, o.segment, o.turn);
  }
  return open.length;
}

/**
 * When an NPC is about to appear and has several new episodes since their last
 * reflection, write their updated beliefs as `inferred` facts only they know.
 */
export async function reflect(ctx: Ctx, npc: string, o: Origin): Promise<number> {
  const { db, config } = ctx;
  const e = getEntity(db, npc);
  if (!e || !e.alive || npc === PLAYER) return 0;
  const last = (db.query(`SELECT MAX(r.upto_episode) m FROM reflections r WHERE r.entity = ? AND ${vis("r")}`).get(npc) as { m: number | null }).m ?? 0;
  const eps = episodes(db, { participant: npc, afterId: last });
  if (eps.length < config.consolidation.reflectionMinEpisodes) return 0;
  const facts = factsAbout(db, npc).slice(-20);
  const r = await ctx.llm.structured(
    "extractor",
    "reflection",
    [
      { role: "system", content: "You write an NPC's updated beliefs and feelings after recent events, as short third-person statements (\"Mira has started to distrust the player.\"). Only what follows from the events." },
      { role: "user", content: `${e.name}: ${e.profile || e.description}\nKnown facts:\n${facts.map((f) => `- ${f.statement}`).join("\n")}\nRecent episodes:\n${eps.reverse().map((x) => `- ${x.summary}`).join("\n")}` },
    ],
    ReflectionSchema,
    { fallback: { beliefs: [] }, meta: { npc, name: e.name, episodes: eps.map((x) => x.summary) } },
  );
  let n = 0;
  for (const b of r.beliefs) {
    await rememberFact(ctx, { subject: npc, predicate: "believes", statement: b.statement, authority: "inferred", importance: b.importance, secret: true, knownBy: [npc] }, o);
    n++;
  }
  db.query("INSERT INTO reflections(entity, upto_episode, segment, turn) VALUES (?, ?, ?, ?)").run(npc, Math.max(...eps.map((x) => x.id)), o.segment, o.turn);
  return n;
}

/** Threads nobody has touched for a long time, so the planner can pick them back up. */
export function staleThreads(ctx: Ctx, head: number): ThreadRow[] {
  return activeThreads(ctx.db).filter((t) => head - t.updated_turn >= ctx.config.consolidation.staleThreadTurns);
}

export async function consolidate(ctx: Ctx, o: Origin): Promise<ConsolidationReport> {
  const summaries = await rollSummaries(ctx, o);
  let profiles = 0;
  for (const id of staleProfiles(ctx)) if (await rebuildProfile(ctx, id, o)) profiles++;
  const merges = await mergeDuplicates(ctx, o);
  const conflicts = await resolveConflicts(ctx, o);
  return { summaries, profiles, merges, conflicts };
}

