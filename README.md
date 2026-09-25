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

**Outage analysis — "simulate failure":** pick a pole, box or cable and hit *Simulate failure*; the app takes it out of the network and answers who goes dark. `GET /api/impact/simulate?kind=box|pole|cable&id=<uuid>` walks outward from the failure point through every fiber that passes through it (a box: every splice whose core lands there, every splitter in it; a cable: every core it carries; a pole: every box mounted on it and every span whose route passes within `radius_m` of it, default 15 m), then follows the splice/splitter chain *customer-ward only* and collects the terminations behind it. The answer is `{ affected_count, affected{ customers, boxes, cables, cores }, upstream_reroute_candidates, unreached, warnings }` — each affected customer carries the label, the hops below the failure, its serving box and `path_through_failure` (the exact fiber-by-fiber route its light used to take).

Direction comes from a **headend**: migration `20260101000013` adds a `headends` table (one row per OLT/CO/PoP — `code`, `site_type`, and `root_enclosure_id`, the box the first feeder lands in) plus `/api/headends` CRUD. Every trace is rooted there, so a failure below a splitter never reports the customers on other ports, and a sibling branch spliced off the same feeder core at the same box stays lit. If no headend is configured (or the failure point cannot reach one — a broken feeder), the analysis still runs, but it says so in `warnings` and over-reports, because an undirected walk also climbs back up through the network; the panel offers a one-click *Set this box as the network root*. Restoration suggestions reuse the requirement-#7 BFS (`capacityGraph`), started at each box where affected customers would have to be re-spliced, skipping boxes that are dark (you cannot patch light through a dead splice) and preferring the nearest still-lit box with spare cores; when no cable path exists the suggestion says so and names the nearest lit box plus the distance a new span would cover.
## What's still manual / next steps if you want to keep going

- **The network root** — outage analysis needs one `headend` row per OLT/CO (the box the first feeder lands in) to know which way is downstream. Setting it is one click from the failure panel, but nothing sets it for you: with no headend the analysis still answers, and tells you it is over-reporting.
- **Pole failures are geometric** — spans through a failed pole are found by proximity to the pole (default 15 m, `?radius_m=` up to 200 m), not by electrical continuity, so a span routed well clear of the pole is not counted.
- **Auth** — no login/roles yet; anyone with API access can write. Needed before this touches production data.
- **Cable geometry is exactly what you draw** — a cable is stored as the straight segment between its two boxes when no duct bends are placed, or as a polyline through every bend you click. It is never silently snapped to roads. Set `STREET_ROUTING=on` in the backend env to opt into street routing (via OSRM) if you want road-following geometry instead.
- **Multi-hop cable segments** — a single physical cable currently connects exactly two enclosures. If a feeder cable physically passes through several poles before terminating, model it as several `cable_segments` chained together (mentioned in the schema notes) rather than one row.
- **Editing/deleting spliced cores safely** — deleting a cable currently cascades and could silently orphan splice records; add a guard before going live.
