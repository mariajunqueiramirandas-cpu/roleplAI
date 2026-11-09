# roleplAI

A single-player role-playing game run entirely by AI, with a real game underneath: health, mana, levels, gold and inventory are tracked exactly, while the story is free to go anywhere.

**Status:** built through roadmap phase 5 (see [Roadmap](docs/roadmap.md)). Everything runs and is tested offline. Default models and baseline metrics still need a run with an OpenRouter key.

## The core idea

The LLM tells the story but never owns the truth. A small set of values (HP, mana, gold, level, inventory, location, who's alive) lives in a database, and only the game engine can change it. Everything else the AI invents is free: it's remembered, never blocked.

## Quick start

```sh
bun install
export OPENROUTER_API_KEY=sk-or-...

bun src/cli.ts models                                  # check the role models against OpenRouter
bun src/cli.ts new campaigns/vale.db --premise "low fantasy, bandits, a haunted tower" \
                                    --character "a former sailor turned sellsword named Ash"
bun src/cli.ts play campaigns/vale.db
```

No key? Add `--mock` to any command (or set `ROLEPLAI_PROVIDER=mock`). It uses a deterministic offline provider: a fixed sample world, hashed bag-of-words embeddings and a rule-based stand-in GM. It's there for development, tests and evals, not for real play.

In play, type what your character does or says. `((` starts an out-of-character question. Commands: `/status /history /undo [n] /rewind <turn> /save <name> /load <name> /slots /branches /pref <key> <value> /cost /debug /consolidate /quit`. The campaign file is the save file.

## Tests and evals

```sh
bun test                                   # unit + component tests, offline (~2s)
bun src/cli.ts eval --mock                 # scripted campaigns with probes
bun src/cli.ts eval --ablate rerank,graph  # same, with components turned off
bun src/cli.ts eval --baseline eval-reports/  # fail on regressions beyond noise
bun src/cli.ts eval --components           # retrieval recall@k, linking, contradiction labels
bun src/cli.ts bench longmemeval data.json # external sanity checks (LongMemEval, LoCoMo)
```

## Docs

| Doc | What it covers |
|---|---|
| [Architecture](docs/architecture.md) | The rules every part must keep, the turn pipeline, stack, code layout |
| [State](docs/state.md) | Hard core vs soft state, story mode, the engine's tools, event log and branches |
| [Memory](docs/memory.md) | What gets remembered, and how memories are saved and kept consistent |
| [Context](docs/context.md) | How each prompt is built: retrieval, ranking, token budget, layout |
| [World generation](docs/world-generation.md) | Creating the world at the start and while playing |
| [Models](docs/models.md) | Which model does what, and how we use OpenRouter |
| [Evaluation](docs/evaluation.md) | How accuracy is measured |
| [Roadmap](docs/roadmap.md) | Build phases and open risks |
| [Decisions](docs/decisions.md) | What's been decided, and why |

## Code map

| Path | What's there |
|---|---|
| `src/db/` | Schema and migrations, lineage (which rows are on the current timeline) |
| `src/state/` | Engine (rules, checks, effects), the planner's tools as Zod schemas, events, projections, replay and snapshots |
| `src/memory/` | Entities and aliases, facts with time ranges and knowledge, episodes, summaries, vectors, preferences |
| `src/ingest/` | Extraction, entity linking, contradiction checks, the write path, consolidation |
| `src/retrieval/` | Graph, keyword (FTS5), vector (sqlite-vec), fusion, reranking, scoring, diversification |
| `src/context/` | Prompt builder, token budget, role prompts |
| `src/world/` | World generation, stubs, the sample world |
| `src/llm/` | OpenRouter client, roles, structured output and repair, the offline provider |
| `src/turn/` | The nine-step turn pipeline and the commit step |
| `src/eval/` | Campaign runner, probes, metrics, component evals, benchmark adapters, campaigns |
| `src/game.ts`, `src/cli.ts` | The game facade (background memory queue, branches, save slots) and the CLI |

## Stack

Bun + TypeScript · SQLite (`bun:sqlite`, FTS5, sqlite-vec) · Zod · OpenRouter for all models
