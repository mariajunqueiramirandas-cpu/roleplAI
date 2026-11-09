# Memory

## What gets remembered

| Store | Holds | Notes |
|---|---|---|
| Turns | Raw player input, plan, resolved outcome, prose | The source for everything else. The last ~8 are always in the prompt word for word |
| Entities | Every NPC, place, item, faction... with a profile | The profile is a cache rebuilt from facts; the facts are the truth |
| Aliases | Every name an entity has gone by | "Mira", "the blacksmith", "the old smith" |
| Facts | Small statements about entities, true over a time range | The main memory. See below |
| Knowledge | Who knows each fact and episode | Powers secrets and NPC-specific context |
| Episodes | One per scene: summary, participants, place, time, importance | For "what happened when" questions |
| Threads | Quests, promises, debts, mysteries, foreshadowing, goals | Status: open, progressing, resolved, failed, abandoned |
| Summaries | Scene → chapter → arc → saga | Older history is read at a coarser level |
| Preferences | The player's tone, content limits and play style | |

## Facts

```
subject        entity id
predicate      free-text hint ("lives in", "owes", "is afraid of")
object         entity id or text
statement      full sentence used in prompts: "Mira lives in Oakvale."
valid_from     game time + turn
valid_to       null while still true
authority      state | canon | narrative | inferred
importance     1–10
secret         true if the player character doesn't know it
source         the turn it came from
superseded_by  the fact that replaced it
segment, turn  branch visibility
```

- **When sources disagree:** state > canon > narrative > inferred. Summaries are never a source of truth; they're rebuilt from facts.
- **The predicate is a hint, not a key.** "Lives in" and "resides at" mean the same thing, so contradiction lookups find candidates by subject plus meaning, not by exact predicate.
- **Once said, it's true.** A narrative fact stands until the story shows it changing. If the tower has three floors, it can't have five later unless something happens to it.

## Saving memories (write path)

Runs in the background after each commit.

1. **Extract.** The `extractor` model reads the turn (input, plan, outcome, prose) and the list of entities in the scene with their IDs. It returns validated JSON: entities mentioned, facts, thread updates and the turn's importance. Giving it the IDs up front prevents most linking mistakes.
2. **Link.** Any mention not already resolved to an ID goes through: exact alias → keyword search on names → vector search on profiles → rerank. The model decides only when the top candidates are close. No good match means a new entity.
3. **Check against what's known.** For each new fact, fetch the subject's currently valid facts that are close in meaning. The `verifier` labels each pair:

   | Label | Action |
   |---|---|
   | duplicate | Keep the old fact; add this turn as another source |
   | new detail | Add the fact |
   | update (the world changed) | Close the old fact (`valid_to` = now), add the new one, link them |
   | contradiction | If the old fact is `state` or `canon`: reject the new one and log it as narrator drift. If both are `narrative`: keep the old one and queue the conflict for consolidation |

4. **Witnesses.** By default a fact is known by everyone present in the scene. The extractor overrides this for whispers, secrets and overheard talk. Information spreads only through events (someone tells someone).
5. **Store** the episode (when a scene ends) and embeddings for new facts, episodes and changed profiles.

## Consolidation

Runs at the end of each scene and every N turns. It never deletes anything.

- **Summaries:** roll scenes up into chapters and chapters into arcs.
- **Profiles:** rebuild entity profiles from their currently valid facts.
- **Duplicate entities:** find likely duplicates by similarity, confirm with the `verifier`, then merge by moving aliases and references. A merge is an event, so it can be undone.
- **Conflicts:** resolve the queued narrative-vs-narrative conflicts.
- **NPC reflections:** when an NPC is about to appear and has several new episodes since their last reflection, write their updated beliefs ("Mira has started to distrust the player") as `inferred` facts. Done only when needed, not for every NPC.
- **Threads:** list threads that haven't been touched for a long time, so the planner can pick them back up.

## Scenes

A scene ends when the location changes, significant time passes, or the planner calls `end_scene`. Scenes are the unit for episodes and the bottom level of the summary tree.
