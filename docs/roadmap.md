# Roadmap

Each phase ends when its "done when" passes.

| Phase | Builds | Done when | Status |
|---|---|---|---|
| 0. Foundations | Bun project; SQLite schema and migrations; event log; branches and lineage; story-mode engine (rules, checks, effects, tools as Zod schemas); OpenRouter client with roles, capability check and call logging | Engine unit tests pass; replaying and switching branches rebuild identical state; one structured call works for each role | Built. Engine, replay and branch tests pass. The structured call per role is tested offline; it still needs one run with a key |
| 1. Baseline | CLI; turn pipeline using only direct lookups and recent turns; world generation at the start; first test campaigns and probes | A campaign can be played and evaluated end to end; baseline metrics recorded | Built. Campaigns play and evaluate end to end offline. Baseline metrics and default models: pending a run with a key |
| 2. Remembering | Extraction, linking, facts with time ranges, knowledge and witnesses, contradiction checks | Recall, secrets and state-change probes beat the baseline | Built; needs real-model metrics |
| 3. Retrieval | Keyword, vector, graph, fusion, reranking, scoring, token budget | Retrieval recall@k and probe pass rate beat Phase 2 | Built; each component can be ablated (`eval --ablate`) |
| 4. Verification | Prose checks and regeneration | Contradictions and prose vs state mismatches per 100 turns go down | Built |
| 5. Long play | Summary tree, threads, NPC reflections, consolidation, filling stubs while playing | 2,000-turn campaigns keep their probe pass rate | Built; `long-haul` campaign runs 200 turns offline, set `pad.after` higher for 2,000 |
| 6. Speed and cost | Local models where the evals justify them, caching, cheaper models per role | Same accuracy at lower latency or cost | Not started: needs real-model evals first. Providers sit behind one interface (`src/llm/types.ts`), so local models can plug in there |

## Open risks

| Risk | Plan |
|---|---|
| OpenRouter's rerank models are unknown | Check with a key in Phase 0. The client already falls back to fused ranking when `/rerank` fails, and each failure is logged. Fallback: a local reranker |
| transformers.js under Bun is untested | Test only if a local model is needed (Phase 3 or 6). Fallback: a llama.cpp server running alongside the game |
| Latency: planner, narrator and verifier run one after another | Measure in Phase 1. Options: a fast planner model, skipping the planner on pure-dialogue turns, streaming |
| Extraction quality limits everything downstream | Strongest affordable model for `extractor`, measured by its own component test |
| Cost per turn | Logged per call from day one and reviewed at each phase |
