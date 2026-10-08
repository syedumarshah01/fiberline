"""
Constrained-decoding benchmark for the Fiberline tool-router models.
Uses the application's exported prompt/schema and the existing benchmark cases.

Install:
    pip install llama-cpp-python --prefer-binary --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cpu

Run from the repository root:
    python ai/run_benchmark.py

Or run from ai/:
    python run_benchmark.py

Required beside this script:
    tools.json
    benchmark-queries.json
    router-benchmark-config.json

Model files live in ../backend/models/gguf/, relative to this script.
Results are written beside this script as benchmark-results-constrained.json.

Refresh the exported configuration after application prompt/schema changes.
Run this command from the repository root (exports JSON only; no inference):
    node -e "const fs = require('node:fs'); const r = require('./backend/src/ai/toolRouterSchema'); fs.writeFileSync('ai/router-benchmark-config.json', JSON.stringify({system_prompt: r.buildRouterInstruction(), schema: r.buildRouterResponseSchema()}, null, 2), 'utf8');"

There is deliberately no warm-up inference: first-call latency remains measured.
The candidate list does not select a shipping/default model. Generation settings
and exact-match scoring are preserved from the original benchmark.
"""

import json
import math
import time
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = BASE_DIR / "router-benchmark-config.json"
RESULTS_PATH = BASE_DIR / "benchmark-results-constrained.json"

# Benchmark candidates only; not a runtime model default.
MODELS = {
    "qwen-0.5b": BASE_DIR / "../backend/models/gguf/qwen2.5-0.5b-instruct-q4_k_m.gguf",
    "qwen-1.5b": BASE_DIR / "../backend/models/gguf/qwen2.5-1.5b-instruct-q4_k_m.gguf",
    "llama-1b": BASE_DIR / "../backend/models/gguf/Llama-3.2-1B-Instruct-Q4_K_M.gguf",
}


# ---------- Scoring ----------

def values_match(expected_val, actual_val):
    if isinstance(expected_val, float) or isinstance(actual_val, float):
        try:
            return math.isclose(float(expected_val), float(actual_val), abs_tol=1e-4)
        except (TypeError, ValueError):
            return False
    return expected_val == actual_val


def args_match(expected_args, actual_args, tool_spec):
    # Every expected key must be present and correct.
    for k, v in expected_args.items():
        if k not in actual_args or not values_match(v, actual_args[k]):
            return False
    # Any extra key must match its schema default, not just be ignored.
    param_specs = tool_spec["parameters"]
    for k, v in actual_args.items():
        if k not in expected_args:
            default = param_specs.get(k, {}).get("default")
            if default is None or not values_match(default, v):
                return False
    return True


def score_response(raw_json_str, case, tools_by_name):
    try:
        parsed = json.loads(raw_json_str)
    except (ValueError, TypeError):
        return {"valid_json": False, "exact_match": False}

    # valid_json still means syntactically valid JSON, not independent schema
    # validation. Unexpected JSON shapes must fail scoring rather than crash.
    if not isinstance(parsed, dict):
        return {"valid_json": True, "exact_match": False}

    tool_name = parsed.get("tool")
    args = parsed.get("args", {})
    expected = case["expected"]

    exact = False
    if (
        isinstance(tool_name, str)
        and isinstance(args, dict)
        and tool_name == expected["tool"]
        and tool_name in tools_by_name
    ):
        exact = args_match(expected["args"], args, tools_by_name[tool_name])

    return {"valid_json": True, "exact_match": exact}


# ---------- Run ----------

def main():
    # No independent Python schema builder or hard-coded system prompt: use the
    # application's exact export, including maxLength and the new examples.
    if not CONFIG_PATH.is_file():
        raise SystemExit(
            f"Missing router configuration: {CONFIG_PATH}\n"
            "Export router-benchmark-config.json using the Node command in this file's docstring."
        )

    with CONFIG_PATH.open(encoding="utf-8") as f:
        router_config = json.load(f)
    system_prompt = router_config["system_prompt"]
    schema = router_config["schema"]

    with (BASE_DIR / "tools.json").open(encoding="utf-8") as f:
        tools_spec = json.load(f)
    with (BASE_DIR / "benchmark-queries.json").open(encoding="utf-8") as f:
        test_cases = json.load(f)

    if not test_cases:
        raise SystemExit("benchmark-queries.json contains no test cases.")

    # Lazy imports keep importing this file safe: no model is loaded unless
    # main() is explicitly run.
    from llama_cpp import Llama
    from llama_cpp.llama_grammar import LlamaGrammar

    grammar = LlamaGrammar.from_json_schema(json.dumps(schema))
    tools_by_name = {t["name"]: t for t in tools_spec["tools"]}
    results = {}

    for model_name, model_path in MODELS.items():
        if not model_path.exists():
            print(f"SKIP {model_name}: file not found at {model_path}")
            continue

        print(f"\n=== {model_name} ({model_path}) ===")
        # Construction/loading is outside per-query latency. All cases reuse
        # this instance, and the first case is intentionally not warmed up.
        llm = Llama(model_path=str(model_path), n_ctx=2048, verbose=False)

        try:
            valid_count = 0
            exact_count = 0
            latencies = []
            per_case = []

            for case in test_cases:
                messages = [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": case["query"]},
                ]
                start = time.time()
                try:
                    output = llm.create_chat_completion(
                        messages=messages,
                        grammar=grammar,
                        max_tokens=200,
                        temperature=0.0,
                    )
                    elapsed = time.time() - start
                    raw = output["choices"][0]["message"]["content"]
                except Exception as e:
                    elapsed = time.time() - start
                    raw = f"__ERROR__: {e}"

                latencies.append(elapsed)
                scored = score_response(raw, case, tools_by_name)
                if scored["valid_json"]:
                    valid_count += 1
                if scored["exact_match"]:
                    exact_count += 1

                per_case.append({
                    "id": case["id"],
                    "raw_output": raw,
                    "valid_json": scored["valid_json"],
                    "exact_match": scored["exact_match"],
                    "latency_s": round(elapsed, 3),
                })

            n = len(test_cases)
            results[model_name] = {
                "model_path": str(model_path),
                "valid_json": f"{valid_count}/{n}",
                "exact_match": f"{exact_count}/{n}",
                "avg_latency_s": round(sum(latencies) / len(latencies), 3) if latencies else None,
                "p50_latency_s": round(sorted(latencies)[len(latencies) // 2], 3) if latencies else None,
                "per_case": per_case,
            }

            print(f"  valid JSON:   {valid_count}/{n}")
            print(f"  exact match:  {exact_count}/{n}")
            print(f"  avg latency:  {results[model_name]['avg_latency_s']}s")
        finally:
            # Release this candidate before constructing the next one.
            llm.close()

    # ---------- Save ----------

    with RESULTS_PATH.open("w", encoding="utf-8") as f:
        json.dump(results, f, indent=2)

    print(f"\nFull results written to {RESULTS_PATH}")
    print("Summary:")
    for name, result in results.items():
        print(
            f"  {name}: valid_json={result['valid_json']}, "
            f"exact_match={result['exact_match']}, "
            f"avg_latency={result['avg_latency_s']}s"
        )


if __name__ == "__main__":
    main()
