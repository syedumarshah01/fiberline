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
