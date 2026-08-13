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

## What's still manual / next steps if you want to keep going

- **Auth** — no login/roles yet; anyone with API access can write. Needed before this touches production data.
- **Cable geometry is exactly what you draw** — a cable is stored as the straight segment between its two boxes when no duct bends are placed, or as a polyline through every bend you click. It is never silently snapped to roads. Set `STREET_ROUTING=on` in the backend env to opt into street routing (via OSRM) if you want road-following geometry instead.
- **Multi-hop cable segments** — a single physical cable currently connects exactly two enclosures. If a feeder cable physically passes through several poles before terminating, model it as several `cable_segments` chained together (mentioned in the schema notes) rather than one row.
- **Editing/deleting spliced cores safely** — deleting a cable currently cascades and could silently orphan splice records; add a guard before going live.
