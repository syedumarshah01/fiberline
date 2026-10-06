# Splitter Capacity, Power Budget, and Remediation Suggestions

## Overview

This feature identifies, for any enclosure, whether it can serve a customer — checking for a free splitter port, a free fiber core, and sufficient optical power margin — and suggests concrete, ranked remediation options when it cannot.

## Data model

```
Splitter
  id, enclosure_id (FK), ratio (enum "1:2".."1:32"), input_core_id (FK),
  insertion_loss_db (default by ratio: 1:2≈3.5, 1:4≈7.2, 1:8≈10.5, 1:16≈13.5, 1:32≈17.3)

SplitterPort
  id, splitter_id (FK), port_number, connected_core_id (FK, nullable), customer_label (nullable)

CableSegment
  attenuation_db_per_km (default 0.35, singlemode @1310nm, overridable)

Splice
  loss_db (nullable — null means "not measured, use default" of 0.1 dB)

Headend
  id, name, location, budget_db (e.g. 28 for GPON class B+, per-headend)

Enclosure / Cable
  headend_id (nullable — inferred by walking the splice graph to the terminating headend, or set manually)
```

## Serviceability checker

```
checkServiceability(enclosure_id, customer_location?) -> {
  issues: Array<
    | { type: "NO_SPLITTER_PORT" }
    | { type: "NO_SPARE_CORE" }
    | { type: "LOW_POWER", margin_db, budget_db, total_loss_db }
  >,
  serviceable: boolean
}
```

- `NO_SPARE_CORE`: no free core terminates or passes through the enclosure.
- `NO_SPLITTER_PORT`: enclosure has ≥1 splitter but every port on every splitter is occupied (skip this check entirely if the enclosure has zero splitters).
- `LOW_POWER`: simulated path loss (fiber attenuation + splice loss + splitter insertion loss + connector loss) compared against `headend.budget_db` minus a configurable safety margin (default 3dB).

See `serviceability-remediation-rules.md` for the exact, authoritative formulas, thresholds, and exclusions — this file is the overview, that file is the production rule set.

## Remediation search

Three ranked-candidate search functions, one per issue type:

- **No spare core**: BFS to the nearest enclosure with spare capacity, verified against the power budget so a candidate doesn't trade one problem for another.
- **No splitter port**: priority order — (1) other splitter in the same enclosure, (2) nearby enclosure with a free port and valid core path, (3) cascade a new smaller splitter off a sacrificed port, flagged `requires_review`, never auto-selecting a live customer's port.
- **Low power**: priority order — (1) nearby enclosure with a free port and lower total loss, (2) nearby enclosure with a lower-ratio splitter, (3) explicit "no field remediation found," flagging that OLT-side transceiver power class may need review rather than fabricating a fix.

Each candidate includes: type, target enclosure/splitter, distance, hop count, projected margin_db, and caveats.

## AI explanation layer

A thin layer that takes the structured remediation candidates and produces a plain-language recommendation — it does NOT perform graph traversal, loss math, or ranking itself, only explains results already computed deterministically. It must flag any `requires_review` candidate as needing human sign-off, never present it as equivalent to a clean fix, and never state a number not present in its structured input.
