# Constrained tool router

Phase 2 uses Ollama's native structured-output mode rather than free-form chat. The backend is already Node-based and the deployment constraint is a local Ollama model, so the router sends the JSON Schema generated from `tools.json` as Ollama's `format` value. Ollama/llama.cpp performs the constrained decoding; there is no separately maintained GBNF file that can drift from the catalog.

## Implementation

- `tools.json` is the single source of truth for the eight allowed tools.
- `../backend/src/ai/toolRouterSchema.js` converts that catalog into a JSON Schema `oneOf` union. Each branch binds one tool name to that tool's own argument schema.
- `../backend/src/services/toolRouter.js` builds the short prompt, calls only the local Ollama `/api/chat` endpoint, parses the JSON, and performs defense-in-depth schema validation. It returns exactly `{ tool, args }` through `routeToolCall()`.
- The prompt contains the tool descriptions, parameter names, three short examples, and the user's query. It is approximately 740 tokens before the query is expanded.
- The router does not execute handlers, query the database, or provide a free-form answer. Execution remains a later phase.

The default model remains `llama3.2:1b`, with `OLLAMA_NUM_THREADS`/`LLM_NUM_THREADS` and `LLM_TIMEOUT_MS` controlling the local request. If Ollama is unavailable, the service returns a clear `TOOL_ROUTER_UNREACHABLE` or `TOOL_ROUTER_TIMEOUT` error; it does not fall back to a cloud provider.

## Benchmark

The benchmark contains 24 varied queries covering all eight tools, with exact tool and extracted-argument scoring:

```bash
cd backend
npm run benchmark:router
```

Candidate models default to `llama3.2:1b`, `qwen2.5:1.5b`, and `qwen2.5:0.5b`. Override them with `TOOL_ROUTER_MODELS`, repeat cases with `TOOL_ROUTER_RUNS`, and save the report with `TOOL_ROUTER_BENCHMARK_OUTPUT=../ai/benchmark-results.md`.

`benchmarkToolRouter.js` also calls Ollama's `/api/show` for each model and records the reported parameter size and quantization level. This is how the Q4_K_M assumption is checked instead of being inferred from a tag.

The current recorded run is in `benchmark-results.md`. The sandbox has no Ollama binary, running Ollama service, or downloaded candidate weights, so no accuracy, latency, or quantization winner has been claimed yet. Model selection should remain open until the benchmark is rerun on the target CPU with the candidates installed.

## Phase 3 execution boundary

`../backend/src/services/toolExecutor.js` is the execution boundary. It validates the router result against the catalog, rejects unknown or malformed calls, checks referenced enclosure and fiber-core IDs against the live database, and invokes only an explicit in-process handler allowlist. The model never supplies a module path, SQL, or function name. Non-read-only catalog entries would require an explicit authenticated confirmation before their handler could run.

The current checkout has concrete deterministic handlers for the BFS core search, fiber tracing, failure simulation, and customer connection plan. The exact serviceability/remediation/RAG exports named by the Phase 1 catalog are not present yet; those routes return an explicit `TOOL_HANDLER_UNAVAILABLE` result rather than silently calling a similar-looking function or reimplementing business logic.
