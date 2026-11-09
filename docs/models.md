# Models

All models come from OpenRouter. Each pipeline step uses a named **role**, and each role's model is set in config, so models can be swapped without code changes.

## Roles

| Role | Used for | Needs | Temperature |
|---|---|---|---|
| `narrator` | Prose | The best writing and roleplay | Creative |
| `planner` | Deciding what happens, tool calls | Reliable tool calling and reasoning | Low |
| `extractor` | Facts and entities from turns; world generation steps | Accurate structured output | 0 |
| `verifier` | Contradiction checks, prose checks, duplicate merges | Accurate judgment, cheap | 0 |
| `fast` | Intent, search queries, ambiguous links | Speed and low cost | 0 |
| `embed` | Vectors for memory search | Good English retrieval | — |
| `rerank` | Reordering search results | Accuracy | — |

Each role has a main model plus fallbacks (OpenRouter's `models` list). Default models are picked in Phase 1 with the evals, from the live catalog.

## What OpenRouter offers (checked 2026-11-09)

- **Chat:** 461 models; 397 support tool calling and 387 support structured outputs.
- **Embeddings:** 40 models at `/api/v1/embeddings`, for example `qwen/qwen3-embedding-8b`, `mongodb/voyage-4` and `openai/text-embedding-3-large`. Several are free or nearly free.
- **Rerank:** `/api/v1/rerank` exists but needs a key to list its models. **Unverified.** If it has no good reranker, we run one locally (see [roadmap.md](roadmap.md)).

## How we call it

- **Capabilities at startup.** Fetch `/api/v1/models` (cached on disk) for context length, supported parameters and pricing. Startup fails fast if a role's model lacks what the role needs, for example a planner model that can't call tools.
- **Routing.** Send `provider.require_parameters: true` so requests only reach providers that support the features we use. For roles where consistency matters, pin providers or exclude heavily quantized ones.
- **Structured output.** JSON Schema generated from Zod, and every response is validated with Zod regardless. On a validation failure: one repair call with the errors, then fall back (the planner to a no-change plan, the extractor to its fallback model and a requeue).
- **Prompt caching.** The prompt layout keeps a stable prefix. Add explicit cache breakpoints for providers that need them (Anthropic, Gemini); the rest cache automatically.
- **Logging.** Every call goes into an `llm_calls` table: role, model, provider, tokens (in, out, cached), cost, latency, and whether it needed a repair or failed.
- **API key.** `OPENROUTER_API_KEY` from the environment. Never stored in a campaign file.

## Embeddings

- Every vector records the model that made it. Changing the `embed` model means re-embedding, done by a background job.
- Store vectors at 1024 dimensions. For models trained to support shorter vectors (such as Qwen3-Embedding), truncate and renormalize.
- A 2,000-turn campaign is estimated at about 15k vectors, around 60 MB. At that size sqlite-vec's exact search is fast enough; no approximate index is needed.

## Local models

Not used in the first build. Added only where the evals show latency or cost needs them. Candidates: a reranker, an NLI contradiction classifier, a small entity finder (GLiNER). They would run through transformers.js or a llama.cpp server, behind the same interface as the OpenRouter roles.
