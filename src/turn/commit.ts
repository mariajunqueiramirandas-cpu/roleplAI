import type { Config } from "../config.ts";
import type { DB } from "../db/db.ts";
import { tx } from "../db/db.ts";
import { advanceHead, nextPosition } from "../db/lineage.ts";
import type { Origin } from "../memory/entities.ts";
import { closeFact, factsAbout, insertFact } from "../memory/facts.ts";
import { presentEntities, writePendingMemory, type Resolution } from "../state/engine.ts";
import type { GameEvent } from "../state/events.ts";
import { appendEvent, takeSnapshot } from "../state/projection.ts";
import { currentScene, gameTime, getEntity, nameOf } from "../state/read.ts";
import { now } from "../util.ts";

export interface CommitInput {
  input: string;
  intent: unknown;
  plan: unknown;
  outcome: Record<string, unknown>;
  prose: string;
  resolution: Resolution;
}

/**
 * State facts: the hard state's view of the world, written as `state`-authority facts
 * so the contradiction checks and retrieval see moves and deaths.
 */
function stateFacts(db: DB, events: GameEvent[], o: Origin): number[] {
  const ids: number[] = [];
  for (const e of events) {
    if (e.type === "moved") {
      for (const f of factsAbout(db, e.entity).filter((f) => f.authority === "state" && f.predicate === "is located in")) closeFact(db, f.id, null, o);
      ids.push(
        insertFact(
          db,
          {
            subject: e.entity,
            predicate: "is located in",
            object: e.to,
            statement: `${nameOf(db, e.entity)} is at ${nameOf(db, e.to)}.`,
            authority: "state",
            importance: 4,
            knownBy: [...new Set([...presentEntities(db), e.entity])],
          },
          o,
        ),
      );
    } else if (e.type === "alive_set") {
      for (const f of factsAbout(db, e.entity).filter((f) => f.authority === "state" && (f.predicate === "is dead" || f.predicate === "is alive")))
        closeFact(db, f.id, null, o);
      ids.push(
        insertFact(
          db,
          {
            subject: e.entity,
            predicate: e.alive ? "is alive" : "is dead",
            statement: e.alive ? `${nameOf(db, e.entity)} was brought back to life (${e.cause}).` : `${nameOf(db, e.entity)} is dead (${e.cause}).`,
            authority: "state",
            importance: 8,
            knownBy: [...new Set([...presentEntities(db), e.entity])],
          },
          o,
        ),
      );
    } else if (e.type === "entity_created" && e.description) {
      ids.push(
        insertFact(
          db,
          { subject: e.id, statement: `${e.name} (${e.kind}): ${e.description}`, authority: "canon", importance: 5, knownBy: presentEntities(db) },
          o,
        ),
      );
    }
  }
  return ids;
}

/** Step 8: one SQLite transaction for the turn record, its events and its memories. */
export function commitTurn(db: DB, config: Config, c: CommitInput): { turn: number; origin: Origin; factIds: number[] } {
  return tx(db, () => {
    const pos = nextPosition(db);
    const scene = currentScene(db);
    const timeAfter = c.resolution.timeAfter;
    const r = db
      .query(
        `INSERT INTO turns(segment, parent, scene, game_time, kind, input, intent, plan, outcome, prose, created_at)
         VALUES (?, ?, ?, ?, 'play', ?, ?, ?, ?, ?, ?)`,
      )
      .run(pos.segment, pos.parent, scene, timeAfter, c.input, JSON.stringify(c.intent), JSON.stringify(c.plan), JSON.stringify(c.outcome), c.prose, now());
    const turn = Number(r.lastInsertRowid);
    advanceHead(db, turn, pos.segment);
    const o: Origin = { segment: pos.segment, turn, gameTime: timeAfter };
    for (const e of c.resolution.events) {
      // Ids collide only if background extraction registered the same entity meanwhile.
      if (e.type === "entity_created" && getEntity(db, e.id)) continue;
      // Same clock reading the resolver used, so live state equals replayed state.
      appendEvent(db, e, turn, pos.segment, gameTime(db));
    }
    writePendingMemory(db, c.resolution.memory, o, (f, oo) => insertFact(db, f, oo));
    const factIds = stateFacts(db, c.resolution.events, o);
    db.query("INSERT INTO turns_fts(rowid, text) VALUES (?, ?)").run(turn, `${c.input}\n${c.prose}`);
    const count = (db.query("SELECT COUNT(*) n FROM turns WHERE segment = ?").get(pos.segment) as { n: number }).n;
    if (count % config.snapshotEvery === 0) takeSnapshot(db, turn, pos.segment);
    return { turn, origin: o, factIds };
  });
}
