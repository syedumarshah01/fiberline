# Downstream Failure Simulation Algorithm

## Summary

"Simulate failure" must mark every cable downstream of a failure point red — whether connected via a direct splice (1-to-1) or via a splitter port (1-to-many fan-out) — and must propagate recursively through every subsequent box the signal passes through, not stop after one hop.

The algorithm is: **direction-aware graph traversal from the failure point toward every customer termination, following both splice connections and splitter connections, marking every cable segment visited along the way.**

## Prerequisite: direction must be known

Every enclosure/cable resolves to a `headend_id` (the OLT/CO it's fed from) — either stored directly or derivable by walking splices/cores toward the root. At the failed box, only traverse **away from the headend side, toward customers**. Do not mark cables on the headend side of the failure as failed. If direction isn't modeled, the fallback is: traverse in all directions from the failure point but stop as soon as you reach the headend node.

## Algorithm

```
function simulateFailure(failedElementId, failedElementType):
    // failedElementType: "pole" | "enclosure" | "cable_segment"

    affected_cables = new Set()
    affected_customers = []
    visited_nodes = new Set()   // enclosures/boxes, prevents infinite loops on ring topologies

    queue = []

    if failedElementType == "pole":
        for cable in getCablesAttachedToPole(failedElementId):
            queue.push({ cable, fromNode: null })

    else if failedElementType == "cable_segment":
        affected_cables.add(failedElementId)
        downstreamNode = getDownstreamEndpoint(failedElementId)
        queue.push({ node: downstreamNode })

    else if failedElementType == "enclosure":
        queue.push({ node: failedElementId })

    while queue is not empty:
        item = queue.pop()

        if item is a node (enclosure):
            if item.node in visited_nodes: continue
            visited_nodes.add(item.node)

            enclosure = getEnclosure(item.node)

            // direct splices — core in, core out, no splitter involved
            for splice in getSplicesInEnclosure(enclosure):
                if isDownstreamSide(splice.core_out, enclosure):
                    outCable = getCableForCore(splice.core_out)
                    affected_cables.add(outCable.id)
                    nextNode = getOtherEndpoint(outCable, enclosure)
                    if nextNode is a customer termination:
                        affected_customers.push(nextNode.customer_label)
                    else:
                        queue.push({ node: nextNode })

            // splitters — fan-out to ALL occupied output ports
            for splitter in getSplittersInEnclosure(enclosure):
                if isDownstreamOfFailure(splitter.input_core_id, enclosure):
                    for port in splitter.output_ports:
                        if port.connected_core_id is not null:
                            outCable = getCableForCore(port.connected_core_id)
                            affected_cables.add(outCable.id)
                            nextNode = getOtherEndpoint(outCable, enclosure)
                            if nextNode is a customer termination:
                                affected_customers.push(port.customer_label ?? nextNode.customer_label)
                            else:
                                queue.push({ node: nextNode })

        else if item is a cable (first iteration only, from a pole failure):
            affected_cables.add(item.cable.id)
            nextNode = getDownstreamEndpoint(item.cable)
            if nextNode is a customer termination:
                affected_customers.push(nextNode.customer_label)
            else:
                queue.push({ node: nextNode })

    return {
        affected_cables: Array.from(affected_cables),   // render these red
        affected_customers: affected_customers,
        affected_node_count: visited_nodes.size
    }
```

## Key implementation points

1. **Splitter fan-out is the part most likely to be missing in a naive implementation.** A splice is 1-to-1 so it's easy to get right by accident; a splitter is 1-to-many — if traversal only follows single-core links, it silently stops at any box containing a splitter instead of continuing down all of its live ports.
2. **`isDownstreamSide` / `isDownstreamOfFailure` must be based on headend direction**, not just "the other end of whatever core the failure entered on" — otherwise a failure can incorrectly propagate backward toward the OLT too.
3. **Visited-node tracking is required** even though most OSP networks are trees — ring topologies and redundant feeds exist, and without a visited-set a cycle will infinite-loop the traversal.
4. **Return cable IDs, not core IDs, for rendering** — dedupe at the cable level so a 12-fiber cable doesn't produce 12 redundant "mark this cable red" instructions.
5. **Stop at customer terminations, not before** — the final drop cable to the customer must also be marked red, since that segment is in fact dead.

## Test cases

Build a small test network: `Headend → Box A (splice, no splitter) → Box B (1:8 splitter, 4 ports used) → 4 customers`, plus `Box A → Box C → 1 customer` so the tree isn't linear.

- Failure at **Box A** → expect all cables to Box B, all 4 of Box B's occupied splitter output cables, Box C's cable, and Box C's customer cable red. 6 customers affected.
- Failure at **Box B** → expect only Box B's 4 splitter-fed cables red, Box C's cable untouched. 4 customers affected.
- Failure at the **cable between Headend and Box A** → same result as failing Box A itself.
