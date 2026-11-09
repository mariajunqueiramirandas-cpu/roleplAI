# Decisions

| # | Date | Decision | Why |
|---|---|---|---|
| 1 | 2026-11-09 | Single-player local app | Scope. One SQLite file per campaign doubles as the save file |
| 2 | 2026-11-09 | English only | Simpler model choice: English-tuned embeddings and rerankers |
| 3 | 2026-11-09 | World generated at the start and while playing | A consistent foundation plus room to explore anywhere |
| 4 | 2026-11-09 | Story mode is the default | Freedom first, while core stats are still tracked exactly |
| 5 | 2026-11-09 | Bun + TypeScript | Owner's choice. Built-in SQLite and test runner |
| 6 | 2026-11-09 | OpenRouter for every model, API first | Any model available, no GPU needed. Local models only where the evals justify them |
| 7 | 2026-11-09 | Small hard core, everything else soft | Accuracy where it matters without limiting what the AI can do |
| 8 | 2026-11-09 | The model picks labels, the engine picks numbers | No invented or fudged values; balance lives in one place |
| 9 | 2026-11-09 | Stakes are declared before the roll | The model can't change an outcome after seeing the dice |
| 10 | 2026-11-09 | Append-only event log with branch segments | Undo, save slots and alternate paths, without memories leaking between them |
| 11 | 2026-11-09 | At 0 HP the player is downed, not dead (story mode) | Defeat becomes part of the story; permanent death is opt-in |
| 12 | 2026-11-09 | v1 verifies prose before showing it (no streaming) | Accuracy first; revisit if latency hurts |
| 13 | 2026-11-09 | ~16k-token context target, not the full window | A smaller, cleaner context is more accurate and cheaper |
