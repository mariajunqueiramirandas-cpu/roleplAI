# Evaluation

Accuracy is the main goal, so it's measured from the first working loop (Phase 1), before the advanced parts are built.

## Two levels

**Component tests** (fast, cheap, run on every change):
- **Engine:** rules, effects, checks, branches. Pure code, no models.
- **Retrieval:** recall@k on a fixed memory database with known correct answers.
- **Linking:** labeled mentions → expected entity IDs.
- **Contradiction labels:** labeled fact pairs → expected label.

**Campaign runs** (slow, cost money, run before merging pipeline changes):
- Scripted campaigns of 500–2,000 turns with fixed player inputs.
- Probes at set points, each with a known correct answer.

## Probe types

| Probe | Example |
|---|---|
| Recall | "What did the smith ask for?", 300 turns after turn 40 |
| State change | An NPC moved or died; they must not appear in the old place, or alive |
| Secrets | An NPC who wasn't there must not know what was said |
| Aliases | "the old smith", "Mira" and "her" all resolve to the same entity |
| Consistency | Details generated during play (the tower's three floors) stay the same |
| Injected contradiction | A false line is planted in the prose; it must be rejected |
| Branch isolation | After a rewind, memories from the abandoned path must not appear |
| Thread payoff | Open threads surface when they become relevant |

A probe passes if the correct fact made it into the context (checked automatically) and the answer is right (checked by a judge model against the known answer).

## Metrics

- Probe pass rate, by probe type
- Retrieval recall@k
- Contradictions per 100 turns
- Prose vs state mismatches per 100 turns
- Duplicate entities
- Latency, tokens and cost per turn

## Rules

- **Phase 1 records the baseline.** Every later change is compared with it.
- **A component stays only if it helps.** Each one (graph, reranker, keyword search, NPC reflections...) gets a run with it turned off.
- **No silent regressions.** A change doesn't merge if a metric gets worse by more than run-to-run noise.
- **Model choice per role** comes from the same runs: accuracy against cost.
- **External sanity checks:** LoCoMo and LongMemEval, two public benchmarks for long-conversation memory.
