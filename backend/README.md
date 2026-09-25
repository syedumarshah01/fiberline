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

### Mid-span links without the column (the inference fallback)

`cables.continues_cable_id` is the recorded way to say "these two cable rows are one fiber".
A database that does not have it — migration not applied, or the role cannot `ALTER` the
table — used to leave the failure simulation stopping at an inserted closure. It does not
any more: `src/utils/continuationLinks.js` falls back to **inferring** the links with the
same rule migration 14's backfill and `npm run db:link-splits` use (downstream named
`<upstream code>-B`, starting where the upstream one ends, same type and core count, split
points within 25 m), and every consumer reads its links from there.

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

Next step: the React + Leaflet frontend — the actual map where you place poles, draw cables, and click into box documentation.
