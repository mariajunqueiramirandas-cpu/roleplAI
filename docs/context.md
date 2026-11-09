# Context

How each prompt is built. The goal is the smallest context that holds everything needed, not the biggest one that fits.

## Retrieval

**1. Always included (direct lookups, no search):**
- the player: hard stats, attributes, traits, statuses, custom stats, inventory
- the current location: profile and known nearby places
- every entity in the scene: profile, hard stats, statuses, attitude toward the player
- active threads involving the scene or the player's goals
- in-game time and the current scene summary
- this turn's resolved mechanics (narrator only)

**2. Queries.** The raw input, the linked entity names, the names of active threads, and 2–3 short "what does the GM need to know here?" queries from the `fast` model.

**3. Candidates.** Every list is filtered to the current timeline and to facts that are true now.
- **Graph:** facts 1–2 hops out from the entities in the scene.
- **Keyword (BM25 via FTS5):** over facts, episodes and raw turns. This is what finds invented names like "Xal'thuun".
- **Vector:** over facts, episodes and entity profiles.

**4. Fuse** the lists with reciprocal rank fusion, then **rerank** the top ~100 with the `rerank` model.

**5. Score:** `rerank × importance × recency × scene boost × thread boost`. Recency uses in-game time and decays more slowly for important memories. All weights are tuned by the evals.

**6. Diversify:** cap how many items can be about the same subject, so ten near-identical facts can't crowd out everything else.

**Questions about the past.** If the intent refers to the past ("what did she say back then?"), superseded facts are included too, shown with their time ranges.

## Who sees what

| Role | Gets |
|---|---|
| `planner` | Everything, including secrets, marked as secret |
| `narrator` | The same, plus the resolved plan. Instructed never to reveal what the player character doesn't know |
| NPC dialogue | When an NPC speaks, world facts are limited to what that NPC knows |
| `extractor` | The committed turn and the scene's entities with their IDs |
| `verifier` | The prose, the resolved outcome, hard state and the relevant facts |

## Token budget

- **Target ~16k input tokens by default**, not the model's full window. A smaller, cleaner context is more accurate and cheaper. Tuned by the evals and capped by the model's `context_length`.
- Each prompt section has a priority and a minimum and maximum size.
- Fill order: the must-haves first (rules, hard state, mechanics, player input, last 4 turns), then everything else by score per token.
- An item that doesn't fit is replaced by its summary before it is dropped.
- Token counts are estimated with a safety margin and calibrated per model from the real counts OpenRouter returns.

## Prompt layout

Most stable first, so the prefix can be cached. Most important last, where models pay the most attention.

1. **[cached]** Role, game rules, output format, tool definitions
2. **[cached]** Core canon (the world's frame and rules) and the player character's background
3. **[cached per chapter]** Story so far
4. Scene: location, entities present, relevant threads
5. Retrieved memories, each tagged with its source:
   `[Day 3 · T41 · known by: player, Mira] Mira promised to forge a sword for 3 wolf pelts.`
   `[SECRET · known by: Mira] Mira's brother sold the player's map.`
6. Hard state, marked authoritative: `HP 23/40 · Mana 5/20 · Gold 31 · ...`
7. This turn's mechanics (narrator only): `Persuade Vyr (presence, very hard): 18+4 = 22 vs 20 → success`
8. Recent turns, word for word (default 8)
9. Player input
