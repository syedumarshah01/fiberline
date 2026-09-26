# Fiber Network Backend — Step 1: Schema

## Setup

1. Install PostgreSQL 14+ with the PostGIS extension available.
2. `cp .env.example .env` and fill in your DB credentials.
3. Create the database: `createdb fiber_network`
4. `npm install`
5. `npm run migrate`

## Is my database up to date?

```bash
cd backend
npm run db:schema
```

Read-only. It prints the target the API itself would connect to (password-free), the
database and user it actually reached, how many migrations are applied and which are
pending, and whether every column the running code expects is present — exit code 0 when
current, 1 when behind, so it works as a pre-flight check.

That matters because a pull that adds a migration and a pull that runs it are two
different things, and the failure mode is confusing: the API reports a missing column
while `npm run migrate` insists everything is applied — because migrate went to a
different database (a stale `.env`, `NODE_ENV=production` with `DATABASE_URL`, another
Postgres on another port). `db:schema` prints both sides of that comparison.

### Migrations 14 and 15 (mid-span cable links)

`20260101000014_cable_continuations.js` adds `cables.continues_cable_id` and backfills existing
splits. Its first version failed on real databases (it aggregated a uuid — `MIN(p.id)`), which is
why the backfill now runs in its own savepoint and why 14 is idempotent.

`20260101000015_repair_cable_continuations.js` does the same work unconditionally, for the state
where the ledger and the database disagree: a recorded migration never runs again, so a database
that recorded 14 without its column could otherwise never be fixed by migrating. It adds the
column if missing, creates the index, adds the foreign key if the column exists without one
(clearing dangling references first so the constraint can be validated), runs the same backfill,
and verifies the column exists afterwards — it cannot report success while leaving the database
as it found it. Run `npm run migrate`; on a healthy database it changes nothing.

(If you are in that state, `npm run db:schema` says so and points at `npm run migrate`.)

### What "dark" means in a failure simulation

The public failure simulation is **box-only**: `GET /api/impact/simulate?kind=box&id=<uuid>`.
The UI does not offer cable or pole failure buttons, and the route rejects those kinds.
A cable is transport, not the failure surface. Failing a box removes the joints and
splitters in that box, then reports only fibres that were connected and lit downstream;
the cable entering the failed box remains live up to the box and is not coloured red.


The whole analysis is built on one primitive, `reachableKeys()` in
`src/utils/impactGraph.js`: **everything the light can reach from the headend's
root cores.** Light travels splices (either way — a splice is physically
bidirectional), splitter ports (input → output only: light never flows backwards
through a splitter) and mid-span continuations, and it does not pass through
anything that failed:

- a joint inside a failed box is gone, so an edge whose joint sits in one of the
  failed boxes is not traversable — this is what stops a walk at an inserted
  closure or a dead cabinet;
- a fibre on a failed cable is cut: nothing enters it, so every core of that cable
  is dark; a *root* on a failed cable is still where light is injected, but the
  light is not followed out of it, because the app does not know where along the
  span the break is;
- a root whose own box failed is not a source at all (`rootBoxIds` — the headend's
  enclosure): that is the light source going out, and everything goes dark.

`analyzeImpact` asks that question twice — before the failure and after it — and
everything that had light and no longer does is the outage. Three consequences
worth knowing:

- **the feeding span stays lit.** A cut cable is dark together with everything
  behind it, but the cable that fed it still carries light up to the break, and
  so does the box it came from;
- **a second path keeps a fibre lit.** Reachability is a graph walk, not a walk of
  the BFS tree, so a fibre fed from two places (a ring, a dual-homed box, a core
  patched twice) is not reported when only one of its paths is cut. The tree is
  only used to read paths off;
- **cables are counted per fibre.** `affected.cables[].cores_dark` /
  `cores_in_service` and `partially_dark` say how much of a span is out, and
  `affected.partial_cable_count` totals it: an outage that darkens 1 of a cable's
  12 fibres is partly out, not gone, and the map styles it that way. The count is
  of fibres that carried light — a recorded joint (a splice, a splitter's input, a
  port's output) or a path to the root — so a spare (`available`/`reserved`) never
  counts as a lost fibre, and neither does a status column on a strand no joint
  ever names: an import leftover marked `spliced` must not dilute a span whose
  every lit fibre is out, the cable fed by a failed box's splitter port among
  them, into a "partly out" line.

Direction comes from the headend root. If no headend is configured, the service
uses a conservative fallback before giving up: it infers source boxes from the
cable orientation (boxes that have plant cable leaving them but no cable arriving,
while a box with only customer drops is not treated as an OLT). The response marks
this as `direction_source: "inferred"`, lists `inferred_root_boxes`, and warns that
a headend should be set to make the direction explicit. This keeps the span that
feeds a failed box out of the affected cables — it still carries light up to the
break. If the network shape has no source (for example, every box is fed), the
walk remains undirected, marks `direction_source: "none"`, and says plainly that
it may include the feeding span and branches that are still lit.

### Mid-span links without the column (the inference fallback)

`cables.continues_cable_id` is the recorded way to say "these two cable rows are one fiber".
A database that does not have it — migration not applied, or the role cannot `ALTER` the
table — used to leave the failure simulation stopping at an inserted closure. It does not
any more: `src/utils/continuationLinks.js` falls back to **inferring** the links with the
same rule migration 14's backfill and `npm run db:link-splits` use (downstream named
`<upstream code>-B`, starting where the upstream one ends, same type and core count, split
points within 25 m), and every consumer reads its links from there.

The link is part of the API, not just of the graph: `GET /api/cables`, `GET /api/cables/:id`
and every `affected.cables` entry in a failure report carry `continues_cable_id` /
`continues_cable_code` / `continues_at_box_id` / `continues_at_box_code` /
`continuation_inferred` and a `continued_by[]` list — filled from the column when it exists,
from the inferred pairs when it does not (`continuationFields()` / `decorateCables()` in
`src/utils/continuationLinks.js`). The list route also only puts `c.continues_cable_id` in
its SELECT when the probe says the column is there, so the query is valid on either
database.

### The database is brought up on startup

`src/utils/schemaBootstrap.js` runs once when the API starts (from `src/server.js`, after the port is
open, on its own short-lived connection so it never holds DDL over the request pool):

1. `knex.migrate.latest()` with this package's migrations directory — everything the ledger has not
   recorded, in order. A migration whose transaction never committed is rolled back by knex and
   applied again, which is how a database whose migration "did not take" recovers.
2. The mid-span column, read as a *capability* rather than trusted to a ledger: if
   `cables.continues_cable_id` is absent it runs the repair migration's own `ensure()` (migration 15
   and `up` are the same function — one definition, two callers). This covers the state migrations
   cannot: 14 **and** 15 recorded, column absent.
3. The remaining unlinked halves, through the same rule as `npm run db:link-splits`.

Failure is never fatal: a warning, and the app keeps working with inferred links. `SCHEMA_BOOTSTRAP=off`
(or `SCHEMA_BOOTSTRAP=false`) skips the whole pass for a deploy where something else owns the schema.

**A bug this turned up, worth knowing about:** `schemaCapabilities` used to read the column list with
`array_agg(column_name)`. `information_schema.columns.column_name` is a domain over `name`, so the
aggregate produces `sql_identifier[]` — an array type node-postgres has no parser for, arriving as the
string `"{continues_cable_id}"`. `new Set(that)` is a set of characters, `has()` answered false, and
the app concluded a column that was right there did not exist: it inferred links it should have read
and warned about a missing column on every database that had one. The SQL now casts to `::text` and
`asArray()` reads either shape. Both are covered by tests, including one that runs the un-cast query
against a real Postgres and asserts the string it produces — the only way to catch this class of bug.

### What paints a cable red

A cable is painted red when a fibre on it goes dark — reachable from the headend before the
failure, unreachable after — **and that fibre is part of the plant**. "Part of the plant" is
`inPlant()` in `src/utils/impactGraph.js`: the core is `spliced`/`terminated`, *or* a recorded joint
names it (either side of a splice, a splitter input, a splitter port's output). The second half of
that rule matters because the status column is editable (`PATCH /api/fiber-cores/:id`) and imported
data arrives stale: a fibre joined inside a box is joined, and when the box fails the joint goes with
it. Without it, the report could list a customer as down while the map drew their drop cable as
though nothing had happened — the two must agree.

An `available` core that no joint names is deliberately *not* in the plant: an unused strand must
never paint the span that feeds a failed box.

Recorded links always win. With the column present the app never guesses: a `NULL` means
"not a continuation". The fallback is only for a database that has no column at all, and
when it finds links the outage report says so ("N mid-span cable links inferred from cable
naming"). `npm run db:schema` names the step that records them on the database in front
of you (migrate if the migration is pending; the `ALTER` if the ledger already claims it
ran, which is the state where re-running `npm run migrate` changes nothing).

The app does not fall over when the schema is behind. Each feature that needs a newer
column checks for it first (`src/utils/schemaCapabilities.js`), drops it from its query
when it is absent, and reports what is missing: a gap with `severity: 'warning'` is
flagged `!` at startup and filtered into `warnings` on a report, while a gap the app can
work around (`severity: 'notice'`, which is what the mid-span column is now) is printed
with `·` and kept out of the warnings — for the mid-span
column specifically, the failure simulation, the trace and the loss budget all keep
walking across an inserted closure; there is nothing to switch off. The check is cached
and re-run on a timer, so a server that is left running when you finally apply the
migration notices by itself. The backend also prints the same lines at startup —
`·` for a notice, `!` for something genuinely missing.

### Verifying a migration actually runs

The unit tests swap the database for a stub, so they cannot catch a migration whose SQL
is wrong — and migration 14 shipped one (`MIN(p.id)`; Postgres has no `min()` for uuid),
which broke `npm run migrate` on every database that already had cables. To run the real
migration against a real database:

```bash
cd backend
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/fiber_network \
  npm run test:migrations
```

It creates a `fiberline_migration_test` schema, builds a small network in it, runs the
migration, checks what it linked (and what it refused to link), checks a second run
changes nothing, drops the schema — so pointing it at your real database is safe. It
works with or without PostGIS. Without `TEST_DATABASE_URL` the file still runs its static
checks (no aggregates over uuid ids, the backfill is guarded) and skips the rest.

### Mid-span splits that are still unlinked

Migration 14 backfills splits that already existed — the two halves of a closure inserted
mid-span — but only where it can be sure: the downstream cable must start where the
upstream one ends, share its type and core count, be named `<upstream code>-B`, and have
a route that meets the parent's end within 25 m. A pair it skipped leaves the failure
simulation stopping at that box, which is exactly what the schema check reports:

```bash
cd backend
npm run db:schema        # lists pairs that look unlinked, and how many are linked
npm run db:link-splits   # same rule, on demand — read-only
npm run db:link-splits -- --apply
```

If the downstream cable was renamed, no rule can find it — name the two halves explicitly:

```bash
npm run db:link-splits -- --child FEEDER-TO-SECTOR-7 --parent CBL-F8
```

The failure simulation also names the pair when it can: an outage blocked by an unlinked
split says which cable continues which, so the fix is one command. Linking is always
"core #n continues as core #n", which is how the insert route builds the halves.

## Starting over (empty database)

```bash
cd backend
npm run db:reset                # wipe the schema, run all migrations
npm run db:reset -- --truncate  # keep the schema + PostGIS, empty the data
npm run db:reset -- --yes       # no confirmation prompt (scripts/CI)
```

`db:reset` drops and recreates the `public` schema (so the PostGIS extension and the
migration ledger go too — migration `20260101000001` installs PostGIS again) and then runs
`migrate:latest`. `--truncate` is the lighter option: it `TRUNCATE … CASCADE`s every table
except `knex_migrations*`, keeping the schema, the extension and the migration history —
use it when the app role has no right to `DROP`/`CREATE` a schema. Both print exactly which
database they are about to empty and ask you to type `reset` first, and both refuse to run
against a `NODE_ENV=production` config unless `ALLOW_PRODUCTION_RESET=1` is set.

Doing it by hand instead (any one of these, then `npm run migrate`):

```bash
# drop the schema — same thing the script does
psql -U postgres -d fiber_network -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"

# or roll the migrations back (runs each migration's down(), then migrate again)
npx knex migrate:rollback --all

# or start from a brand-new database (also removes the PostGIS extension)
dropdb -U postgres fiber_network && createdb -U postgres fiber_network
```

There is no seed data — everything is entered through the UI or the API. After a reset the
first thing to do is declare the network root (`POST /api/headends {root_enclosure_id}`,
or *Simulate failure* on the OLT box → *Set as the network root*), because outage analysis
needs it to know which way downstream is. `npm run seed` currently has nothing to run: the
`seeds/` directory does not exist yet.

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

**Field work — worksheets and QR tags:**

- `GET /work-orders/:boxId` — a splice worksheet generated from that box's documentation: `work_order` (reference `WO-<code>-<YYYYMMDD>`, kind, generated-by), `summary` counts, `checklist` (each item carrying its `source` rule, so a line on the sheet can always be explained), `materials` (counted across the rules), `splices`, and the fibres landing in the box with their far ends. `?kind=splice|repair|survey|install` and `?by=<name>` are printed on the sheet (an `install` sheet is a new drop, and carries the plan a serviceability check produced — see below). **It is derived, never invented** — the rules are `re-splice` (recorded loss over `BAD_SPLICE_LOSS_DB`), `damaged-core`, `free-splitter-port`, `splitter-input`, `missing-loss`, `through-joint` (mid-span pairs meeting here, recorded or inferred), and `spare-cores` (information, not a step), followed by four fixed close-out steps. A rule that throws becomes one warning line on the sheet: an unreadable table must not cost a technician the whole worksheet.
- `GET /work-orders/:boxId/text` — the same sheet as plain text (`text/plain`, wrapped to 80 columns): tick boxes, materials, splices on record, every fibre with its far end, and a sign-off block. For a phone, a chat message, or `lp`.
- `GET /qr/svg?data=<text>&ec=M&scale=6&quiet=4` — any text as an SVG QR code (400 without data, 413 when the text is over the level's capacity; scale clamped 1–40, quiet zone 0–16).
- `GET /qr/:kind/:id` (or `:id.svg`) — a tag for a real pole, box, cable or customer (`kind` = `pole|box|enclosure|cable|customer`; 404 for an entity that does not exist, 400 for an unknown kind). JSON carries `link`, `code`, `svg` and the resolved `base_url`; `.svg` returns the image, and `?download=1` makes it an attachment.
- `GET /qr/:kind/:id/link` — just the label and the link.

**Splitters, ports and headend budgets (the data model under the capacity checks):**

- Splitters are first-class rows (`splitters`: `split_count`, `input_core_id`, an optional measured `loss_db`), one row per port (`splitter_ports`: `port_number`, `output_core_id` nullable = nothing on it, `output_splitter_id` = a child splitter cascaded onto it, `status` for a damaged port). Migration `20260101000008` created them, `…09` allowed empty ports, `…11` added cascading. The split *ratio* is derived from `split_count` (`1:8` is a label, not a stored fact — a stored ratio beside an integer count is two facts that can disagree) and the ratios a user may pick are `2, 4, 8, 16, 32` (`utils/splitters.js` exports the list; the middleware and the route both read it, and every one of them has a planning loss value in `utils/lossBudget.js`).
- **Free is defined once.** `summarizePorts` / `enrichSplitter` / `enrichSplitters` in `src/utils/splitters.js` are the only port counters in the codebase, and both `/api/splitters` and `/api/enclosures/:id/documentation` call them, so the panel, the worksheet and the capacity checks cannot disagree about a box's headroom. A port is `free` only when nothing is connected *and* it is not damaged; the per-port row carries `usage` (`free` | `core` | `cascaded`), `damaged`, and `available` (the single field a capacity check should read — `available` is `usage === 'free' && !damaged`). `port_summary` gives the counts *and* the port numbers (`free_port_numbers`, `used_port_numbers`, `damaged_port_numbers`, …): "3 free" is a headcount, "ports 5, 6, 7" is what a technician writes down. `free + used + cascaded` need not equal `total` — `damaged` is a condition, not a connection, so a damaged port carrying a live customer is in both lists.
- **The customer label on a port is resolved, not copied.** `splitter_ports` has no `customer_label` column: the label lives on the drop cable (`cables.customer_label`, where it is already recorded and printed) and the port listing joins it in. A denormalized copy is a second source of truth for a label that changes when a drop is re-patched — and the copy that goes stale is always the one on screen.
- **Per-headend optical budget** (migration `20260101000017`): `headends.olt_type` and `headends.budget_db` are nullable overrides on top of `project_settings` (`…12`), so a site running a GPON Class B+ OLT beside an XGS-PON one can budget 28 dB on one side and 29 dB on the other. NULL means "not special" — resolution is headend → project settings → planning constant for the type, and a network that never sets either column behaves exactly as before. There is deliberately **no `enclosures.headend_id`**: which headend feeds a box is answered by walking the splice/splitter graph to a headend's `root_enclosure_id` (the direction model migration `…13` established and the outage analysis already uses), and a stored answer would be a cache that drifts the first time a cable is re-spliced.
- `cables.attenuation_db_per_km` (0.35 dB/km default) and `splices.loss_db` (nullable, 0.1 dB fusion default) — the other two inputs the loss math needs — arrived in migration `…12` and are consumed by `utils/lossBudget.js`.

**Serviceability check — can we serve this address, and what does the drop cost:**

- `GET /serviceability/check?address=<text>` — or `?lat=&lng=` (what the map click in *Locate customer* passes). `?radius_m` (default 500, max 5000 — never narrower than `max_extension_m`, or the verdict would depend on the radius), `?limit` (default 25, max 100), `?route=0` to skip the street route. The payload is built in the order the work happens: `verdict` + `verdict_label` in plain words (`serviceable` / `serviceable_with_work` / `build_required` / `out_of_reach` / `no_network`), `serviceable`, `serviceable_now`, `requires_work`, `requires_build`, `survey_required`, `confidence` + `confidence_reason`, `summary` (the sentence the panel shows), `nearest_box` and `recommended_box` **separately** (the nearest is often full — that is the whole point), `connection` (`needs`: `port` | `splitter` | `capacity`, with the reason), `distance` (`to_nearest_m`, `to_recommended_m`, `run_m`, `run_source`), `drop` (length, cable length with slack, `source`, the street route coordinates), `extension` when a build is needed, `quote`, `alternatives`, `suggested_source`, `searched`, `warnings`, `next_steps`, and a `query` block saying what was asked and how the address was resolved — plus the exact `rates` the price used.
- `GET /serviceability/check/text` — the same answer as plain text, wrapped to 78 columns and written the way a CSR reads it out: verdict, both boxes, the run, the price band, the cost lines with their rates, the next steps, the warnings, the assumptions, and the confidence. What you paste into a CRM, message to an installer, or print.
- `GET /serviceability/check/sheet` (and `/sheet/text`) — an **install work order** for the box the check picked: the standard worksheet format with an `install_plan` block on top (box, port to assign, run, quoted total) and the box's own documentation underneath, so the crew that quoted it is the crew that loads the right cable. 409 when no box can take the drop (with the verdict and the next steps in the body) — there is no honest sheet to print for a refusal.

**How an address is resolved** (no geocoder required, and none needed for the common case): an **asset code or name** first — exact, and recognised inside a sentence ("drop to NAP-14 please") — then a **customer address already in the database**, scored by token overlap over the query's own tokens, with the house/lot number compared as a unit ("12-B" ≡ "12 B" ≡ "12b", but 12-C ≠ 12-B: a disagreeing house number caps the score below the confidence threshold). Confidence needs evidence — two matched tokens, or a house number that settles it — so a single shared word like "islamabad" is a suggestion, never an answer. Below the threshold the reply is 404 with the scored `candidates` for the CSR to pick from (or to click on the map instead). Finally, if `GEOCODE_BASE_URL` is set to a Nominatim-compatible service, `GET {base}/search?q=…` places free-text addresses; a geocoder that is down returns "no match" rather than a 500.

**The cost model** (pure functions in `src/utils/dropCost.js`, rates on the row migration `20260101000016` adds to `project_settings`): `cable = measured length × (1 + slack_pct%)` at `drop_cable_cost_per_m`, one `labour_cost_per_drop`, one `splice_cost`, `splitter_cost` when a splitter has to go in, and `extension_cost_per_m` per metre when the property is beyond `max_drop_m` (default 150). Defaults are planning values (PKR 45/m, 2,500, 350, 3,500, 260, 10% slack) and the answer always reports which rates it used. The quote is a **band** — the length moves ±15%, the fixed work does not — and `needs: 'capacity'` deliberately prices *no* cable: the serving box is exactly what is not decided yet, so a length there would be a guess, and the assumptions say so. `survey_required` is set for capacity work and for any build. PATCH `/api/settings` with any of `currency`, `drop_cable_cost_per_m`, `labour_cost_per_drop`, `splice_cost`, `splitter_cost`, `extension_cost_per_m`, `slack_pct`, `max_drop_m`, `max_extension_m` (blank clears an override back to the default); GET returns the resolved `cost_model` alongside the loss-budget settings. A database that predates the columns answers from the defaults and says which migration is missing if you try to set one.

The link inside a tag is the frontend's deep link (`<base>/?box=<uuid>`, `?pole=`, `?cable=`, `?customer=`), and the base is resolved `?base=` → `APP_BASE_URL` → the request origin. The encoder (`src/utils/qr.js`) has no dependencies: byte mode, versions 1–10, L/M/Q/H, ISO penalty scoring, `toSvg()` drawing a single path with the quiet zone included.

Next step: the React + Leaflet frontend — the actual map where you place poles, draw cables, and click into box documentation.
