import type { DB } from "../db/db.ts";
import { vis } from "../db/lineage.ts";
import { json } from "../util.ts";
import type { Origin } from "./entities.ts";
import { episodes, type Episode } from "./episodes.ts";

export type SummaryLevel = "chapter" | "arc" | "saga";
export const LEVELS: SummaryLevel[] = ["chapter", "arc", "saga"];

export interface Summary {
  id: number;
  level: SummaryLevel;
  text: string;
  start_turn: number;
  end_turn: number;
  children: string;
}

export function insertSummary(db: DB, level: SummaryLevel, text: string, children: number[], start: number, end: number, o: Origin) {
  db.query(
    "INSERT INTO summaries(level, text, start_turn, end_turn, children, segment, turn) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(level, text, start, end, JSON.stringify(children), o.segment, o.turn);
}

export function summaries(db: DB, level: SummaryLevel): Summary[] {
  return db.query(`SELECT * FROM summaries e WHERE e.level = ? AND ${vis("e")} ORDER BY e.start_turn`).all(level) as Summary[];
}

/** Children (episode or summary ids) already rolled into a visible summary of `level`. */
function rolledIds(db: DB, level: SummaryLevel): Set<number> {
  return new Set(summaries(db, level).flatMap((s) => json<number[]>(s.children, [])));
}

export function unrolledEpisodes(db: DB): Episode[] {
  const rolled = rolledIds(db, "chapter");
  return episodes(db)
    .filter((e) => !rolled.has(e.id))
    .sort((a, b) => a.id - b.id);
}

export function unrolled(db: DB, level: SummaryLevel): Summary[] {
  const parent = LEVELS[LEVELS.indexOf(level) + 1];
  if (!parent) return summaries(db, level);
  const rolled = rolledIds(db, parent);
  return summaries(db, level).filter((s) => !rolled.has(s.id));
}

/**
 * "Story so far": older history at a coarser level. Every saga, then arcs, chapters
 * and scenes not yet rolled up, oldest first.
 */
export function storySoFar(db: DB): { level: string; text: string; start: number }[] {
  const out: { level: string; text: string; start: number }[] = [];
  for (const s of summaries(db, "saga")) out.push({ level: "saga", text: s.text, start: s.start_turn });
  for (const s of unrolled(db, "arc")) out.push({ level: "arc", text: s.text, start: s.start_turn });
  for (const s of unrolled(db, "chapter")) out.push({ level: "chapter", text: s.text, start: s.start_turn });
  for (const e of unrolledEpisodes(db)) out.push({ level: "scene", text: e.summary, start: e.start_turn });
  return out.sort((a, b) => a.start - b.start);
}
