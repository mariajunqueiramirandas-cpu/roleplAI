import type { DB } from "../db/db.ts";
import { vis, VIS_TURN } from "../db/lineage.ts";
import { json } from "../util.ts";
import type { Origin } from "./entities.ts";
import { addKnowledge } from "./facts.ts";

export interface Episode {
  id: number;
  scene: number;
  summary: string;
  participants: string;
  place: string | null;
  start_time: number;
  end_time: number;
  start_turn: number;
  end_turn: number;
  importance: number;
  segment: number;
  turn: number;
}

export interface TurnRow {
  id: number;
  segment: number;
  parent: number | null;
  scene: number;
  game_time: number;
  kind: string;
  input: string;
  intent: string | null;
  plan: string | null;
  outcome: string | null;
  prose: string;
  importance: number;
  extracted: number;
}

export function insertEpisode(
  db: DB,
  ep: Omit<Episode, "id" | "segment" | "turn">,
  knownBy: string[],
  o: Origin,
): number {
  const r = db
    .query(
      `INSERT INTO episodes(scene, summary, participants, place, start_time, end_time, start_turn, end_turn, importance, segment, turn)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ep.scene, ep.summary, ep.participants, ep.place, ep.start_time, ep.end_time, ep.start_turn, ep.end_turn, ep.importance, o.segment, o.turn);
  const id = Number(r.lastInsertRowid);
  db.query("INSERT INTO episodes_fts(rowid, summary) VALUES (?, ?)").run(id, ep.summary);
  for (const k of new Set(knownBy)) addKnowledge(db, "episode", id, k, o);
  return id;
}

export function episodes(db: DB, opts: { participant?: string; limit?: number; afterId?: number } = {}): Episode[] {
  const rows = db
    .query(`SELECT * FROM episodes e WHERE ${vis("e")} AND e.id > ? ORDER BY e.id DESC LIMIT ?`)
    .all(opts.afterId ?? 0, opts.limit ?? 1000) as Episode[];
  return opts.participant ? rows.filter((e) => json<string[]>(e.participants, []).includes(opts.participant!)) : rows;
}

export function getEpisodes(db: DB, ids: number[]): Episode[] {
  if (!ids.length) return [];
  return db.query(`SELECT * FROM episodes e WHERE e.id IN (${ids.map(() => "?").join(",")}) AND ${vis("e")}`).all(...ids) as Episode[];
}

export function episodeForScene(db: DB, scene: number): Episode | null {
  return db.query(`SELECT * FROM episodes e WHERE e.scene = ? AND ${vis("e")} ORDER BY e.id DESC LIMIT 1`).get(scene) as Episode | null;
}

export function getTurn(db: DB, id: number): TurnRow | null {
  return db.query("SELECT * FROM turns WHERE id = ?").get(id) as TurnRow | null;
}

/** The last n play turns on the current timeline, oldest first. */
export function recentTurns(db: DB, n: number): TurnRow[] {
  return (
    db
      .query(`SELECT * FROM turns t WHERE ${VIS_TURN} AND t.kind = 'play' ORDER BY t.id DESC LIMIT ?`)
      .all(n) as TurnRow[]
  ).reverse();
}

export function sceneTurns(db: DB, scene: number): TurnRow[] {
  return db.query(`SELECT * FROM turns t WHERE ${VIS_TURN} AND t.scene = ? AND t.kind = 'play' ORDER BY t.id`).all(scene) as TurnRow[];
}

export function unextractedTurns(db: DB): TurnRow[] {
  return db
    .query(`SELECT * FROM turns t WHERE ${VIS_TURN} AND t.kind = 'play' AND t.extracted = 0 ORDER BY t.id`)
    .all() as TurnRow[];
}
