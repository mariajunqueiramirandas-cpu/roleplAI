import type { DB } from "./db.ts";
import { getMeta, setMeta } from "./db.ts";
import { now } from "../util.ts";

/**
 * Turns form a tree. A timeline is a chain of segments; the `lineage` table holds,
 * for the current timeline, each segment and the last turn of it that is visible.
 * Any row carrying (segment, turn) is visible iff it falls inside that range.
 */
export function vis(alias: string): string {
  return `EXISTS (SELECT 1 FROM lineage l WHERE l.segment = ${alias}.segment AND ${alias}.turn <= l.max_turn)`;
}

/** Visibility for the turns table itself, where the turn is the row id. */
export const VIS_TURN = `EXISTS (SELECT 1 FROM lineage l WHERE l.segment = t.segment AND t.id <= l.max_turn)`;

export function getHead(db: DB): number {
  return Number(getMeta(db, "head") ?? 0);
}

export function headSegment(db: DB): number {
  const h = getHead(db);
  const r = db.query("SELECT segment FROM turns WHERE id = ?").get(h) as { segment: number } | null;
  return r?.segment ?? 0;
}

export function isVisible(db: DB, segment: number, turn: number): boolean {
  return !!db.query("SELECT 1 FROM lineage WHERE segment = ? AND ? <= max_turn").get(segment, turn);
}

export function rebuildLineage(db: DB, head: number) {
  db.exec("DELETE FROM lineage");
  if (!head) return;
  const t = db.query("SELECT segment FROM turns WHERE id = ?").get(head) as { segment: number } | null;
  if (!t) throw new Error(`No turn ${head}`);
  let seg: number | null = t.segment;
  let max = head;
  const ins = db.query("INSERT INTO lineage(segment, max_turn) VALUES (?, ?)");
  while (seg != null) {
    ins.run(seg, max);
    const s = db.query("SELECT parent, fork_turn FROM segments WHERE id = ?").get(seg) as {
      parent: number | null;
      fork_turn: number | null;
    };
    seg = s?.parent ?? null;
    max = s?.fork_turn ?? 0;
  }
}

/**
 * Where the next turn goes. Acting from the tip of a segment continues it;
 * acting from an earlier turn starts a new segment forked at that turn.
 */
export function nextPosition(db: DB): { segment: number; parent: number | null } {
  const head = getHead(db);
  if (!head) {
    const seg = db.query("INSERT INTO segments(parent, fork_turn, created_at) VALUES (NULL, NULL, ?)").run(now());
    return { segment: Number(seg.lastInsertRowid), parent: null };
  }
  const segment = headSegment(db);
  const tip = (db.query("SELECT MAX(id) m FROM turns WHERE segment = ?").get(segment) as { m: number }).m;
  if (tip === head) return { segment, parent: head };
  const seg = db
    .query("INSERT INTO segments(parent, fork_turn, created_at) VALUES (?, ?, ?)")
    .run(segment, head, now());
  return { segment: Number(seg.lastInsertRowid), parent: head };
}

/** Called in the commit transaction once the new turn row exists. */
export function advanceHead(db: DB, turn: number, segment: number) {
  setMeta(db, "head", String(turn));
  db.query(
    "INSERT INTO lineage(segment, max_turn) VALUES (?, ?) ON CONFLICT(segment) DO UPDATE SET max_turn = excluded.max_turn",
  ).run(segment, turn);
}

/** Turns of the current timeline, oldest first. */
export function timelineTurnIds(db: DB): number[] {
  return (db.query(`SELECT t.id FROM turns t WHERE ${VIS_TURN} ORDER BY t.id`).all() as { id: number }[]).map(
    (r) => r.id,
  );
}
