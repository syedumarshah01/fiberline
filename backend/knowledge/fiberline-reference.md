# Fiberline operational reference

This reference is derived from the checked-in API, database migrations, frontend help text, and project README files. Use it for documented application behavior only; when a value is not defined here or in the source documents, say that Fiberline does not specify it.

## Splitter ratios and loss

Fiberline creates passive splitters with 1:2, 1:4, or 1:8 ratios. The create endpoint defaults `split_count` to 4, so a splitter created without an explicit ratio is 1:4. Each output is represented by a port row. A splitter's input may be a fiber core or a free output port of a parent splitter in the same enclosure, which supports cascaded splitters.

The `loss_db` field is optional and has no application default; when it is omitted, it is stored as null. The API validates an explicitly supplied splitter loss between 0 and 40 dB. Fiberline does not provide a standard insertion-loss value for any ratio, and 1:32 is not an allowed splitter ratio in the current API. Do not substitute a typical vendor loss figure for a stored or documented value.

## Fiber trace

`GET /api/fiber-cores/:id/trace` starts with a fiber-core ID and returns `start_core_id` plus an ordered `hops` array. Each core hop includes the cable/core information; splice markers identify the enclosure and splice type connecting the next core. Splices are treated as undirected links. The trace walks both directions from a core and includes reachable branches, using deterministic splice ordering by splice date, creation time, and ID. A 500-step safety cap prevents an accidental loop from keeping the request running forever.

A trace is a topology view, not a capacity recommendation: it follows recorded splices and does not modify cables, cores, or splice records. A missing start core returns HTTP 404.

## Enclosure documentation and wiring view

`GET /api/enclosures/:id/documentation` returns the enclosure's landing cables, core statuses, splice records, splitter assignments, and summary counts. The visual documentation view groups incoming cables on the left and outgoing cables on the right, with numbered splice pairs and wires between their exact fiber ports. Hovering a wire or splice-map row highlights the same pair. The refresh action reloads the box data.

Each core in the visual view shows its fiber number, status, and (for incoming cores) the far-end origin when that upstream connection is known. Splice notes and splitter notes are descriptive records; they do not change the graph traversal rules.

## Capacity and customer lookup

Available capacity at a box is counted from available cores on feeder or distribution cables that land at the enclosure; drop cables are excluded. `GET /api/capacity/find-source` performs a breadth-first search by cable hops for the nearest connected enclosure with an available core and returns the cable path. `GET /api/capacity/customer-lookup` finds nearby enclosures by geographic distance, recommends the nearest one with capacity, and otherwise suggests a connected source from the closest nearby box when possible.

Customer-box enclosures may have their own location and no pole. The capacity and lookup endpoints include those enclosures by coalescing the enclosure and pole locations.
