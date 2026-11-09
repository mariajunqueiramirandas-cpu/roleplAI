import type { Ctx } from "../ctx.ts";
import type { DB } from "../db/db.ts";
import { vis, VIS_TURN } from "../db/lineage.ts";
import { getEpisodes } from "../memory/episodes.ts";
import { getFacts, knowersOf, OPEN_FACT_SQL, type Fact } from "../memory/facts.ts";
import { vectorSearch } from "../memory/vectors.ts";
import { activeThreads, gameTime, getEntity, idsOf, type ThreadRow } from "../state/read.ts";
import { formatTime, ftsQuery, json, words } from "../util.ts";

export type ItemType = "fact" | "episode" | "turn" | "profile";

export interface MemItem {
  key: string;
  type: ItemType;
  id: string;
  text: string;
  /** Entities the item is about. */
  entities: string[];
  subject: string | null;
  importance: number;
  gameTime: number;
  turn: number;
  secret: boolean;
  knownBy: string[];
  validTo: number | null;
  authority?: string;
}

export interface Scored extends MemItem {
  score: number;
  rerank: number;
  sources: string[];
}

export interface RetrieveInput {
  queries: string[];
  sceneEntities: string[];
  linked: string[];
  refersToPast: boolean;
  /** Turns already in the prompt word for word. */
  excludeTurns: number[];
  limit?: number;
}

export interface RetrieveDebug {
  lists: Record<string, string[]>;
  fused: string[];
}

// ── item loading ────────────────────────────────────────────────────────────

function factItem(db: DB, f: Fact): MemItem {
  return {
    key: `fact:${f.id}`,
    type: "fact",
    id: String(f.id),
    text: f.statement,
    entities: [f.subject, ...(f.object && getEntity(db, f.object) ? [f.object] : [])],
    subject: f.subject,
    importance: f.importance,
    gameTime: f.valid_from_time,
    turn: f.valid_from_turn,
    secret: !!f.secret,
    knownBy: knowersOf(db, "fact", f.id),
    validTo: f.valid_to_time ?? null,
    authority: f.authority,
  };
}

export function loadItems(db: DB, keys: string[]): Map<string, MemItem> {
  const out = new Map<string, MemItem>();
  const byType: Record<string, string[]> = {};
  for (const k of keys) {
    const [t, id] = [k.slice(0, k.indexOf(":")), k.slice(k.indexOf(":") + 1)];
    (byType[t] ??= []).push(id);
  }
  for (const f of getFacts(db, (byType.fact ?? []).map(Number))) out.set(`fact:${f.id}`, factItem(db, f));
  for (const e of getEpisodes(db, (byType.episode ?? []).map(Number))) {
    out.set(`episode:${e.id}`, {
      key: `episode:${e.id}`,
      type: "episode",
      id: String(e.id),
      text: e.summary,
      entities: json<string[]>(e.participants, []),
      subject: null,
      importance: e.importance,
      gameTime: e.start_time,
      turn: e.start_turn,
      secret: false,
      knownBy: knowersOf(db, "episode", e.id),
      validTo: null,
    });
  }
  for (const id of byType.turn ?? []) {
    const t = db.query(`SELECT * FROM turns t WHERE t.id = ? AND ${VIS_TURN}`).get(Number(id)) as any;
    if (!t) continue;
    out.set(`turn:${id}`, {
      key: `turn:${id}`,
      type: "turn",
      id,
      text: `Player: ${t.input}\nGM: ${t.prose}`,
      entities: [],
      subject: null,
      importance: t.importance,
      gameTime: t.game_time,
      turn: t.id,
      secret: false,
      knownBy: ["player"],
      validTo: null,
    });
  }
  for (const id of byType.profile ?? []) {
    const e = getEntity(db, id);
    if (!e || !(e.profile || e.description)) continue;
    out.set(`profile:${e.id}`, {
      key: `profile:${e.id}`,
      type: "profile",
      id: e.id,
      text: `${e.name} (${e.kind}): ${e.profile || e.description}`,
      entities: [e.id],
      subject: e.id,
      importance: 5,
      gameTime: 0,
      turn: e.created_turn,
      secret: false,
      knownBy: ["*"],
      validTo: null,
    });
  }
  return out;
}

// ── candidate lists ─────────────────────────────────────────────────────────

/** Facts 1–N hops out from the given entities. */
export function graphCandidates(db: DB, seeds: string[], hops: number, includeClosed: boolean): string[] {
  const seen = new Set<string>();
  let frontier = new Set(seeds.flatMap((s) => idsOf(db, s)));
  const out: string[] = [];
  for (let h = 0; h < hops && frontier.size; h++) {
    const ids = [...frontier];
    frontier.forEach((x) => seen.add(x));
    const ph = ids.map(() => "?").join(",");
    const rows = db
      .query(
        `SELECT f.id, f.subject, f.object FROM facts f
         WHERE (f.subject IN (${ph}) OR f.object IN (${ph})) AND ${vis("f")} ${includeClosed ? "" : `AND ${OPEN_FACT_SQL}`}
         ORDER BY f.importance DESC, f.id DESC LIMIT 400`,
      )
      .all(...ids, ...ids) as { id: number; subject: string; object: string | null }[];
    const next = new Set<string>();
    for (const r of rows) {
      out.push(`fact:${r.id}`);
      for (const n of [r.subject, r.object]) if (n && !seen.has(n) && getEntity(db, n)) next.add(n);
    }
    frontier = next;
  }
  return [...new Set(out)];
}

export function keywordCandidates(db: DB, query: string, limit: number, includeClosed: boolean, excludeTurns: number[]): string[][] {
  const q = ftsQuery(query);
  if (!q) return [];
  const lists: string[][] = [];
  try {
    lists.push(
      (
        db
          .query(
            `SELECT f.id FROM facts_fts JOIN facts f ON f.id = facts_fts.rowid
             WHERE facts_fts MATCH ? AND ${vis("f")} ${includeClosed ? "" : `AND ${OPEN_FACT_SQL}`}
             ORDER BY bm25(facts_fts) LIMIT ?`,
          )
          .all(q, limit) as { id: number }[]
      ).map((r) => `fact:${r.id}`),
    );
    lists.push(
      (
        db
          .query(
            `SELECT e.id FROM episodes_fts JOIN episodes e ON e.id = episodes_fts.rowid
             WHERE episodes_fts MATCH ? AND ${vis("e")} ORDER BY bm25(episodes_fts) LIMIT ?`,
          )
          .all(q, limit) as { id: number }[]
      ).map((r) => `episode:${r.id}`),
    );
    const ex = new Set(excludeTurns);
    lists.push(
      (
        db
          .query(
            `SELECT t.id FROM turns_fts JOIN turns t ON t.id = turns_fts.rowid
             WHERE turns_fts MATCH ? AND ${VIS_TURN} ORDER BY bm25(turns_fts) LIMIT ?`,
          )
          .all(q, limit) as { id: number }[]
      )
        .filter((r) => !ex.has(r.id))
        .map((r) => `turn:${r.id}`),
    );
  } catch {
    // malformed query: no keyword candidates
  }
  return lists.filter((l) => l.length);
}

export async function vectorCandidates(ctx: Ctx, queries: string[], limit: number): Promise<string[][]> {
  if (!queries.length) return [];
  const vecs = await ctx.llm.embed(queries);
  const model = ctx.config.roles.embed.model;
  return vecs.map((v) =>
    vectorSearch(ctx.db, model, v, ["fact", "episode", "profile"], limit).map((r) => `${r.type}:${r.item}`),
  );
}

/** Reciprocal rank fusion. */
export function rrf(lists: string[][], k = 60): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of lists) l.forEach((key, rank) => out.set(key, (out.get(key) ?? 0) + 1 / (k + rank + 1)));
  return out;
}

// ── scoring ─────────────────────────────────────────────────────────────────

export function recencyFactor(nowTime: number, itemTime: number, importance: number, halfLife: number): number {
  const age = Math.max(0, nowTime - itemTime);
  const hl = halfLife * Math.max(0.5, importance / 5); // important memories decay more slowly
  return 0.25 + 0.75 * Math.exp((-Math.LN2 * age) / hl);
}

function threadHit(item: MemItem, threads: ThreadRow[], threadWords: Set<string>): boolean {
  for (const t of threads) if (json<string[]>(t.entities, []).some((e) => item.entities.includes(e))) return true;
  return words(item.text).some((w) => threadWords.has(w));
}

/**
 * Cap items per subject so near-duplicates can't crowd out everything else; the same
 * text (a repeated action, a fact restated by a turn) is kept only once.
 */
export function diversify<T extends { subject: string | null; score: number; text?: string }>(items: T[], maxPerSubject: number): T[] {
  const count = new Map<string, number>();
  const texts = new Set<string>();
  const out: T[] = [];
  for (const it of [...items].sort((a, b) => b.score - a.score)) {
    if (it.text != null) {
      const key = words(it.text.replace(/^Player: /, "").replace(/\nGM: /, " ")).slice(0, 14).join(" ");
      if (texts.has(key)) continue;
      texts.add(key);
    }
    if (it.subject) {
      const n = count.get(it.subject) ?? 0;
      if (n >= maxPerSubject) continue;
      count.set(it.subject, n + 1);
    }
    out.push(it);
  }
  return out;
}

/**
 * Build ranked memories for this turn: graph + keyword + vector candidates, fused
 * with RRF, reranked, scored by rerank × importance × recency × scene × thread,
 * then diversified. Everything is filtered to the current timeline.
 */
export async function retrieve(ctx: Ctx, input: RetrieveInput, debug?: RetrieveDebug): Promise<Scored[]> {
  const { db, config } = ctx;
  const R = config.retrieval;
  const C = config.components;
  const includeClosed = input.refersToPast;
  const lists: string[][] = [];
  const named: Record<string, string[]> = {};
  const seeds = [...new Set([...input.sceneEntities, ...input.linked])];

  if (C.graph) {
    const g = graphCandidates(db, seeds, R.graphHops, includeClosed).slice(0, R.perList * 2);
    lists.push(g);
    named.graph = g;
  }
  if (C.keyword) {
    input.queries.forEach((q, i) => {
      keywordCandidates(db, q, R.perList, includeClosed, input.excludeTurns).forEach((l, j) => {
        lists.push(l);
        named[`keyword${i}.${j}`] = l;
      });
    });
  }
  if (C.vector) {
    try {
      const vs = await vectorCandidates(ctx, input.queries, R.perList);
      vs.forEach((l, i) => {
        lists.push(l);
        named[`vector${i}`] = l;
      });
    } catch {
      // embeddings unavailable: carry on with the other lists
    }
  }

  const fused = rrf(lists, R.rrfK);
  let keys = [...fused.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const items = loadItems(db, keys);
  keys = keys.filter((k) => items.has(k));
  // Facts closed on this timeline are only wanted for questions about the past.
  if (!includeClosed) keys = keys.filter((k) => items.get(k)!.validTo == null);
  if (debug) {
    debug.lists = named;
    debug.fused = keys;
  }
  const top = keys.slice(0, R.rerankTop);
  if (!top.length) return [];

  let rerank = new Map<string, number>();
  const maxFused = Math.max(...top.map((k) => fused.get(k)!));
  if (C.rerank) {
    const res = await ctx.llm.rerank(input.queries.join("\n"), top.map((k) => items.get(k)!.text));
    if (res) for (const r of res) rerank.set(top[r.index], r.score);
  }
  if (!rerank.size) rerank = new Map(top.map((k) => [k, fused.get(k)! / maxFused]));

  const nowTime = gameTime(db);
  const threads = activeThreads(db);
  const threadWords = new Set(threads.flatMap((t) => words(t.title)));
  const scene = new Set(input.sceneEntities);
  const scored: Scored[] = top.map((k) => {
    const it = items.get(k)!;
    const r = Math.max(0.01, rerank.get(k) ?? 0.01);
    const imp = 0.5 + it.importance / 10;
    const rec = recencyFactor(nowTime, it.gameTime, it.importance, R.recencyHalfLife);
    const sb = it.entities.some((e) => scene.has(e)) ? R.sceneBoost : 1;
    const tb = threadHit(it, threads, threadWords) ? R.threadBoost : 1;
    const sources = Object.entries(named)
      .filter(([, l]) => l.includes(k))
      .map(([n]) => n.replace(/\d.*$/, ""));
    return { ...it, rerank: r, score: r * imp * rec * sb * tb, sources: [...new Set(sources)] };
  });
  return diversify(scored, R.maxPerSubject).slice(0, input.limit ?? 60);
}

/** The tag shown before each memory in a prompt. */
export function memoryTag(db: DB, it: MemItem): string {
  const names = (ids: string[]) =>
    ids.includes("*") ? "everyone" : ids.map((i) => getEntity(db, i)?.name ?? i).join(", ") || "nobody";
  const when = `${formatTime(it.gameTime).replace(/ \d\d:\d\d$/, "")} · T${it.turn}`;
  const range = it.validTo != null ? ` · true until ${formatTime(it.validTo)}` : "";
  if (it.secret) return `[SECRET · ${when}${range} · known by: ${names(it.knownBy)}]`;
  return `[${when}${range} · known by: ${names(it.knownBy)}]`;
}

/** Only what this NPC knows (plus common knowledge). */
export function knownTo(db: DB, items: MemItem[], entity: string): MemItem[] {
  const ids = idsOf(db, entity);
  return items.filter((i) => i.type === "profile" || i.knownBy.includes("*") || i.knownBy.some((k) => ids.includes(k)));
}
