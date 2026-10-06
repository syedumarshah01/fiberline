# Constrained Fiberline tool router

The network-query endpoint routes each natural-language prompt to exactly one catalog operation. It never treats model prose as an answer: the router returns `{ "tool", "args" }`, the deterministic backend handler runs, and the user-facing response is formatted from its result. `lookupDocs` is the exception to network-data formatting: it returns an answer grounded in retrieved project-documentation chunks plus source metadata.

## Catalog and inference

- `tools.json` is the catalog for the eight network-assistant tools. The user reviewed and approved its current contents on 2026-10-05; `schema-review.json` records the approved SHA-256. Any catalog change invalidates that approval and requires another review.
- `../backend/src/ai/toolRouterSchema.js` generates both the Ollama JSON Schema union and OpenAI-compatible function definitions from that catalog.
- `../backend/src/services/toolRouter.js` validates every returned call and exposes the same `{ tool, args }` contract for all inference transports:
  - Local Ollama uses `/api/chat` with the generated schema in `format`.
  - A local OpenAI-compatible server (such as llama.cpp) uses JSON-Schema `response_format`.
  - `AI_PROVIDER=cloud` sends the catalog as required function tools.
- `../backend/src/routes/networkQuery.js` is the active `/api/network/query` integration. It routes, executes, formats, and returns `answer_text` plus the structured tool result expected by the console. The UI displays trace, outage, source-path, connection-plan, and documentation-citation details.
- `../backend/src/services/toolExecutor.js` validates calls and referenced entity IDs, then dispatches only to a deterministic in-process allowlist. The model does not provide SQL, module paths, or executable code.

For Ollama, `LLM_BASE_URL=http://127.0.0.1:11434/v1`, `LLM_TIMEOUT_MS`, and `OLLAMA_NUM_THREADS` configure transport and execution. A model must be set explicitly with `LLM_MODEL` only after Phase 2 benchmark results have been reviewed; there is no runtime model default. Set `TOOL_ROUTER_TRANSPORT=ollama` or `openai` to override transport detection for a local endpoint. For a local OpenAI-compatible server, use `AI_PROVIDER=local`, `LOCAL_LLM_BASE_URL=http://127.0.0.1:8080/v1`, and an explicitly reviewed `LOCAL_LLM_MODEL`. For a cloud-compatible endpoint, set `AI_PROVIDER=cloud`, `CLOUD_LLM_BASE_URL`, `CLOUD_LLM_API_KEY`, and `CLOUD_LLM_MODEL`. The tool catalog and `{ tool, args }` execution boundary do not change when switching providers. The caller does not silently switch to a different provider if inference fails.

## Execution status

Deterministic handlers are present for serviceability, spare-core search, splitter-port remediation, optical-power remediation, fiber tracing, enclosure failure simulation, customer connection planning, and grounded documentation lookup. The authoritative serviceability/remediation rules and thresholds are now recorded in the Phase 5 specs under `../docs/specs/`; the runtime's conformance to every rule remains a separate release check, alongside target-device validation. Focused connector-inventory and serviceability/remediation tests pass. All 24 previously failing branch-only tests are now green after the authorized repairs to stale test fixtures and database stubs. Connector counts remain nullable and fail closed as `CONNECTOR_COUNT_UNAVAILABLE` when unavailable; no connector-count estimate is enabled.

Templates remain the default response formatter. The optional generated phrasing path is separately bounded and falls back when unsafe; the production network-query flow uses the template-first formatter. Documentation answers use up to three retrieved chunks and include their source/section citations in the console.

## Benchmark

The benchmark contains 24 varied queries covering all eight tools, with exact tool and extracted-argument scoring:

```bash
cd backend
npm run benchmark:router
```

The Phase 2 harness now reads local GGUF files from `backend/models/gguf/` and runs them sequentially with the project's local `llama-server`. It expects Q4_K_M candidates for Qwen2.5-0.5B-Instruct, Qwen2.5-1.5B-Instruct, and Llama-3.2-1B-Instruct. Build `llama-server` first with `npm run llama:build`, then run:

```bash
cd backend
npm run benchmark:router
```

By default the harness discovers the three candidates in `models/gguf/`, checks the filenames/size, runs one load-and-inference smoke test on every model, and starts the 24-case comparison only if all three smoke tests pass. Use `TOOL_ROUTER_MODEL_DIR` to change the directory, `TOOL_ROUTER_MODELS` for a comma-separated list of local GGUF filenames/paths, `LLAMA_SERVER_BIN` to select a server binary, `TOOL_ROUTER_RUNS` to repeat cases, and `TOOL_ROUTER_BENCHMARK_OUTPUT=../ai/benchmark-results.md` to save the report. The report records actual local filenames and sizes; repository labels are expected source repos and cannot be authenticated from local files alone. This is a candidate comparison only: do not set a runtime default until the results are reviewed.

`benchmark-results.md` now records the 2026-10-06 exploratory Ollama run. It is not the requested final GGUF comparison: Llama ran as Q8_0 instead of Q4_K_M, and the report lacks local filenames and file sizes. Do not select a default from it. The local-GGUF harness in the current worktree is the intended route for the fair comparison; make sure that updated script is in the checkout you run.

## Grounded documentation retrieval

`lookupDocs` shares the same `{ tool, args }` execution boundary and RAG runtime as the network tools. The authoritative Phase 5 corpus lives together in `docs/specs/`: `serviceability-remediation-rules.md`, `failure-simulation-algorithm.md`, and `capacity-remediation-feature-spec.md`. These are the only index sources; the repository-derived `backend/knowledge/fiberline-reference.md` is not substituted. Build by Markdown section at roughly 200–400 tokens with `Xenova/all-MiniLM-L6-v2`, then retrieve the top 2–3 chunks. The local SQLite index is built before runtime (`cd backend && npm run docs:index`); it is not silently rebuilt on API startup. The corpus covers system rules/logic, not click-by-click UI help. UI how-to coverage remains a separate, open, non-blocking gap.

## Offline packaging

The offline bundle scripts can package a Phase-2-selected GGUF, llama.cpp server, embedding cache, and prebuilt docs index. No GGUF has been selected and no matching-device measurements are available. Phase 6 targets an Intel Core i5 7th generation or newer, 2–4 physical cores, no discrete GPU, and 8GB RAM. The combined resident-memory budget must include the main model (about 2–3GB), all-MiniLM-L6-v2 embeddings (about 80MB), and the vector store. Report resident memory, cold-start model load time, and first-inference latency on matching hardware or an explicitly identified 2–4-core/8GB proxy. None of these results is currently measured; do not claim device acceptance or release readiness.

## Release-gate status (2026-10-05)

- Recorded branch validation: baseline 65/65 passed. Before the authorized failure repairs, the branch had 24 branch-only failures (650/674 passed); the subsequent full backend run with a real local database passed 674/674, with 0 failed and 0 skipped. The repairs aligned test stubs/fixtures with Knex's left-join API, active cable filtering, and the post-migration `in_use`/`spare` core statuses; the approved tool catalog and product behavior were not changed for these failures.
- Recorded `npm run test:migrations` against native PostgreSQL 18.4: 12 passed, 0 failed, 0 skipped. PostGIS is not installed; the existing migration-14/15 tests use their documented geometry/geography function stubs, while connector migration 24 is exercised directly against PostgreSQL.
- Phase 5 regression in this workspace: `node --test backend/tests/docChunker.test.js` passed 7/7 and the broader `npm test` run passed 660/660 without an attached PostgreSQL test service. This rerun does not replace the separately recorded PostgreSQL-backed migration validation.
- Focused connector/serviceability/remediation and model-configuration checks passed. Frontend tests: 138/138 passed; production build succeeded with a large-chunk warning.
- Phase 5 corpus created at `docs/specs/` from the three supplied authoritative files. The local `backend/data/docs.sqlite` index contains 21 section-based chunks (average 289 tokens, range 106–399) embedded with `Xenova/all-MiniLM-L6-v2` (384 dimensions); all five requested retrieval spot-checks returned relevant top-three matches. The separate UI how-to coverage gap remains open and non-blocking.
- No Phase 2 model was selected. The exploratory Ollama results are recorded in `benchmark-results.md`, but they are not a complete fair comparison because Llama used Q8_0 rather than the requested Q4_K_M and exact GGUF filenames/sizes were not captured. The sandbox reports an Intel Xeon host, 2 logical CPUs/1 physical core and about 3.8 GiB RAM, so it is not a valid Phase 6 target or 2–4-core/8GB proxy. Resident-memory, cold-start, and first-inference metrics are still unavailable.

This branch is not release-ready; the tool catalog remains unchanged and its 2026-10-05 review approval is preserved.
