import { z } from "zod";
import type { Ctx } from "../ctx.ts";
import { addAlias, isPlace, newEntityId, resolveRef, type Origin } from "../memory/entities.ts";
import { getTurn, insertEpisode, sceneTurns, type TurnRow } from "../memory/episodes.ts";
import type { NewFact } from "../memory/facts.ts";
import { storeEmbeddings } from "../memory/vectors.ts";
import { appendEvent } from "../state/projection.ts";
import { getEntity } from "../state/read.ts";
import { json, norm, PLAYER, slug } from "../util.ts";
import { rememberFact } from "./contradiction.ts";
import { extractTurn, type TurnOutcome } from "./extract.ts";
import { linkMention } from "./link.ts";

export interface RememberReport {
  turn: number;
  facts: { statement: string; action: string }[];
  createdEntities: string[];
  threads: string[];
  episode: number | null;
}

function originOf(t: TurnRow): Origin {
  return { segment: t.segment, turn: t.id, gameTime: t.game_time };
}

/**
 * The write path for one committed turn: extract → link → check against what's known
 * → witnesses → store. Runs in the background after commit.
 */
export async function rememberTurn(ctx: Ctx, turnId: number): Promise<RememberReport> {
  const { db } = ctx;
  const t = getTurn(db, turnId);
  if (!t) throw new Error(`No turn ${turnId}`);
  const o = originOf(t);
  const outcome = json<TurnOutcome>(t.outcome, {} as TurnOutcome);
  const present = outcome.present?.length ? outcome.present : [PLAYER];
  const known = [...new Set([PLAYER, ...(outcome.sceneEntities ?? []), ...(outcome.linked ?? []), ...(outcome.created ?? [])])];
  const report: RememberReport = { turn: turnId, facts: [], createdEntities: [], threads: [], episode: null };

  if (ctx.config.components.extraction && t.kind === "play") {
    const ex = await extractTurn(ctx, t, known);
    const context = `${t.input} ${t.prose}`.slice(0, 400);
    const map = new Map<string, string>();
    const toEmbed: { type: "profile"; item: string; text: string }[] = [];

    // 1–2. Entities: link each mention; no good match means a new entity.
    for (const e of ex.entities) {
      const link = await linkMention(ctx, e.mention, known, context, e.id && getEntity(db, e.id) ? e.id : null);
      let id = link.id;
      if (!id) {
        const name = e.name || e.mention;
        if (/^(he|him|she|her|they|them|it|you|i|me)$/i.test(norm(name))) continue;
        id = newEntityId(db, e.kind, name);
        const loc = getEntity(db, PLAYER)?.location ?? null;
        appendEvent(
          db,
          { type: "entity_created", id, kind: e.kind.toLowerCase(), name, description: e.description, location: isPlace(e.kind) ? null : loc, alive: true, stub: false },
          o.turn,
          o.segment,
          o.gameTime,
        );
        addAlias(db, id, name, o);
        report.createdEntities.push(id);
        if (e.description) toEmbed.push({ type: "profile", item: id, text: `${name} (${e.kind}): ${e.description}` });
      }
      if (e.mention !== (getEntity(db, id)?.name ?? "") && !/^(he|him|she|her|they|them|it)$/i.test(norm(e.mention))) addAlias(db, id, e.mention, o);
      map.set(norm(e.mention), id);
      if (e.name) map.set(norm(e.name), id);
      if (e.id) map.set(e.id, id);
    }
    const ref = (r: string | null | undefined): string | null => {
      if (!r) return null;
      return map.get(r) ?? map.get(norm(r)) ?? resolveRef(db, r, known);
    };

    // 3–4. Facts: witnesses, then check against what's known.
    for (const f of ex.facts) {
      const subject = ref(f.subject);
      if (!subject) continue;
      const knownBy = f.knownBy?.length ? f.knownBy.map((k) => ref(k) ?? k).filter((k) => k === "*" || getEntity(db, k) || k === PLAYER) : f.secret ? [subject] : present;
      const nf: NewFact = {
        subject,
        predicate: f.predicate,
        object: ref(f.object) ?? f.object ?? null,
        statement: f.statement,
        authority: "narrative",
        importance: f.importance,
        secret: f.secret || !knownBy.includes(PLAYER),
        knownBy,
      };
      const r = await rememberFact(ctx, nf, o);
      report.facts.push({ statement: f.statement, action: r.decision.action });
    }

    // Threads opened, progressed or resolved in the prose.
    for (const th of ex.threads) {
      const existing = (th.id ? db.query("SELECT * FROM p_threads WHERE id = ?").get(th.id) : null) ??
        db.query("SELECT * FROM p_threads WHERE lower(title) = lower(?)").get(th.title);
      const id = (existing as any)?.id ?? `th_${slug(th.title).slice(0, 30)}`;
      appendEvent(
        db,
        {
          type: "thread_set",
          id,
          kind: th.kind,
          title: th.title,
          status: th.status,
          summary: th.summary || (existing as any)?.summary || "",
          entities: th.entities.map((x) => ref(x)).filter((x): x is string => !!x),
          hidden: false,
        },
        o.turn,
        o.segment,
        o.gameTime,
      );
      report.threads.push(id);
    }
    await storeEmbeddings(db, ctx.llm, toEmbed, o).catch(() => undefined);
    db.query("UPDATE turns SET importance = ? WHERE id = ?").run(Math.round(ex.importance), t.id);
  }
  db.query("UPDATE turns SET extracted = 1 WHERE id = ?").run(t.id);

  // 5. The episode, when this turn ended a scene.
  if (outcome.sceneEnded) report.episode = await storeEpisode(ctx, t.scene, o);
  return report;
}

const EpisodeSchema = z.object({
  summary: z.string().describe("2–4 sentences: what happened in the scene, who was involved, what changed"),
  importance: z.number().min(1).max(10),
});

export async function storeEpisode(ctx: Ctx, scene: number, o: Origin): Promise<number | null> {
  const { db } = ctx;
  const turns = sceneTurns(db, scene);
  if (!turns.length) return null;
  const participants = new Set<string>();
  let place: string | null = null;
  for (const t of turns) {
    const out = json<TurnOutcome>(t.outcome, {} as TurnOutcome);
    for (const p of out.present ?? []) participants.add(p);
  }
  const placeRow = db.query("SELECT payload FROM events WHERE turn = ? AND type = 'scene_started'").get(turns[0].id) as any;
  place = json<any>(placeRow?.payload, {})?.location ?? null;
  const firstOutcome = json<TurnOutcome>(turns[0].outcome, {} as TurnOutcome);
  place ??= firstOutcome.sceneEntities?.find((e) => isPlace(getEntity(db, e)?.kind ?? "")) ?? null;
  const text = turns.map((t) => `Player: ${t.input}\nGM: ${t.prose}`).join("\n\n").slice(-12000);
  const r = await ctx.llm.structured(
    "extractor",
    "episode",
    [
      { role: "system", content: "Summarise one scene of a role-playing game for long-term memory. Use names, not pronouns. Third person, past tense; the player character is 'the player'." },
      { role: "user", content: text },
    ],
    EpisodeSchema,
    {
      fallback: { summary: turns.map((t) => t.input).join(" ").slice(0, 400), importance: Math.max(...turns.map((t) => t.importance)) },
      meta: { turns: turns.map((t) => ({ input: t.input, prose: t.prose })) },
    },
  );
  const importance = Math.round(Math.max(r.importance, ...turns.map((t) => t.importance)));
  const id = insertEpisode(
    db,
    {
      scene,
      summary: r.summary,
      participants: JSON.stringify([...participants]),
      place,
      start_time: turns[0].game_time,
      end_time: turns[turns.length - 1].game_time,
      start_turn: turns[0].id,
      end_turn: turns[turns.length - 1].id,
      importance,
    },
    [...participants],
    o,
  );
  await storeEmbeddings(db, ctx.llm, [{ type: "episode", item: id, text: r.summary }], o).catch(() => undefined);
  return id;
}
