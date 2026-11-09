# Architecture

## Rules every part of the system must keep

1. **The LLM never owns hard state.** HP, mana, gold, XP, inventory, location, alive/dead and time change only through tool calls the engine validates. See [state.md](state.md).
2. **Tracking is not restricting.** Anything not covered by a hard rule is allowed. Soft facts are remembered and checked for contradictions, never blocked.
3. **The engine never dead-ends the story.** An invalid change goes back to the model as "here is the truth, work with it", never as an error to the player.
4. **Nothing is overwritten.** Events are append-only. Facts are closed and superseded, never edited or deleted.
5. **Every memory has a source:** the turn it came from, in-game time, branch, and who knows it.
6. **Lookups before search.** Anything we can fetch by ID (who's in the scene, the player's inventory) is never left to similarity search.
7. **Everything that exists is registered.** New entities enter through `create` or are registered by extraction. Nothing exists only in prose.
8. **Models are config, not code.** Every model call goes through a named role. See [models.md](models.md).
9. **Every component earns its place.** It stays only if the evals show it helps. See [evaluation.md](evaluation.md).

## Turn pipeline

| # | Step | Done by | What happens |
|---|---|---|---|
| 1 | Understand | `fast` model | Intent (action, dialogue, question, out-of-character) and mentions of people, places and things |
| 2 | Link | code, `fast` if ambiguous | Mentions → entity IDs ("the old smith" → `npc_mira`) using aliases, the current scene, keyword and vector search |
| 3 | Retrieve | code + `embed` + `rerank` | Build the context ([context.md](context.md)) |
| 4 | Plan | `planner` model | Decide what happens, as tool calls: checks with stakes, hard-state changes, new entities, secret facts |
| 5 | Resolve | engine (code) | Roll dice, pick the success or failure branch, validate every change. Invalid changes go back to the planner once, then are dropped with a note |
| 6 | Narrate | `narrator` model | Write the prose, which must follow the resolved outcome |
| 7 | Verify | code + `verifier` model | Check the prose against state and the outcome; regenerate once with the list of problems |
| 8 | Commit | code | One SQLite transaction: turn record, events, new entities |
| 9 | Remember | background, `extractor` model | Extract facts, episodes and threads ([memory.md](memory.md)) |

- **Stakes before the roll.** For a check, the planner declares the success and failure consequences before the engine rolls, so the outcome can't be fudged after seeing the dice.
- **No gap in memory.** The last turns are always in the prompt word for word. If background extraction falls further behind than that window, the next turn waits for it.
- **v1 doesn't stream.** Prose is verified before the player sees it. Streaming can come later if latency hurts.

## Stack

- **Runtime:** Bun + TypeScript.
- **Storage:** one SQLite file per campaign, which is also the save file. `bun:sqlite`, FTS5 for keyword search, `sqlite-vec` for vectors. Both verified under Bun 1.4.4 (SQLite 3.53, sqlite-vec 0.1.9).
- **macOS:** Apple's system SQLite blocks extensions. Call `Database.setCustomSQLite()` with Homebrew's SQLite before opening a database.
- **Schemas:** Zod for tool parameters, model outputs and validation, converted to JSON Schema for structured outputs.
- **Models:** OpenRouter only, through a small `fetch` client.
- **Tests:** `bun test` for unit tests and evals.
- **Interface:** a minimal CLI for development and evals. The real UI is out of scope for now.

## Code layout

```
src/
  db/         schema, migrations, event log, branches
  state/      hard core, rules, checks, effects, the planner's tools
  memory/     entities, facts, episodes, threads, summaries
  ingest/     extraction, entity linking, contradiction checks, consolidation
  retrieval/  lookups, keyword, vector, graph, fusion, reranking
  context/    prompt builder, token budget
  world/      world generation
  llm/        OpenRouter client, model roles, structured output and repair
  turn/       the turn pipeline
  eval/       test campaigns, probes, metrics
```
