# Tool-router benchmark — exploratory Ollama run

- Date: 2026-10-06T08:08:05.753Z
- Host CPU: 11th Gen Intel(R) Core(TM) i5-1135G7 @ 2.40GHz
- Logical CPUs: 8
- Queries: 24 varied cases (1 run each)
- Endpoint: http://127.0.0.1:11434/v1
- Decoder: Ollama `format` JSON Schema generated from `ai/tools.json`, temperature 0

| Model | Installed/available | Valid JSON rate | Correct route + args | Median ms | P95 ms | Quantization |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| llama3.2:1b | yes | 8% (2/24) | 0% (0/24) | 2331 | 2331 | Q8_0 |
| qwen2.5:1.5b | yes | 21% (5/24) | 21% (5/24) | 2469 | 2787 | Q4_K_M |
| qwen2.5:0.5b | yes | 83% (20/24) | 13% (3/24) | 2180 | 2713 | Q4_K_M |

## Interpretation and limitations

- `qwen2.5:1.5b` had the highest exact tool-and-argument score in this run (5/24, 21%). All five of its valid JSON responses were correct.
- `qwen2.5:0.5b` produced valid JSON much more often (20/24), but only 3/24 responses selected the exact expected tool and arguments. Valid JSON is not the same as a correct route.
- `llama3.2:1b` reported Q8_0, not the requested Q4_K_M quantization, so it is not an apples-to-apples candidate for the requested comparison; it also had 0/24 exact routes.
- The latency percentiles are based on valid JSON responses only, so the sample counts differ by model (2, 5, and 20). Treat them as rough observations, not directly comparable latency distributions.
- This was an Ollama-tag run, not the local-GGUF/llama.cpp harness. It records neither exact repository filenames nor file sizes, and does not verify the local GGUF provenance or total disk footprint.
- This single 24-query run is exploratory. **No default model is selected.** The Llama Q4_K_M candidate and the exact local files still need a matching smoke test and benchmark before the Phase 2 comparison is complete.
