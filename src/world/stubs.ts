import type { DB } from "../db/db.ts";
import { factsAbout } from "../memory/facts.ts";
import { getEntity } from "../state/read.ts";
import { PLAYER } from "../util.ts";

/**
 * Stubs are filled on first touch: when the player goes there, asks about it, or
 * meets someone from there. Returns the stubs this turn touches; the planner is told
 * to fill them, respecting what the stub already says.
 */
export function touchedStubs(db: DB, linked: string[], scene: string[]): string[] {
  const out = new Set<string>();
  const loc = getEntity(db, PLAYER)?.location;
  if (loc && getEntity(db, loc)?.stub) out.add(loc);
  for (const id of [...linked, ...scene]) if (getEntity(db, id)?.stub) out.add(id);
  // Someone present who comes from a stub place.
  for (const id of scene) {
    if (id === PLAYER) continue;
    for (const f of factsAbout(db, id)) {
      if (f.object && /from|lives|hails|born|home/.test(f.predicate) && getEntity(db, f.object)?.stub) out.add(f.object);
    }
  }
  return [...out];
}
