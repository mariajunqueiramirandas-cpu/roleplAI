import type { DB } from "../db/db.ts";
import { tx } from "../db/db.ts";
import { getHead, isVisible, rebuildLineage, vis } from "../db/lineage.ts";
import type { GameEvent, StoredEvent } from "./events.ts";

const P_TABLES = ["p_entities", "p_stats", "p_holdings", "p_statuses", "p_traits", "p_threads", "p_world"] as const;

/** Apply one event to the projection tables. Pure function of (state, event). */
export function applyEvent(db: DB, e: GameEvent, turn: number, gameTime: number) {
  switch (e.type) {
    case "entity_created":
      db.query(
        `INSERT INTO p_entities(id, kind, name, description, location, alive, stub, created_turn)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
      ).run(e.id, e.kind, e.name, e.description, e.location, e.alive ? 1 : 0, e.stub ? 1 : 0, turn);
      break;
    case "stat_set":
      db.query(
        `INSERT INTO p_stats(entity, name, toward, value, max, category) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(entity, name, toward) DO UPDATE SET value = excluded.value, max = excluded.max, category = excluded.category`,
      ).run(e.entity, e.stat, e.toward, e.value, e.max, e.category);
      break;
    case "holding_set":
      if (e.qty <= 0) db.query("DELETE FROM p_holdings WHERE holder = ? AND item = ?").run(e.holder, e.item);
      else
        db.query(
          `INSERT INTO p_holdings(holder, item, qty) VALUES (?, ?, ?)
           ON CONFLICT(holder, item) DO UPDATE SET qty = excluded.qty`,
        ).run(e.holder, e.item, e.qty);
      break;
    case "moved":
      db.query("UPDATE p_entities SET location = ? WHERE id = ?").run(e.to, e.entity);
      break;
    case "status_added":
      db.query(
        `INSERT INTO p_statuses(id, entity, label, effects, expires_at, created_at, last_tick) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      ).run(e.id, e.entity, e.label, JSON.stringify(e.effects), e.expiresAt, gameTime, gameTime);
      break;
    case "status_ticked":
      db.query("UPDATE p_statuses SET last_tick = ? WHERE id = ?").run(e.at, e.id);
      break;
    case "status_removed":
      db.query("DELETE FROM p_statuses WHERE id = ?").run(e.id);
      break;
    case "trait_added":
      db.query(
        `INSERT INTO p_traits(entity, label, bonus) VALUES (?, ?, ?)
         ON CONFLICT(entity, label) DO UPDATE SET bonus = excluded.bonus`,
      ).run(e.entity, e.label, e.bonus);
      break;
    case "alive_set":
      db.query("UPDATE p_entities SET alive = ? WHERE id = ?").run(e.alive ? 1 : 0, e.entity);
      break;
    case "time_set":
      setWorld(db, "game_time", String(e.to));
      break;
    case "thread_set":
      db.query(
        `INSERT INTO p_threads(id, kind, title, status, summary, entities, hidden, opened_turn, updated_turn, updated_time)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, title = excluded.title, status = excluded.status,
           summary = excluded.summary, entities = excluded.entities, hidden = excluded.hidden,
           updated_turn = excluded.updated_turn, updated_time = excluded.updated_time`,
      ).run(e.id, e.kind, e.title, e.status, e.summary, JSON.stringify(e.entities), e.hidden ? 1 : 0, turn, turn, gameTime);
      break;
    case "scene_started":
      setWorld(db, "scene", String(e.scene));
      setWorld(db, "scene_start_turn", String(turn));
      setWorld(db, "scene_start_time", String(gameTime));
      break;
    case "check_rolled":
      break;
    case "stub_filled":
      db.query("UPDATE p_entities SET stub = 0 WHERE id = ?").run(e.entity);
      break;
    case "profile_set":
      db.query("UPDATE p_entities SET profile = ? WHERE id = ?").run(e.profile, e.entity);
      break;
    case "described":
      db.query("UPDATE p_entities SET description = ? WHERE id = ?").run(e.description, e.entity);
      break;
    case "entities_merged":
      db.query("UPDATE p_entities SET merged_into = ? WHERE id = ?").run(e.into, e.from);
      // Holdings and stats follow the surviving entity.
      for (const h of db.query("SELECT item, qty FROM p_holdings WHERE holder = ?").all(e.from) as { item: string; qty: number }[]) {
        db.query(
          `INSERT INTO p_holdings(holder, item, qty) VALUES (?, ?, ?)
           ON CONFLICT(holder, item) DO UPDATE SET qty = qty + excluded.qty`,
        ).run(e.into, h.item, h.qty);
      }
      db.query("DELETE FROM p_holdings WHERE holder = ?").run(e.from);
      db.query("UPDATE OR IGNORE p_stats SET entity = ? WHERE entity = ?").run(e.into, e.from);
      db.query("UPDATE p_statuses SET entity = ? WHERE entity = ?").run(e.into, e.from);
      db.query("UPDATE OR IGNORE p_traits SET entity = ? WHERE entity = ?").run(e.into, e.from);
      db.query("UPDATE p_entities SET location = ? WHERE location = ?").run(e.into, e.from);
      break;
    case "world_set":
      setWorld(db, e.key, e.value);
      break;
  }
}

export function setWorld(db: DB, key: string, value: string) {
  db.query("INSERT INTO p_world(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function getWorld(db: DB, key: string): string | null {
  const r = db.query("SELECT value FROM p_world WHERE key = ?").get(key) as { value: string } | null;
  return r?.value ?? null;
}

/** Append an event; apply it to the projections if it is on the current timeline. */
export function appendEvent(db: DB, e: GameEvent, turn: number, segment: number, gameTime: number): number {
  const r = db
    .query("INSERT INTO events(turn, segment, game_time, type, payload) VALUES (?, ?, ?, ?, ?)")
    .run(turn, segment, gameTime, e.type, JSON.stringify(e));
  if (isVisible(db, segment, turn)) applyEvent(db, e, turn, gameTime);
  return Number(r.lastInsertRowid);
}

export function visibleEvents(db: DB, afterId = 0): StoredEvent[] {
  return db.query(`SELECT * FROM events e WHERE e.id > ? AND ${vis("e")} ORDER BY e.id`).all(afterId) as StoredEvent[];
}

function clearProjections(db: DB) {
  for (const t of P_TABLES) db.exec(`DELETE FROM ${t}`);
}

function dumpProjections(db: DB): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const t of P_TABLES) out[t] = db.query(`SELECT * FROM ${t}`).all();
  return out;
}

function loadProjections(db: DB, data: Record<string, Record<string, unknown>[]>) {
  for (const t of P_TABLES) {
    for (const row of data[t] ?? []) {
      const cols = Object.keys(row);
      db.query(`INSERT INTO ${t}(${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(
        ...(cols.map((c) => row[c]) as any[]),
      );
    }
  }
}

/** Stable fingerprint of all hard state, used to prove replays are identical. */
export function stateFingerprint(db: DB): string {
  const out: Record<string, unknown[]> = {};
  for (const t of P_TABLES) {
    const rows = db.query(`SELECT * FROM ${t}`).all() as Record<string, unknown>[];
    out[t] = rows.map((r) => JSON.stringify(r, Object.keys(r).sort())).sort();
  }
  return JSON.stringify(out);
}

export function takeSnapshot(db: DB, turn: number, segment: number) {
  const last = (db.query("SELECT MAX(id) m FROM events").get() as { m: number | null }).m ?? 0;
  db.query("INSERT INTO snapshots(turn, segment, last_event, data) VALUES (?, ?, ?, ?)").run(
    turn,
    segment,
    last,
    JSON.stringify(dumpProjections(db)),
  );
}

/**
 * Rebuild hard state for the current lineage: load the nearest visible snapshot,
 * then replay visible events after it. `useSnapshots: false` replays from scratch.
 */
export function rebuildProjections(db: DB, opts: { useSnapshots?: boolean } = {}) {
  tx(db, () => {
    clearProjections(db);
    let after = 0;
    if (opts.useSnapshots !== false) {
      const snap = db
        .query(`SELECT * FROM snapshots e WHERE ${vis("e")} ORDER BY e.turn DESC LIMIT 1`)
        .get() as { last_event: number; data: string } | null;
      if (snap) {
        loadProjections(db, JSON.parse(snap.data));
        after = snap.last_event;
      }
    }
    for (const ev of visibleEvents(db, after)) applyEvent(db, JSON.parse(ev.payload), ev.turn, ev.game_time);
  });
}

/** Move the timeline head to any turn (undo, load a slot, switch branch). */
export function switchTimeline(db: DB, head: number) {
  tx(db, () => {
    db.query("INSERT INTO meta(key, value) VALUES ('head', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
      String(head),
    );
    rebuildLineage(db, head);
  });
  rebuildProjections(db);
}

export function currentHead(db: DB) {
  return getHead(db);
}
