# roleplAI

A single-player role-playing game run entirely by AI, with a real game underneath: health, mana, levels, gold and inventory are tracked exactly, while the story is free to go anywhere.

**Status:** design. No code yet. The documents below are the spec for building it.

## The core idea

The LLM tells the story but never owns the truth. A small set of values (HP, mana, gold, level, inventory, location, who's alive) lives in a database, and only the game engine can change it. Everything else the AI invents is free: it's remembered, never blocked.

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

## Stack

Bun + TypeScript · SQLite (`bun:sqlite`, FTS5, sqlite-vec) · Zod · OpenRouter for all models
