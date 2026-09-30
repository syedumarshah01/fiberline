# Tool-router benchmark

- Date: 2026-09-30T17:25:51.904Z
- Host CPU: Intel(R) Xeon(R) Processor @ 2.60GHz
- Logical CPUs: 2
- Queries: 24 varied cases (1 run each)
- Endpoint: http://127.0.0.1:11434/v1
- Decoder: Ollama `format` JSON Schema generated from `ai/tools.json`, temperature 0

| Model | Installed/available | Valid JSON rate | Correct route + args | Median ms | P95 ms | Quantization |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| llama3.2:1b | no | 0% (0/24) | 0% (0/24) | — | — | — |
| qwen2.5:1.5b | no | 0% (0/24) | 0% (0/24) | — | — | — |
| qwen2.5:0.5b | no | 0% (0/24) | 0% (0/24) | — | — | — |

## Notes

The benchmark could not run because the local Ollama service or candidate models were unavailable. No cloud endpoint was used and no model choice is being claimed. Start Ollama, pull the candidates, then rerun:

```bash
cd backend
TOOL_ROUTER_RUNS=1 npm run benchmark:router
```

- llama3.2:1b: fetch failed
- qwen2.5:1.5b: fetch failed
- qwen2.5:0.5b: fetch failed
