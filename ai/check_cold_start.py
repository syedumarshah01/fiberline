"""Two-query diagnostic, not a benchmark rerun or an application warm-up.

Run from any directory: python ai/check_cold_start.py
Requires the selected GGUF and llama-cpp-python on the machine being measured.
Uses the exported application system prompt/schema. Loads ONE Llama instance,
issues exactly two different documentation queries back-to-back, and closes it.
No tools are executed and no files (including benchmark history) are written.

Defaults match the user's Python comparison: n_ctx=2048, max_tokens=200,
temperature=0.0, library-default thread count. Use --threads 4 on a suitable
capped proxy, but record that this differs from an uncapped original run.
Two samples can support a first-use hypothesis, not prove its cause or exclude
later recurrence. User-facing production latency must also be tested through
the shipping llama-server/app integration, not inferred from these bindings.
"""

import argparse
import hashlib
import json
from pathlib import Path
import time

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_MODEL = BASE_DIR.parent / "backend/models/gguf/qwen2.5-1.5b-instruct-q4_k_m.gguf"
QUERIES = (
    "For general design reference, what insertion loss does the specification assume for a 1:32 splitter?",
    "How does the fiber tracing feature work in general?",
)


def measure_two_queries(factory, grammar, config, model_path, threads=None, clock=time.perf_counter):
    settings = {"model_path": str(model_path), "n_ctx": 2048, "verbose": False}
    if threads is not None:
        settings["n_threads"] = threads
    started = clock()
    llm = factory(**settings)
    load_seconds = clock() - started
    timings = []
    try:
        for query in QUERIES:
            started = clock()
            # Do not reset the instance/context between calls. Prefix reuse, if
            # supported by this binding/version, is part of the diagnostic.
            output = llm.create_chat_completion(
                messages=[
                    {"role": "system", "content": config["system_prompt"]},
                    {"role": "user", "content": query},
                ],
                grammar=grammar,
                max_tokens=200,
                temperature=0.0,
            )
            elapsed = clock() - started
            # Surface unsuccessful inference rather than reporting an error's
            # short latency as a successful warm call. Never dispatch a tool.
            route = json.loads(output["choices"][0]["message"]["content"])
            if not isinstance(route, dict) or set(route) != {"tool", "args"} or not isinstance(route["args"], dict):
                raise ValueError("Diagnostic inference did not return a {tool,args} object")
            if route["tool"] != "lookupDocs":
                raise ValueError("Diagnostic documentation query did not route to lookupDocs")
            timings.append(elapsed)
            del route, output
    finally:
        llm.close()
    return {
        "model_path": str(model_path),
        "model_load_s": round(load_seconds, 3),
        "first_inference_s": round(timings[0], 3),
        "second_inference_s": round(timings[1], 3),
        "second_to_first_ratio": round(timings[1] / timings[0], 3) if timings[0] else None,
        "user_reported_median_s": 3.97,
        "second_vs_reported_median_ratio": round(timings[1] / 3.97, 3),
        "n_ctx": 2048,
        "n_threads": threads if threads is not None else "library default",
        "max_tokens": 200,
        "prompt_sha256": hashlib.sha256(config["system_prompt"].encode("utf-8")).hexdigest(),
        "note": "Two calls in one instance; no warm-up, tools, or result-file writes. Compare on the same hardware.",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    parser.add_argument("--config", type=Path, default=BASE_DIR / "router-benchmark-config.json")
    parser.add_argument("--threads", type=int)
    args = parser.parse_args()
    if not args.model.is_file():
        parser.error(f"Selected GGUF is missing: {args.model}. No inference was run.")
    if args.threads is not None and args.threads < 1:
        parser.error("--threads must be positive")
    if not args.config.is_file():
        parser.error(f"Router configuration is missing: {args.config}")
    with args.config.open(encoding="utf-8") as handle:
        config = json.load(handle)
    try:
        import llama_cpp
        from llama_cpp.llama_grammar import LlamaGrammar
    except ImportError:
        parser.error("Install llama-cpp-python in this Python environment; no inference was run.")
    grammar = LlamaGrammar.from_json_schema(json.dumps(config["schema"]))
    report = measure_two_queries(llama_cpp.Llama, grammar, config, args.model, args.threads)
    report["llama_cpp_python_version"] = getattr(llama_cpp, "__version__", "unknown")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
