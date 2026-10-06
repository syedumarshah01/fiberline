# Production Rules: Serviceability Checks & Remediation

This document is the authoritative spec for `checkServiceability` and the three remediation functions (`findCoreRemediation`, `findPortRemediation`, `findPowerRemediation`). Implement exactly as written. Where a value is marked "configurable," implement it as a named constant/config value, not a hardcoded literal, but use the given default.

---

## 1. Spare core determination

A core is **SPARE** (available to use) if and only if ALL of the following are true:

1. `core.connected_splice_id IS NULL` on both ends it could be used for — i.e. the core is not currently part of any row in the splice table, neither as `core_in` nor `core_out`.
2. The core is not currently terminated to a customer (`termination.core_id` has no row for this core).
3. The core is not reserved/held (see Reserved status, below).
4. The core is not flagged `damaged` or `faulty` (see Exclusions, below).

A core is **NOT SPARE** if it fails any of the above, including if its status is unknown/undocumented — **default to NOT SPARE when data is missing or ambiguous.** Never treat an undocumented core as available; this is a safety default, not a completeness assumption.

**Reserved status:** add a `core.status` enum: `spare | in_use | reserved | damaged | unknown`. `reserved` means a human has earmarked it (e.g. for a planned install) but it is not yet spliced. Reserved cores are NOT SPARE for automated remediation purposes — they must never be auto-selected by `findCoreRemediation`, only shown as "reserved, unavailable" in UI. Only a human can un-reserve a core.

**Enclosure-level spare count** = count of cores at that enclosure with `status = spare`.

`NO_SPARE_CORE` issue fires when spare count at the target enclosure = 0.

---

## 2. Splitter port determination

A splitter output port is **FREE** if and only if:

1. `port.connected_core_id IS NULL`.
2. The port is not administratively disabled (`port.disabled = false` — add this field; techs can mark a physically damaged port as disabled so it's never suggested).

A splitter port is **NOT FREE** otherwise, including unknown/missing data — same safety default as cores.

`NO_SPLITTER_PORT` issue fires only when:
- The enclosure has at least one `Splitter` row, AND
- Every port on every non-disabled splitter in that enclosure is occupied (`FREE` count = 0 across all splitters in the enclosure).

If the enclosure has zero `Splitter` rows, **do not fire `NO_SPLITTER_PORT`** — skip this check entirely (per the original spec: not every box has a splitter).

---

## 3. Optical power margin — units, calculation, thresholds

**Units:** all loss values in **dB**, all power values in **dBm**. Store and compute in dB/dBm throughout — never convert to linear (mW) for these calculations; dB is additive, which is what the formulas below rely on.

**Total path loss (dB):**

```
total_loss_db =
    SUM(fiber_segment.length_km * fiber_segment.attenuation_db_per_km)
  + SUM(splice.loss_db, using DEFAULT_SPLICE_LOSS_DB where splice.loss_db IS NULL)
  + SUM(splitter.insertion_loss_db for every splitter traversed)
  + (connector_count * DEFAULT_CONNECTOR_LOSS_DB)
```

**Defaults (configurable constants):**

| Constant | Default value |
|---|---|
| `DEFAULT_SPLICE_LOSS_DB` | 0.1 dB |
| `DEFAULT_CONNECTOR_LOSS_DB` | 0.3 dB |
| `DEFAULT_FIBER_ATTENUATION_DB_PER_KM` | 0.35 dB/km (singlemode @1310nm) — overridable per cable segment if a different value is documented |
| `SPLITTER_INSERTION_LOSS_DB` by ratio | 1:2 = 3.5, 1:4 = 7.2, 1:8 = 10.5, 1:16 = 13.5, 1:32 = 17.3 |
| `SAFETY_MARGIN_DB` | 3 dB |

**Budget:** each `Headend` row has `budget_db` (the OLT's total optical power budget for its PON class, e.g. 28 dB for GPON Class B+ — this MUST be set per headend at data-entry time; there is no safe global default since it varies by OLT transceiver class — if `budget_db` is NULL for a headend, treat every path through it as **UNKNOWN**, not as passing or failing; see Exclusions).

**Margin:**
```
margin_db = headend.budget_db - total_loss_db
```

**`LOW_POWER` issue fires when:**
```
margin_db < SAFETY_MARGIN_DB
```
i.e., margin below 3 dB (not just below 0) counts as a flagged issue — this is deliberately a warning threshold before actual failure, giving headroom for measurement error and future splice degradation.

**Severity levels for display** (issue still fires at `LOW_POWER` for both, but tag severity so UI/remediation ranking can differentiate):
- `MARGINAL`: `0 <= margin_db < SAFETY_MARGIN_DB`
- `FAIL`: `margin_db < 0`

---

## 4. Exclusions and edge cases

1. **Missing `headend_id` on the enclosure/path.** If the enclosure's headend cannot be resolved (not set, and not derivable by walking the splice graph to a terminating headend), `checkServiceability` must return an explicit 4th issue type: `{ type: "UNKNOWN_TOPOLOGY" }` and SKIP the `LOW_POWER` check (cannot compute margin without a budget to compare against). Do not default to "assume serviceable."
2. **Missing `headend.budget_db`.** Same handling as above — emit `UNKNOWN_TOPOLOGY` (or a distinct `UNKNOWN_BUDGET` if you want finer granularity), skip `LOW_POWER`, do not guess a default budget.
3. **Cycles in the splice graph.** If path-walking for the loss calculation encounters a node it has already visited (ring topology, mis-documented loop), abort that path calculation and return `UNKNOWN_TOPOLOGY` rather than looping or returning a wrong number silently.
4. **Core or port in `unknown` status.** Counts as NOT SPARE / NOT FREE respectively (see sections 1-2). Surface this distinctly in the UI panel (e.g. "3 cores undocumented" separate from "0 cores spare") so a human knows to go document them — this is a data-quality signal, not just a capacity signal.
5. **Damaged/faulty cores or disabled ports.** Never selected by any remediation function, even if technically unconnected. Must be visually distinguished from "spare"/"free" in the UI (different color/label), not just hidden.
6. **Customer location not provided to `checkServiceability`.** If `lat`/`lng` are omitted, skip the `LOW_POWER` check entirely (no target to compute a path to) and return only `NO_SPARE_CORE`/`NO_SPLITTER_PORT`/`UNKNOWN_TOPOLOGY` as applicable.
7. **Multiple headends feeding redundant/overlapping paths.** Out of scope for v1 — if an enclosure's path-walk reaches more than one distinct headend depending on direction, return `UNKNOWN_TOPOLOGY` rather than guessing which one is "correct." Flag this as a case needing manual headend assignment.
8. **Enclosure has splitter(s) but the customer's path doesn't require going through one** (e.g. direct unsplit core available). Run both checks independently — `NO_SPARE_CORE` and `NO_SPLITTER_PORT` are not mutually exclusive and both may or may not fire depending on actual data; do not assume a splitter being present means only the splitter path is evaluated.

---

## 5. Allowed deterministic remedies — exact rules

These functions may ONLY return the candidate types listed below, in the stated priority order. No other remedy types may be invented by implementation or by the AI explanation layer.

### `findCoreRemediation(enclosure_id, customer_location)`

1. BFS outward from `enclosure_id` through the existing cable/splice graph (direction: must stay on the customer side of the headend — do not cross to the headend's upstream side) to find the nearest enclosure with `spare_core_count > 0`, within `MAX_SEARCH_HOPS` (configurable, default 10) or `MAX_SEARCH_DISTANCE_M` (configurable, default 2000m), whichever limit is hit first.
2. For each candidate found, run the full loss-budget calculation (section 3) on the resulting path INCLUDING the new segment to the customer. Discard any candidate where the result would be `LOW_POWER` with severity `FAIL` (margin < 0). Candidates with `MARGINAL` severity may still be returned but must carry that flag.
3. Rank remaining candidates by: (a) fewest hops, (b) shortest distance, in that order.
4. If zero candidates found within the search limits, return an empty list with reason "no spare core found within search limits" — do not expand the search silently beyond the configured limit.

### `findPortRemediation(enclosure_id, customer_location)`

Priority order, stop at the first tier that produces at least one candidate:

1. **Tier 1 — other splitter, same enclosure.** Any other non-disabled splitter in the same enclosure with ≥1 FREE port.
2. **Tier 2 — nearby enclosure.** Within `MAX_SEARCH_DISTANCE_M` (default 2000m), any enclosure with a splitter with ≥1 FREE port AND a valid existing core path connecting it toward `enclosure_id`'s side of the network (reuse the core-path check from `findCoreRemediation`'s traversal). Rank by distance.
3. **Tier 3 — cascade (requires human review, never auto-executed).** Only returned if Tiers 1 and 2 produce zero candidates. Must:
   - Identify a candidate port to sacrifice using rule: lowest-priority port = a port whose connected core has NO active customer termination (i.e. spliced but not actually serving anyone) if one exists; if none exists, DO NOT suggest sacrificing any currently-serving customer port automatically — return "cascade possible but requires selecting a port to sacrifice manually" with the list of occupied ports and their customer_labels for a human to choose from. The function must never auto-select a live customer's port to sacrifice.
   - If a non-serving port is found, compute the projected loss budget for the new cascaded splitter (apply the new splitter's `insertion_loss_db` on top of existing loss) and tag the candidate `severity: FAIL` if this pushes margin below 0, `MARGINAL` if below `SAFETY_MARGIN_DB`, and include the number — cascade candidates must always show their loss impact, never be presented as cost-free.
   - All Tier 3 candidates are tagged `requires_review: true` and must never be auto-applied even if a "one-click fix" UI exists elsewhere — this tier always stops for explicit human confirmation.

### `findPowerRemediation(enclosure_id, customer_location, required_margin_db = SAFETY_MARGIN_DB)`

1. Search enclosures within `MAX_SEARCH_DISTANCE_M` (default 2000m) that have ≥1 FREE splitter port OR ≥1 spare core (whichever is relevant to how the customer would be served).
2. For each, compute full loss budget to the customer. Keep only candidates where `margin_db >= required_margin_db`.
3. Rank by: (a) highest resulting margin_db, (b) fewest hops.
4. If zero candidates meet `required_margin_db` within the search radius, return empty with reason "no path meets required margin within search limits" and explicitly flag `olt_optics_review_suggested: true` — this signals the fix may not be available in the field at all (per the original design: never fabricate a field fix if the real answer is an OLT-side hardware/optics change).
5. **Never suggest a remedy that would increase total loss** (e.g. never suggest routing through an additional splitter if a lower-loss path exists) — if the only available candidates increase loss relative to the customer's current (failing) path, return them but tag `severity: not_an_improvement` rather than presenting them as valid fixes.

---

## 6. What the AI explanation layer may and may not do with these results

- It may summarize, rank-explain, and phrase the above candidates in natural language.
- It may NOT alter severity tags, invent a remedy type not listed in section 5, auto-resolve a Tier 3 cascade's "choose a port to sacrifice" step, or state a margin_db/loss_db number that doesn't appear in the structured input it was given.
- Any output number must be validated against the source JSON before display — these rules are what that validation is checking against.

---

## Summary table for quick reference

| Issue | Fires when | Skip when |
|---|---|---|
| `NO_SPARE_CORE` | spare core count at enclosure = 0 | never skipped |
| `NO_SPLITTER_PORT` | enclosure has ≥1 splitter AND free port count = 0 across all | enclosure has zero splitters |
| `LOW_POWER` | margin_db < 3 (SAFETY_MARGIN_DB) | headend/budget unknown, cycle detected, or no customer location given |
| `UNKNOWN_TOPOLOGY` | headend unresolved, budget unresolved, or cycle detected | — |

| Remedy tier | Auto-suggestable | Requires human confirmation |
|---|---|---|
| Core remediation (BFS to spare core) | Yes, if margin not FAIL | No |
| Port Tier 1/2 (other splitter / nearby box) | Yes, if margin not FAIL | No |
| Port Tier 3 (cascade, non-serving port sacrificed) | Yes, but tagged `requires_review` | Yes |
| Port Tier 3 (cascade, only live ports available) | No — returns options list only | Yes, always |
| Power remediation | Yes, only if margin meets required threshold | No |
| Any remedy that increases loss vs. current path | No — tagged `not_an_improvement` | N/A, informational only |
