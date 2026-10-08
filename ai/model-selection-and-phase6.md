# Selected model and Phase 6 gate status

## Selection recorded (2026-10-08)

The user selected **Qwen2.5-1.5B-Instruct Q4_K_M** after running the final constrained llama.cpp comparison with corrected grammar, prompt and scoring. These are **user-reported results**, not measurements reproduced in this sandbox:

| Candidate | Valid JSON | Exact match | Median latency |
| --- | --- | --- | --- |
| Qwen2.5-0.5B-Instruct | 24/24 | 15/24 (62.5%) | 2.58 s |
| **Qwen2.5-1.5B-Instruct** | **24/24** | **23/24 (95.8%)** | **3.97 s** |
| Llama-3.2-1B-Instruct | 24/24 | 13/24 (54.2%) | 3.18 s |

The remaining serviceability/connection-planning miss was accepted by the user as ambiguous. No further prompt iteration or LoRA training is planned. Selection approves the model, **not Phase 6 hardware/package acceptance**.

`benchmark-results.md`, any `benchmark-results-constrained.json`, the comparison harnesses and test queries are not modified by this selection. Existing candidate assets must be kept; this checkout has no GGUF files, so no model files were deleted or moved.

## Active configuration

- Shared configuration: `backend/src/ai/localModelConfig.js`.
- Default llama.cpp API model alias: `qwen2.5-1.5b-instruct-q4_k_m.gguf`.
- Default source asset: `backend/models/gguf/qwen2.5-1.5b-instruct-q4_k_m.gguf` (relative to the backend: `models/gguf/qwen2.5-1.5b-instruct-q4_k_m.gguf`).
- Default API: `http://127.0.0.1:8080/v1`, using the existing constrained `{tool,args}` adapter.
- Explicit `TOOL_ROUTER_MODEL`, `LOCAL_LLM_MODEL`, or legacy `LLM_MODEL` overrides still win. `LLAMA_MODEL_PATH`/`FIBERLINE_GGUF_PATH` override the packaging source asset. API alias and file path are separate: start llama-server with `--model <path> --alias <configured-model-name>`.
- Existing `.env` files are **not rewritten**. If an older checkout points at Ollama on port 11434, update/remove those overrides and use the local llama.cpp settings in `.env.example`. Native Ollama still requires its own explicitly installed model tag; a GGUF filename is not an Ollama tag.
- Cloud remains an explicit option: `AI_PROVIDER=cloud`, `CLOUD_LLM_BASE_URL`, `CLOUD_LLM_API_KEY`, `CLOUD_LLM_MODEL`. It uses the same `{tool,args}` boundary. No automatic provider fallback or unexpected paid API request was added.

## Cold-start confirmation and startup warm-up (2026-10-09)

The user ran `ai/check_cold_start.py` on the selected model: **13.85 s first inference, 2.71 s second inference**, in the same loaded instance without warm-up. Together with the benchmark history, this confirms first-use overhead for the tested session and supports implementing startup warm-up. These are user-reported measurements; the exact internal cause is not profiled, and a model restart/cache eviction can reintroduce the cost.

### Implemented application behavior

- `backend/src/services/routerWarmup.js` runs **one inference-only request per API process startup**, through the same router adapter, selected model, full system prompt and JSON schema used for user queries. It discards the result; no tool executor, database query, documentation retrieval or response formatter is invoked by the warm-up.
- `backend/src/server.js` waits for successful warm-up **before opening the HTTP listener**. Concurrent/repeated warm-up requests share one promise. Timeout, unreachable service or invalid output fails startup; the app does not accept a user query on a cold/unverified router and does not silently retry.
- A generic one-token “ready” completion was deliberately not used: it may load weights without populating the long router system-prefix cache. The actual request is bounded to the normal router completion budget.
- Local llama.cpp requests explicitly set `cache_prompt=true`. For a generic local API that does not support this extension, `TOOL_ROUTER_CACHE_PROMPT=0` omits it; cache behavior then depends on that runtime. Cloud mode skips startup inference entirely, so there is no surprise paid API call.
- The offline launcher loads/health-checks llama-server first and uses **one slot (`--parallel 1`)** so the first user request does not land in a different cold slot. For standalone `npm start`, start the configured model service first with the same settings; the API process does not spawn or download another model server.
- Startup logs report `warmup_ms`. Actual `/api/network/query` requests log `router_latency_ms` before deterministic tool execution, without logging the prompt/output. Warm-up moves latency into app launch; it does not eliminate startup time or guarantee total request time including DB/RAG work.

### Verify the shipping inference path

This sandbox still has no GGUF, llama-server or Python bindings, so **the post-change first-user latency has not been measured here**. Mock tests prove sequencing and failure handling, not the 2.7–4 s latency target. The host's 2 CPUs/~3.8 GiB RAM and lack of Docker/Podman also still prevent the requested 4-CPU/8-GB packaging acceptance.

On the user's Windows machine, from the repository root, start a **fresh** selected-model server in PowerShell (leave it running):

```powershell
& "C:\Users\sws\Desktop\web product images\llama-b11435-bin-win-cpu-x64\llama-server.exe" --model ".\backend\models\gguf\qwen2.5-1.5b-instruct-q4_k_m.gguf" --alias "qwen2.5-1.5b-instruct-q4_k_m.gguf" --host 127.0.0.1 --port 8080 --threads 4 --ctx-size 4096 --parallel 1
```

Once healthy, in another terminal run:

```powershell
cd backend
npm run check:router-startup
```

This invokes the **same application warm-up** followed by one different, inference-only user query via the same HTTP model server. It prints `warmup_ms`, `first_user_inference_ms`, and the 2700–4000 ms reference range, executes no tools, and does not write benchmark files. It is not an end-to-end DB/RAG timing or a model comparison rerun. A value below the range can simply be faster, not a failure.

For the actual UI acceptance check, restart llama-server again, run `npm start`, wait for the API listening message after warm-up, and submit the first real query. Inspect its `router_latency_ms` log. Keep the model process alive between warm-up and the query; do not start a different server for the real request. If routing still takes 13–26 s, investigate cache reuse, slot scheduling and server lifecycle instead of treating this fix as verified. Other model consumers with different prompts or idle eviction (including Ollama keep-alive policies) can invalidate a warmed prefix; this is a startup fix, not an indefinite cache-retention guarantee.

## Packaging: defaults prepared, assembly and acceptance blocked

The existing Linux packaging/launcher scripts now use the selected model by default, with explicit overrides retained. The bundle launcher uses `models/llm/model.gguf` inside the bundle and passes the selected API alias to llama-server. The old 300–700 MiB size warning has been adjusted for the selected 1.5B Q4_K_M asset. No package was assembled and no download was attempted.

Pending release requirements:

1. Measure the first real router query after the implemented application warm-up as described above; the user's Python cold/warm confirmation is complete, but shipping-path latency remains unmeasured.
2. Supply the selected GGUF, a target-platform llama.cpp runtime **including its shared-library dependencies**, the all-MiniLM-L6-v2 embedding assets and prebuilt documentation index. The existing shell bundle is a Linux prototype, not a Windows installer; copying a Windows EXE without its DLLs is not a valid package.
3. Assemble the bundle and record actual component, uncompressed install and archive sizes. Rough estimates (~1 GB GGUF plus ~80 MB embedder) are **not measured totals**; app dependencies, runtime libraries and index also count.
4. Validate startup with networking disabled and confirm that the embedder/index work without downloading assets.
5. On suitable hardware/container infrastructure, cap to 4 CPUs/8 GB, record the host CPU and effective limits, and measure process load, warm-up, readiness, first real call, subsequent call and combined resident memory. Container limits do not emulate an i5 7th-generation CPU or create RAM unavailable on the host.
6. Test the cloud provider option separately without silently changing providers on local failure.

Do not call this Phase 6-complete or release-ready until these checks pass. Existing benchmark history remains the historical record; new packaging measurements belong in a separate Phase 6 report.
