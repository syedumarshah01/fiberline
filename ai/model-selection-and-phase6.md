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

## Cold-start confirmation: blocked, not measured

The user reported a first call of **26.3 s** versus a **3.97 s** median, consistent across prior runs. That supports first-use overhead, but it does not establish the precise cause or eliminate recurrence. A cold KV/prompt cache is plausible, not confirmed.

This sandbox has **no GGUFs, llama-cpp-python, llama-server, embedding cache or docs.sqlite**. It has no Docker/Podman and exposes 2 CPUs and approximately 3.8 GiB RAM. It is not a valid 4-CPU/8-GB proxy. The Windows download path on the user's machine is not mounted here. Running `python3 ai/check_cold_start.py` failed at the missing-GGUF preflight; it did not load a model or produce latency measurements.

A dedicated two-query diagnostic is ready, separate from the benchmark and its output files. On the machine with the selected GGUF and Python bindings installed, run from the repository root:

```powershell
python ai/check_cold_start.py
```

It loads exactly one `Llama` instance, times construction separately, then times two different harmless documentation questions back-to-back with the same application system prompt/schema and retained instance. It prints load time, both inference latencies, ratios against the user-reported median, prompt hash and binding version to stdout. It discards outputs, executes no tool, and writes no result files. Defaults match the Python comparison (`n_ctx=2048`, `max_tokens=200`, temperature zero, library-default threads). An optional `--threads 4` records a capped-proxy thread choice.

Compare the second call with the median on the **same machine/settings**. If both remain elevated, stop and investigate before proceeding. If the second is near steady-state latency, proceed with product startup warm-up, while recognizing two samples cannot exclude later recurrence. The diagnostic is not a substitute for later testing of the actual llama-server HTTP integration and its cache/slot behavior.

**Warm-up has not been implemented or claimed verified in this change**, because the requested direct confirmation is blocked. The intended next step, once confirmed, is one inference-only call with the real system prompt/schema after server health readiness, before enabling router requests; discard the response without dispatching any tool. Report load time, warm-up time, ready time, and first real user-call latency separately. Warm-up moves work into startup; it does not remove startup cost. Failures must keep the router unready rather than pretending it is warm.

## Packaging: defaults prepared, assembly and acceptance blocked

The existing Linux packaging/launcher scripts now use the selected model by default, with explicit overrides retained. The bundle launcher uses `models/llm/model.gguf` inside the bundle and passes the selected API alias to llama-server. The old 300–700 MiB size warning has been adjusted for the selected 1.5B Q4_K_M asset. No package was assembled and no download was attempted.

Pending release requirements:

1. Complete the cold-start confirmation and inference-only startup warm-up gate above.
2. Supply the selected GGUF, a target-platform llama.cpp runtime **including its shared-library dependencies**, the all-MiniLM-L6-v2 embedding assets and prebuilt documentation index. The existing shell bundle is a Linux prototype, not a Windows installer; copying a Windows EXE without its DLLs is not a valid package.
3. Assemble the bundle and record actual component, uncompressed install and archive sizes. Rough estimates (~1 GB GGUF plus ~80 MB embedder) are **not measured totals**; app dependencies, runtime libraries and index also count.
4. Validate startup with networking disabled and confirm that the embedder/index work without downloading assets.
5. On suitable hardware/container infrastructure, cap to 4 CPUs/8 GB, record the host CPU and effective limits, and measure process load, warm-up, readiness, first real call, subsequent call and combined resident memory. Container limits do not emulate an i5 7th-generation CPU or create RAM unavailable on the host.
6. Test the cloud provider option separately without silently changing providers on local failure.

Do not call this Phase 6-complete or release-ready until these checks pass. Existing benchmark history remains the historical record; new packaging measurements belong in a separate Phase 6 report.
