# Fiber Network Backend — Step 1: Schema

## Setup

1. Install PostgreSQL 14+ with the PostGIS extension available.
2. `cp .env.example .env` and fill in your DB credentials.
3. Create the database: `createdb fiber_network`
4. `npm install`
5. `npm run migrate`

## What's in this step

Tables created, in dependency order:

1. **postgis extension** — enables real geographic types/queries (distance search, nearest-neighbor)
2. **poles** — physical pole locations (`geography(Point)`)
3. **enclosures** — boxes mounted on poles (splice closures, cabinets, NAPs, handholes)
4. **customers** — customer records with location
5. **cables** — feeder/distribution/drop cables, each with a `route` LineString geometry,
   connecting two enclosures (or one enclosure → one customer, for drops)
6. **fiber_cores** — every individual strand inside every cable, with a status
   (available / spliced / terminated / reserved / damaged)
7. **splices** — the record of which core connects to which core, inside which box.
   This table *is* your box documentation (requirement #3/#4) — for any enclosure,
   `SELECT * FROM splices WHERE enclosure_id = ?` gives the full in/out fiber map.

## Design notes

- Distances use `geography` (not `geometry`) types so `ST_DWithin`/`ST_Distance`
  return real meters without manual projection — needed for requirement #8
  (nearest box to a customer).
- A cable's full path (which cores connect to which, end to end) is reconstructed
  by walking the `splices` table across enclosures — this is what powers
  requirement #6 (where a main fiber goes) and #7 (capacity routing), built in Step 2.
- Drop cables are just `cables` with `cable_type = 'drop'`, a `customer_id`, and a
  `customer_label` — the label your techs print at the box (requirement #5).

## Step 2: API

Run with `npm run dev` (after `npm run migrate`). Base URL: `http://localhost:4000/api`

**CRUD:**
- `poles`, `enclosures`, `cables`, `customers` — standard GET/POST/PATCH/DELETE
- `splices` — POST creates a splice and flips both cores to `spliced`; DELETE un-splices and frees both cores back to `available`
- `fiber-cores/:id` — PATCH to mark `terminated` / `damaged` / `reserved`

**Documentation (req #3, #4, #6):**
- `GET /enclosures/:id/documentation` — everything about a box: every cable landing there, every core and its status, every splice record, and a summary count
- `GET /fiber-cores/:id/trace` — walks the splice chain end-to-end to show the full physical path a fiber takes

**Smart capacity endpoints (req #7, #8):**
- `GET /capacity/enclosures` — every box with its live spare-core count
- `GET /capacity/find-source?enclosureId=X` — BFS outward from a full box to the nearest one with spare cores, returning the path of cables to splice through
- `GET /capacity/customer-lookup?lat=&lng=&radius=500` — nearby boxes sorted by real distance (PostGIS), which one (if any) has capacity, and if none do, the suggested source box via the same graph search

Next step: the React + Leaflet frontend — the actual map where you place poles, draw cables, and click into box documentation.

## Phase 4: response formatting

`src/services/responseFormatter.js` turns already-computed structured tool results into short user-facing sentences. It is intentionally separate from the REST routes: existing API responses stay structured and unchanged, and the assistant/orchestration layer can call the formatter after Phase 3 has returned its result.

```js
const { formatResponse } = require('./src/services/responseFormatter');

// Fast, deterministic template formatting is the default.
const sentence = await formatResponse(toolResult);
```

The formatter includes templates for enclosure issue reports, nearest-source/customer lookups, and fiber traces. To opt into the optional phrasing pass for a multi-candidate remediation result only, provide a model adapter explicitly:

```js
const sentence = await formatResponse(toolResult, {
  mode: 'generated',
  generateSummary: async ({ systemPrompt, resultJson, maxTokens }) => {
    // Forward only these prompt/result fields to your constrained model call.
    // Return its plain-text response (or `{ text: '...' }`).
    return model.summarize({ systemPrompt, input: resultJson, maxTokens });
  },
});
```

Generation is off by default, only attempted when an enclosure issue report has at least two summarized candidates (or the result is explicitly tagged as a remediation explanation), and capped at 50 output tokens. It has no database/tool access. Empty, multi-sentence, failed, or numerically ungrounded output falls back to the same template; other result shapes always use templates. The formatter itself is provider-agnostic and introduces no provider dependency; the caller may inject an existing model adapter if Option B is warranted.

## Phase 5: documentation RAG

The `lookupDocs` function tool is exposed at `GET /api/assistant/tools`. Invoke it with `POST /api/assistant/tool-call` and `{ "tool": "lookupDocs", "args": { "query": "..." } }`; `POST /api/assistant/query` is a natural-language wrapper that asks the configured provider to call this tool, then answers only from retrieved docs. The tool embeds the query with `Xenova/all-MiniLM-L6-v2`, retrieves up to three chunks from a local SQLite index by cosine similarity, and passes only the query and those excerpts to the answer model. Results include source/section citations. Low-confidence matches do not trigger an answer model call.

The build-time index sources are the root and backend READMEs plus `knowledge/fiberline-reference.md`. The chunker preserves Markdown section paths and paragraph boundaries, targets roughly 220 model tokens, and caps chunks at 240 tokens to fit MiniLM's context. Build or refresh it after doc changes with `npm run docs:index`. The index is not recomputed on API startup. `npm run bundle:offline` always rebuilds the index before packaging, so release bundles cannot accidentally use a stale index.

The embedding package is an optional install dependency to keep the base CRUD API installable without ONNX model runtimes. Install backend dependencies with network access to build/use RAG; `npm run docs:index` downloads/caches the embedding model on first use. Set `DOC_EMBEDDING_OFFLINE=1` and `TRANSFORMERS_CACHE` to use a prebundled local cache.

## Phase 6: local/cloud inference and offline bundle

Model calls go through the same OpenAI-compatible `chatCompletion` interface and `lookupDocs` `{ tool, args }` router. Use `AI_PROVIDER=local` (default) with `LOCAL_LLM_BASE_URL` pointing at `llama-server`, or `AI_PROVIDER=cloud` with `CLOUD_LLM_BASE_URL`, `CLOUD_LLM_API_KEY`, and `CLOUD_LLM_MODEL`; the tool schema and handlers do not change when switching providers.

Build a CPU llama.cpp server for the target platform with `npm run llama:build` (set `LLAMA_CPP_REF` to pin a release/commit). Then set `LLAMA_MODEL_PATH` to the GGUF selected by the Phase 2 benchmark and run `npm run bundle:offline`. The bundle script stages the GGUF, llama-server binary, Transformers.js model cache, dependencies, and prebuilt `data/docs.sqlite` into ignored `dist/`, prints individual and total sizes, and emits a tarball. Model/index/build artifacts are not checked into Git.

Measure actual load time and the first completion on the lowest-spec supported device—not the development machine—with `BENCHMARK_TARGET=low-end LLAMA_STARTUP_BUDGET_MS=120000 npm run benchmark:local-llm -- --assert-startup-budget`. The repo does not include a Phase 2 winning GGUF or a low-end target CPU, so the model choice, final bundle size, and target-device startup acceptance must be recorded when those are available.
