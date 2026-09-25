# Fiberline — Fiber Network Operations App

## Structure

```
fiber-network-app/
  backend/    Express API + PostgreSQL/PostGIS (Steps 1–2)
  frontend/   React + Leaflet map UI (Step 3)
```

## Running it

**1. Database + API**

```
cd backend
cp .env.example .env      # set your Postgres credentials
npm install
npm run migrate
npm run dev                # http://localhost:4000
```

To start over with an empty database: `cd backend && npm run db:reset` (see `backend/README.md` for the lighter `--truncate` option and the manual equivalents).

**2. Frontend**

```
cd frontend
npm install
npm run dev                # http://localhost:5173, proxies /api to :4000
```

## How the map maps to your requirements

| Requirement                            | Where it lives                                                                                                                         |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| #1 Poles + cables on a map             | "Add pole" / "Draw cable" modes — real OSM map, real coordinates                                                                       |
| #2 Enclosures on poles                 | "Add box" mode — click a pole, attach a box                                                                                            |
| #3 Core in/out per box                 | Box documentation panel (right side) — every core landing at a box, plus the splice table showing exactly which core connects to which |
| #4 Full box documentation              | Same panel — `GET /enclosures/:id/documentation`                                                                                       |
| #5 Drop cable customer label           | Drop cables carry a `customer_label`, shown on the cable and in the box doc                                                            |
| #6 Where a fiber goes                  | Cable detail panel → "Trace" on any core, walks the splice chain end-to-end                                                            |
| #7 Bring a connection from another box | "No spare cores here" button in the box panel → BFS to nearest box with capacity + the path                                            |
| #8 Customer location lookup            | "Locate customer" mode — click the map, see nearby boxes, capacity, and a suggested source box if none are free                        |

Extras on top of the original list: cables show their name label on the map once zoomed in (≥ zoom 15, all three map providers); boxes show their code the same way at ≥ zoom 17 (and on hover/selection at any zoom, so dense areas stay readable); the new-splice form spotlights a fiber's cable on the map while you hover its entry (custom dropdown, all providers); splices accept a free-text note (shown in the records table, edit form, and wiring view); and the box wiring view is built around explicit numbered splice pairs (S1, S2, …) — each pair's two fiber ports share a color and tag, joined by a wire, with a plain-text splice map below that highlights the same pair on hover.

More ops details: the draw-cable form defaults to a 1-fiber drop when the destination is a customer box and 12 cores otherwise; spliced cables march their dashes on the Leaflet map (drops march faster); splitters can be cascaded (`input_port` — a splitter fed by a free port of another splitter, migration `20260101000011`, guarded against deleting a parent that still feeds a child); each IN fiber in the wiring view shows what its far end connects to in the upstream box; and splitter names/notes are written in plain language (no UUID fragments).

**Loss budgets (req #6+):** the Trace button on any core now also computes the optical loss budget for that path — `GET /api/fiber-cores/:id/loss-budget`. Fiber loss is `length_m × attenuation_db_per_km` (0.35 dB/km singlemode default, overridable per cable in the cable editor; a mid-span split copies the override to the downstream half), each splice adds its measured OTDR/power-meter reading or a planning default (0.1 dB fusion / 0.3 dB mechanical), and every splitter the path crosses adds its insertion loss (G.671 planning values, or the measured `splitters.loss_db`) — cascade parents included. The total is compared against the OLT budget (GPON Class B+ 28 dB, XGS-PON N1 29 dB, P2P 24 dB — per-project via `project_settings`, migration `20260101000012`, editable from the budget card) and verdicts come back OK / MARGINAL / FAIL with a 3 dB safety margin. The path list shows a running loss total per segment, color-coded teal (measured) vs amber (assumed default) vs red (flagged). Free QC win: any splice whose recorded loss exceeds 0.5 dB is auto-flagged as a bad splice — in the trace budget and in the box documentation panel (`qc_flags.bad_splices`).

**Outage analysis — "simulate failure":** pick a pole, box or cable and hit *Simulate failure*; the app takes it out of the network and answers who goes dark. `GET /api/impact/simulate?kind=box|pole|cable&id=<uuid>` walks outward from the failure point through every fiber that passes through it (a box: every splice whose core lands there, every splitter in it; a cable: every core it carries; a pole: every box mounted on it and every span whose route passes within `radius_m` of it, default 15 m), then follows the splice/splitter chain *customer-ward only* and collects the terminations behind it.

**What counts as dark:** a fibre is dark when the headend's light reached it before the failure and does not reach it now — light leaves the OLT's root cores and travels splices (either way), splitter ports (input → output only: light never flows backwards through a splitter) and mid-span continuations, and it does not pass through anything that failed. That definition gives the honest answers:

- the span that *feeds* the failed element is **not** dark: it still carries light up to the break, and the box it came from is still lit;
- failing a mid-span joint reddens the joint, the half below it and the drops behind those customers — not the whole route back to the OLT, and not the branches that merely share an upstream box;
- a fibre whose light has a second path (a second run into the same box, a ring) stays lit: losing one path is not an outage while another is up;
- failing the headend's own box is different — that is the light source, so everything goes dark;
- a span is one physical cable but many fibres, so a cable that lost *some* of them is reported (and drawn) as **partly out** — `cores_dark` / `cores_in_service` / `partially_dark` on each `affected.cables` entry, `affected.partial_cable_count`, a thinner broken red line on the map, and `+N partly out` next to the count in the panel — never as a span that is gone. Spares are not counted: an unused strand cannot go dark.

Direction is what makes this work: light flows from the headend root (`headends.root_enclosure_id`). Without one the app says so and walks both ways from the failure point, which may include the feeding span and lit branches — set the root on the OLT box and the red follows the light.

The answer is `{ affected_count, affected{ customers, boxes, cables, cores }, upstream_reroute_candidates, unreached, warnings }` — each affected customer carries the label, the hops below the failure, its serving box and `path_through_failure` (the exact fiber-by-fiber route its light used to take).

**The mid-span link in the API:** every cable the API returns says what it continues, whether or not the database has the column. `GET /api/cables` (and `GET /api/cables/:id`, and each entry in a failure report's `affected.cables`) carries:

```json
{ "continues_cable_id": "…", "continues_cable_code": "CBL-F1",
  "continues_at_box_id": "…", "continues_at_box_code": "BOX-MID",
  "continuation_inferred": false,
  "continued_by": [ { "id": "…", "code": "CBL-F1-B", "at_box_code": "BOX-MID" } ] }
```

Upstream is one field pair, exactly like the column; downstream is a list, because a span can be split more than once. When the database has no `cables.continues_cable_id`, the same fields come back with `continuation_inferred: true` and the link the app worked out from the naming rule — so a client never has to know which kind of database it is talking to, and the SQL never names a column that is not there. The cable panel shows it as *"Continues CBL-F1 through BOX-MID (inferred from cable naming)"* / *"Split into CBL-F1-B at BOX-MID"*.

**Mid-span closures:** inserting an enclosure into an existing cable cuts that cable in two — the upstream half keeps its cores and now ends at the new box, and a downstream half continues from it. The two halves are one fiber, so the downstream row records `cables.continues_cable_id` (migration `20260101000014`, which also backfills splits that already existed where the pairing is unambiguous). Every joint-walking view follows that link: the failure simulation paints the whole chain below the inserted box — the joint and everything the joint fed, while the half that feeds *it* stays lit — and counts its customers whether the cores were already lit (*the route auto through-splices live cores at insert time*) or merely available when the box went in, the fiber trace shows the step as *through <box> (fusion splice)* and prices it at a fusion splice in the loss budget, and the customer path reads `CBL-F1 #1 → through BOX-MID → CBL-F1-B #1`. A hand-made pair of halves with no link is still reported honestly — the simulation says the cores behind the closure are not reachable from the root and points at `continues_cable_id`. **You do not have to migrate for this to work.** When the column is absent the app applies the same rule at read time — a downstream cable named `<upstream code>-B` starting where the upstream one ends, same type and core count, split points within 25 m — so the failure simulation, the trace and the loss budget walk across an inserted closure either way, and the report says `N mid-span cable links inferred from cable naming` instead of failing. Recorded links always win: once the column exists, a `NULL` means "not a continuation" and is never guessed. **To record the links explicitly: run `npm run migrate`** — migration 14 adds the column, and migration 15 (`20260101000015_repair_cable_continuations.js`) is a repair pass that ensures it regardless of what the ledger claims, for the case where a failed run left the ledger and the database disagreeing (a recorded migration never runs again, so nothing else can recover that). Until you do, nothing breaks and nothing is switched off: the absence is reported as a *notice*, not a warning — the API startup banner prints `· Mid-span cable links: … links are inferred from cable naming … Everything works` (where a real gap prints `!`), the outage report adds `N mid-span cable link(s) inferred from cable naming` alongside its results, and the insert-enclosure route answers `summary.continuation_recorded: false, continuation_inferred: true`. If the API's own read of the column fails — a stale cached schema answer, or a column dropped behind a running process — it re-checks, drops the column from its query and infers the links rather than failing the request. `npm run db:schema` in `backend/` prints which database the API is really talking to, which migrations are applied, whether the columns are there, and how many splits are linked — plus any pair that still looks unlinked, exit 1 when something needs attention (the answer to "but I *did* run migrate"). Migration 14's backfill only links pairs it can be sure of, so for a split it skipped: `npm run db:link-splits` lists them (read-only) and `-- --apply` links them; a downstream cable you renamed can be linked explicitly with `-- --child CBL-F9-B --parent CBL-F9`. The failure simulation names the pair in its own warning when an outage is blocked by an unlinked split.

How a leg is counted as a customer: when its cable carries a `customer_id` or `customer_label`, when the core is `terminated`, when the core is a lit (`spliced`) strand of a `drop` cable — a drop exists to reach exactly one premises, so it counts even if nobody typed a label — or when a lit core lands in a `terminal` customer box. Legs inferred that way are listed as *Unlabelled drop on CBL-…* (with the reason) instead of being dropped from the list, and `affected.unnamed_count` reports how many there are; spare (`available`/`reserved`) strands never count. So a red drop cable always has a customer behind it in the count.

Direction comes from a **headend**: migration `20260101000013` adds a `headends` table (one row per OLT/CO/PoP — `code`, `site_type`, and `root_enclosure_id`, the box the first feeder lands in) plus `/api/headends` CRUD. Every trace is rooted there, so a failure below a splitter never reports the customers on other ports, and a sibling branch spliced off the same feeder core at the same box stays lit. If no headend is configured (or the failure point cannot reach one — a broken feeder), the analysis still runs, but it says so in `warnings` and over-reports, because an undirected walk also climbs back up through the network; the panel offers a one-click *Set this box as the network root*. Restoration suggestions reuse the requirement-#7 BFS (`capacityGraph`), started at each box where affected customers would have to be re-spliced, skipping boxes that are dark (you cannot patch light through a dead splice) and preferring the nearest still-lit box with spare cores; when no cable path exists the suggestion says so and names the nearest lit box plus the distance a new span would cover.
## What's still manual / next steps if you want to keep going

- **The network root** — outage analysis needs one `headend` row per OLT/CO (the box the first feeder lands in) to know which way is downstream. Setting it is one click from the failure panel, but nothing sets it for you: with no headend the analysis still answers, and tells you it is over-reporting.
- **Pole failures are geometric** — spans through a failed pole are found by proximity to the pole (default 15 m, `?radius_m=` up to 200 m), not by electrical continuity, so a span routed well clear of the pole is not counted.
- **Auth** — no login/roles yet; anyone with API access can write. Needed before this touches production data.
- **Cable geometry is exactly what you draw** — a cable is stored as the straight segment between its two boxes when no duct bends are placed, or as a polyline through every bend you click. It is never silently snapped to roads. Set `STREET_ROUTING=on` in the backend env to opt into street routing (via OSRM) if you want road-following geometry instead.
- **Multi-hop cable segments** — a single physical cable currently connects exactly two enclosures. If a feeder cable physically passes through several poles before terminating, model it as several `cable_segments` chained together (mentioned in the schema notes) rather than one row.
- **Editing/deleting spliced cores safely** — deleting a cable currently cascades and could silently orphan splice records; add a guard before going live.
