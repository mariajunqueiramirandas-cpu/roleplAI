import type { DB } from "../db/db.ts";
import { vis } from "../db/lineage.ts";
import { idsOf } from "../state/read.ts";
import type { Origin } from "./entities.ts";

export type Authority = "state" | "canon" | "narrative" | "inferred";
export const AUTHORITY_RANK: Record<Authority, number> = { state: 4, canon: 3, narrative: 2, inferred: 1 };

export interface Fact {
  id: number;
  subject: string;
  predicate: string;
  object: string | null;
  statement: string;
  valid_from_time: number;
  valid_from_turn: number;
  valid_to_time: number | null;
  valid_to_turn: number | null;
  superseded_by: number | null;
  authority: Authority;
  importance: number;
  secret: number;
  source: number;
  segment: number;
  turn: number;
}

export interface NewFact {
  subject: string;
  predicate?: string;
  object?: string | null;
  statement: string;
  authority: Authority;
  importance?: number;
  secret?: boolean;
  /** Entity ids who know it. '*' = common knowledge. */
  knownBy: string[];
}

const OPEN = `NOT EXISTS (SELECT 1 FROM fact_closures c WHERE c.fact = f.id AND ${vis("c")})`;
const SELECT_FACT = `SELECT f.*,
  (SELECT c.valid_to_time FROM fact_closures c WHERE c.fact = f.id AND ${vis("c")} ORDER BY c.id LIMIT 1) AS valid_to_time,
  (SELECT c.valid_to_turn FROM fact_closures c WHERE c.fact = f.id AND ${vis("c")} ORDER BY c.id LIMIT 1) AS valid_to_turn,
  (SELECT c.superseded_by FROM fact_closures c WHERE c.fact = f.id AND ${vis("c")} ORDER BY c.id LIMIT 1) AS superseded_by
  FROM facts f`;

export function insertFact(db: DB, nf: NewFact, o: Origin): number {
  const r = db
    .query(
      `INSERT INTO facts(subject, predicate, object, statement, valid_from_time, valid_from_turn, authority, importance, secret, source, segment, turn)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      nf.subject,
      nf.predicate ?? "",
      nf.object ?? null,
      nf.statement,
      o.gameTime,
      o.turn,
      nf.authority,
      Math.max(1, Math.min(10, Math.round(nf.importance ?? 5))),
      nf.secret ? 1 : 0,
      o.turn,
      o.segment,
      o.turn,
    );
  const id = Number(r.lastInsertRowid);
  db.query("INSERT INTO facts_fts(rowid, statement) VALUES (?, ?)").run(id, nf.statement);
  db.query("INSERT INTO fact_sources(fact, segment, turn) VALUES (?, ?, ?)").run(id, o.segment, o.turn);
  for (const k of new Set(nf.knownBy)) addKnowledge(db, "fact", id, k, o);
  return id;
}

export function addKnowledge(db: DB, type: "fact" | "episode", item: number, entity: string, o: Origin) {
  const exists = db
    .query(`SELECT 1 FROM knowledge k WHERE k.item_type = ? AND k.item = ? AND k.entity = ? AND ${vis("k")}`)
    .get(type, item, entity);
  if (!exists)
    db.query("INSERT INTO knowledge(item_type, item, entity, segment, turn) VALUES (?, ?, ?, ?, ?)").run(
      type,
      item,
      entity,
      o.segment,
      o.turn,
    );
}

export function knowersOf(db: DB, type: "fact" | "episode", item: number): string[] {
  return (
    db.query(`SELECT DISTINCT k.entity FROM knowledge k WHERE k.item_type = ? AND k.item = ? AND ${vis("k")}`).all(type, item) as {
      entity: string;
    }[]
  ).map((r) => r.entity);
}

export function knows(db: DB, entity: string, type: "fact" | "episode", item: number): boolean {
  const ks = knowersOf(db, type, item);
  return ks.includes("*") || idsOf(db, entity).some((id) => ks.includes(id));
}

export function addSource(db: DB, fact: number, o: Origin) {
  db.query("INSERT INTO fact_sources(fact, segment, turn) VALUES (?, ?, ?)").run(fact, o.segment, o.turn);
}

export function sourceCount(db: DB, fact: number): number {
  return (db.query(`SELECT COUNT(*) n FROM fact_sources s WHERE s.fact = ? AND ${vis("s")}`).get(fact) as { n: number }).n;
}

/** Close a fact (the world changed). Never edits the fact row itself. */
export function closeFact(db: DB, fact: number, supersededBy: number | null, o: Origin) {
  db.query(
    "INSERT INTO fact_closures(fact, valid_to_time, valid_to_turn, superseded_by, segment, turn) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(fact, o.gameTime, o.turn, supersededBy, o.segment, o.turn);
}

export function getFact(db: DB, id: number): Fact | null {
  return db.query(`${SELECT_FACT} WHERE f.id = ? AND ${vis("f")}`).get(id) as Fact | null;
}

export function getFacts(db: DB, ids: number[]): Fact[] {
  if (!ids.length) return [];
  return db.query(`${SELECT_FACT} WHERE f.id IN (${ids.map(() => "?").join(",")}) AND ${vis("f")}`).all(...ids) as Fact[];
}

/** Facts about an entity (as subject, optionally as object), true now unless includeClosed. */
export function factsAbout(db: DB, entity: string, opts: { includeClosed?: boolean; asObject?: boolean } = {}): Fact[] {
  const ids = idsOf(db, entity);
  const ph = ids.map(() => "?").join(",");
  const where = opts.asObject ? `(f.subject IN (${ph}) OR f.object IN (${ph}))` : `f.subject IN (${ph})`;
  const args = opts.asObject ? [...ids, ...ids] : ids;
  return db
    .query(`${SELECT_FACT} WHERE ${where} AND ${vis("f")} ${opts.includeClosed ? "" : `AND ${OPEN}`} ORDER BY f.id`)
    .all(...args) as Fact[];
}

export function isOpen(db: DB, fact: number): boolean {
  return !!db.query(`SELECT 1 FROM facts f WHERE f.id = ? AND ${OPEN}`).get(fact);
}

export function allOpenFacts(db: DB): Fact[] {
  return db.query(`${SELECT_FACT} WHERE ${vis("f")} AND ${OPEN} ORDER BY f.id`).all() as Fact[];
}

export const OPEN_FACT_SQL = OPEN;
