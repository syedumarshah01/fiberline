/**
 * Impact / outage analysis — pure graph logic, no database access.
 *
 * The trace in fiberTrace.js walks *connectivity*: from a starting core it
 * follows splices outward in every direction. Impact analysis asks the
 * opposite question — "if this pole / box / cable fails, who goes dark?" — and
 * can only answer it with a sense of direction, because the splice graph is
 * undirected: a branch hanging off the same box is electrically connected but
 * completely unaffected by a cut on the far side of it.
 *
 * Direction comes from the network root (a `headends` row): the OLT feeds one
 * box, and everything reachable from that box is downstream. We root the graph
 * there, then a failure surface is only "the things at the failure", and the
 * affected set is the subtree hanging *below* that surface. Without a
 * configured root there is no way to tell upstream from downstream, so the
 * analysis degrades to an undirected flood of the whole connected component
 * and says so (`direction: 'undirected'`, plus a warning).
 *
 * Nodes in the light path are fiber cores and splitters:
 *   - a splice joins two cores (bidirectional in the graph — direction comes
 *     from the root, not from core_a/core_b, which is documentation only);
 *   - a splitter's input core feeds its ports (one-way, downstream);
 *   - a cascaded splitter is fed from the parent splitter's port (one-way).
 * Light travels a core from one enclosure to the other, which is why both ends
 * of an affected cable count as part of the outage.
 */

const DEFAULT_MAX_NODES = 5000;
const DEFAULT_MAX_CUSTOMERS = 500;
const MAX_RESTORABLE_LISTED = 50;

/**
 * Which boxes does the light enter at, when nobody has said?
 *
 * A `headends` row is the authoritative answer and always wins (see
 * services/impactAnalysis.js). But the common case is a network where nobody has
 * pointed at the OLT, and the previous answer to that — walk the graph both ways
 * from the failure — paints the span that *feeds* the failed box red, which is
 * wrong in a way the reader cannot see: that span still has light on it as far as
 * the break. A technician sent to a fault reads that map and is told the cable
 * they are standing on is out.
 *
 * The network's own shape usually says where the light comes from: every cable is
 * recorded with a `from` and a `to` end, so the boxes a cable *leaves* and the
 * boxes a cable *arrives at* are known. The boxes nothing feeds are the places
 * light can enter — in a distribution network that is the OLT, and taking all of
 * them covers a network with several OLTs (each gets its own source, which is
 * exactly right) or one drawn as several islands.
 *
 * Two guards keep the inference honest:
 *   - a box that only hands out drop cables is a distribution point whose feeder
 *     nobody recorded, not a light source, so it is not treated as one;
 *   - a box a cable arrives at is downstream of something by definition.
 *
 * Callers must report the result as inferred rather than known (the analysis
 * does: `direction_source: 'inferred'`, naming the boxes), because a network
 * drawn end-to-end backwards would invert the answer — and the one thing worse
 * than "we could not tell which way is downstream" is a confident wrong answer.
 */
function inferSourceBoxes({ enclosures = [], cables = [] } = {}) {
  const boxIds = new Set(enclosures.map((e) => e.id));
  const arrivesAt = new Map(); // boxId → number of cables ending there
  const leavesFrom = new Map(); // boxId → cable rows leaving there

  for (const cable of cables) {
    const from = cable.from_enclosure_id;
    const to = cable.to_enclosure_id;
    if (from && boxIds.has(from)) push(leavesFrom, from, cable);
    if (to && boxIds.has(to)) arrivesAt.set(to, (arrivesAt.get(to) || 0) + 1);
  }

  const sources = [];
  for (const box of enclosures) {
    if ((arrivesAt.get(box.id) || 0) > 0) continue; // something feeds it
    const leaving = leavesFrom.get(box.id) || [];
    if (!leaving.length) continue; // a leaf (a customer's box) feeds nothing
    // A box that only hands out drops distributes, it does not source: its
    // feeder is simply missing from the documentation.
    if (!leaving.some((cable) => cable.cable_type !== 'drop')) continue;
    sources.push({ id: box.id, code: box.code ?? null, out_degree: leaving.length });
  }
  return sources;
}

/** Every core of every cable landing at one of `boxIds` — where light enters. */
function rootCoreIdsForBoxes({ cables = [], cores = [] }, boxIds = []) {
  const wanted = new Set(boxIds.filter(Boolean));
  if (!wanted.size) return [];
  const landsAtRoot = new Set();
  for (const cable of cables) {
    if (wanted.has(cable.from_enclosure_id) || wanted.has(cable.to_enclosure_id)) {
      landsAtRoot.add(cable.id);
    }
  }
  return cores.filter((core) => landsAtRoot.has(core.cable_id)).map((core) => core.id);
}

function coreKey(id) {
  return `core:${id}`;
}

function splitterKey(id) {
  return `splitter:${id}`;
}

function keyKind(key) {
  return String(key).startsWith('core:') ? 'core' : 'splitter';
}

function keyId(key) {
  const s = String(key);
  return s.slice(s.indexOf(':') + 1);
}

function push(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** First value of a map-of-arrays entry (a cable has one downstream half at most). */
function firstValue(map, key) {
  return (map.get(key) || [])[0] ?? null;
}

function uniq(values) {
  return [...new Set(values)];
}

// --- graph construction -------------------------------------------------------

/**
 * Index every row by id and build the light-path adjacency:
 *   spliceEdges — core ↔ core (undirected; direction is decided by the root)
 *   downEdges   — the edges that only carry light one way (core → splitter,
 *                 splitter → output core, splitter → cascaded child splitter)
 *   upEdges     — the reverse of downEdges, used by the undirected flood
 */
function indexNetwork({
  cores = [],
  cables = [],
  enclosures = [],
  splices = [],
  splitters = [],
  ports = [],
  customers = [],
} = {}) {
  const coreById = new Map(cores.map((c) => [c.id, c]));
  const cableById = new Map(cables.map((c) => [c.id, c]));
  const boxById = new Map(enclosures.map((e) => [e.id, e]));
  const customerById = new Map(customers.map((c) => [c.id, c]));
  const splitterById = new Map(splitters.map((s) => [s.id, s]));

  const portsBySplitter = new Map();
  for (const port of ports) push(portsBySplitter, port.splitter_id, port);

  const coresByCable = new Map();
  for (const core of cores) push(coresByCable, core.cable_id, core);
  const coreOnCable = (cableId, coreNumber) =>
    cableId == null || coreNumber == null
      ? null
      : (coresByCable.get(cableId) || []).find((c) => c.core_number === coreNumber) || null;

  // Mid-span splits: `child.continues_cable_id = parent.id` means the fiber
  // physically runs on from the parent's core #n to the child's core #n, inside
  // whatever closure sits between them. Indexed both ways so a walk can step
  // across the box in either direction.
  const continuationByChild = new Map();
  for (const cable of cables) {
    if (cable.continues_cable_id) continuationByChild.set(cable.id, cable.continues_cable_id);
  }
  const continuesByParent = new Map();
  for (const [childId, parentId] of continuationByChild) {
    push(continuesByParent, parentId, childId);
  }

  /**
   * The core that continues `core` across a mid-span split, or null:
   *   'down' — parent core → child core (following the light away from the OLT)
   *   'up'   — child core  → parent core (how the light arrived)
   * Cores pair by number, which is how the insert route builds them.
   */
  const continuationOf = (core, direction) => {
    const cable = cableById.get(core.cable_id);
    if (!cable) return null;
    return direction === 'up'
      ? coreOnCable(continuationByChild.get(cable.id), core.core_number)
      : coreOnCable(firstValue(continuesByParent, cable.id), core.core_number);
  };

  const spliceEdges = new Map();
  const downEdges = new Map();
  const upEdges = new Map();

  // Every core that a recorded joint names: both sides of a splice, a splitter's
  // input, a splitter port's output. A joint is evidence the fibre is part of the
  // plant — see inPlant().
  const joinedCoreIds = new Set();
  for (const splice of splices) {
    if (splice.core_a_id) joinedCoreIds.add(splice.core_a_id);
    if (splice.core_b_id) joinedCoreIds.add(splice.core_b_id);
  }
  for (const splitter of splitters) {
    if (splitter.input_core_id) joinedCoreIds.add(splitter.input_core_id);
  }
  for (const port of ports) {
    if (port.output_core_id) joinedCoreIds.add(port.output_core_id);
  }

  for (const splice of splices) {
    const a = coreKey(splice.core_a_id);
    const b = coreKey(splice.core_b_id);
    const via = {
      type: 'splice',
      splice_id: splice.id,
      box_id: splice.enclosure_id ?? null,
      splice_type: splice.splice_type ?? null,
    };
    push(spliceEdges, a, { node: b, via });
    push(spliceEdges, b, { node: a, via });
  }

  for (const splitter of splitters) {
    const node = splitterKey(splitter.id);
    if (splitter.input_core_id) {
      const via = {
        type: 'splitter_input',
        splitter_id: splitter.id,
        box_id: splitter.enclosure_id ?? null,
      };
      push(downEdges, coreKey(splitter.input_core_id), { node, via });
      push(upEdges, node, { node: coreKey(splitter.input_core_id), via });
    }
  }

  for (const port of ports) {
    const parent = splitterById.get(port.splitter_id);
    const node = splitterKey(port.splitter_id);
    if (port.output_core_id) {
      const via = {
        type: 'splitter_port',
        splitter_id: port.splitter_id,
        port_number: port.port_number ?? null,
        box_id: parent?.enclosure_id ?? null,
      };
      push(downEdges, node, { node: coreKey(port.output_core_id), via });
      push(upEdges, coreKey(port.output_core_id), { node, via });
    }
    if (port.output_splitter_id) {
      const via = {
        type: 'splitter_cascade',
        splitter_id: port.splitter_id,
        port_number: port.port_number ?? null,
        child_splitter_id: port.output_splitter_id,
        box_id: parent?.enclosure_id ?? null,
      };
      push(downEdges, node, { node: splitterKey(port.output_splitter_id), via });
      push(upEdges, splitterKey(port.output_splitter_id), { node, via });
    }
  }

  return {
    cores,
    cables,
    enclosures,
    splices,
    splitters,
    ports,
    coreById,
    cableById,
    boxById,
    customerById,
    splitterById,
    portsBySplitter,
    spliceEdges,
    downEdges,
    upEdges,
    joinedCoreIds,
    // Mid-span splits (see continuationEdges, unlinkedSplitCandidates)
    coresByCable,
    continuationByChild,
    continuesByParent,
    continuationOf,
    coreOnCable,
  };
}

/**
 * The mid-span link of a cable, in the shape the API reports it: the half it
 * continues, the half that continues it, and the closure in between. One
 * direction is authoritative (`continues_*`, exactly like the column); the other
 * is derived here so every affected cable in a report can be read on its own.
 */
function cableContinuationFields(index, cable) {
  const codeOf = (boxId) => (boxId ? index.boxById.get(boxId)?.code ?? null : null);
  const parentId = cable ? index.continuationByChild.get(cable.id) ?? null : null;
  const parent = parentId ? index.cableById.get(parentId) ?? null : null;
  // The joint sits where the downstream half starts.
  const atBoxId = parentId ? cable.from_enclosure_id ?? null : null;

  const continuedBy = [];
  for (const childId of cable ? index.continuesByParent.get(cable.id) || [] : []) {
    const child = index.cableById.get(childId) ?? null;
    const boxId = child?.from_enclosure_id ?? null;
    continuedBy.push({ id: childId, code: child?.code ?? null, at_box_id: boxId, at_box_code: codeOf(boxId) });
  }

  return {
    continues_cable_id: parentId,
    continues_cable_code: parent?.code ?? null,
    continues_at_box_id: atBoxId,
    continues_at_box_code: codeOf(atBoxId),
    continued_by: continuedBy,
  };
}

function nodeExists(index, key) {
  return keyKind(key) === 'core'
    ? index.coreById.has(keyId(key))
    : index.splitterById.has(keyId(key));
}

/**
 * Root the light path at the OLT: a traversal from the root cores out to the
 * ends of the network, recording for every node which node feeds it (its
 * `parent`) and the joint in between.
 *
 * A splice is physically bidirectional, so it is followed either way here —
 * the *root* is what decides which direction the light goes, and a splice on
 * the far side of a node is only ever recorded as that node's parent, never as
 * its child. Splitter edges are one-way and are only followed input → output,
 * so a splitter can never be oriented backwards.
 *
 * The result is the rooted tree that "subtree downstream of the failure" means.
 */
function orientLightPath(index, rootKeys, { maxNodes = DEFAULT_MAX_NODES } = {}) {
  const parents = new Map();
  const children = new Map();
  const depths = new Map();
  const reached = new Set();
  const order = [];
  let truncated = false;

  const visit = (key, from, via, depth) => {
    reached.add(key);
    depths.set(key, depth);
    order.push(key);
    if (from) {
      parents.set(key, { node: from, via });
      push(children, from, { node: key, via });
    }
  };

  const queue = [];
  for (const root of uniq(rootKeys)) {
    if (!root || reached.has(root) || !nodeExists(index, root)) continue;
    visit(root, null, null, 0);
    queue.push(root);
  }

  while (queue.length) {
    const key = queue.shift();
    const depth = depths.get(key) ?? 0;
    // Splice edges both ways + splitter edges downstream only.
    const edges = [
      ...(index.spliceEdges.get(key) || []),
      ...(index.downEdges.get(key) || []),
      ...continuationEdges(index, key),
    ];
    for (const edge of edges) {
      if (reached.has(edge.node)) continue;
      visit(edge.node, key, edge.via, depth + 1);
      queue.push(edge.node);
      if (order.length >= maxNodes) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
  }

  return { reached, parents, children, depths, truncated };
}

/**
 * Cables that look like the downstream half of a split the database never
 * linked: named `<upstream code>-B`, starting where that cable ends, same type
 * and core count — the same rule the migration's backfill and
 * scripts/linkSplits.js use. Only pairs whose downstream core is among the
 * unreached ones are reported, so the hint is about the gap in front of the
 * user, not a general audit of the network.
 */
function unlinkedSplitCandidates(index, unreachedCoreIds) {
  const unreachedCables = new Set(
    unreachedCoreIds
      .map((id) => index.coreById.get(id)?.cable_id)
      .filter(Boolean),
  );
  if (!unreachedCables.size) return [];

  const pairs = [];
  for (const child of index.cables) {
    if (child.continues_cable_id || child.cable_type === 'drop') continue;
    if (!child.from_enclosure_id) continue;
    if (![...(index.coresByCable?.get(child.id) || [])].some((core) => unreachedCables.has(core.cable_id))) {
      continue;
    }
    if (!child.code.endsWith('-B')) continue;
    const parentCode = child.code.slice(0, -2);

    const parent = index.cables.find(
      (cable) =>
        cable.code === parentCode &&
        cable.to_enclosure_id === child.from_enclosure_id &&
        cable.cable_type === child.cable_type &&
        cable.core_count === child.core_count &&
        cable.id !== child.id,
    );
    if (parent) {
      pairs.push({ child_id: child.id, child_code: child.code, parent_id: parent.id, parent_code: parent.code });
    }
  }
  return pairs;
}

/**
 * The continuation edges of a node, as graph edges: a core whose cable runs on
 * into another cable across a mid-span closure links to the same core number on
 * the other side. Direction is the orientation's job, so both ways are listed
 * here.
 */
function continuationEdges(index, key) {
  if (keyKind(key) !== 'core') return [];
  const core = index.coreById.get(keyId(key));
  if (!core) return [];
  const edges = [];
  for (const direction of ['down', 'up']) {
    const next = index.continuationOf(core, direction);
    if (!next || next.id === core.id) continue;
    const nextCable = index.cableById.get(next.cable_id);
    edges.push({
      node: coreKey(next.id),
      via: {
        type: 'continuation',
        // The closure the fiber passes through — the box between the two
        // halves is as dark as the cables on either side of it.
        box_id:
          direction === 'up'
            ? index.cableById.get(core.cable_id)?.from_enclosure_id ?? null
            : nextCable?.from_enclosure_id ?? null,
        splice_id: null,
        from_cable_id: core.cable_id,
        to_cable_id: next.cable_id,
      },
    });
  }
  return edges;
}

/**
 * Every edge light can leave this node by, ignoring whether it is still there:
 * splices both ways, splitter input → outputs only (light never flows backwards
 * through a splitter), and mid-span continuations both ways.
 *
 * This is the light-path graph. `orientLightPath` builds a *tree* over it for
 * paths; reachability must not use that tree, or a second path to a node (a ring,
 * a core patched twice at one box) would look dark.
 */
function lightEdges(index, key) {
  return [
    ...(index.spliceEdges.get(key) || []),
    ...(index.downEdges.get(key) || []),
    ...continuationEdges(index, key),
  ];
}

/**
 * Everything the light can reach from `roots`, over the full light-path graph.
 *
 * This is the one definition of "has light": light leaves the headend's root
 * cores and travels splices (either way), splitter ports (input → output) and
 * mid-span continuations, and it does not pass through anything that failed:
 *
 *   - a joint inside a failed box is gone — an edge whose `via.box_id` is one of
 *     the failed boxes is not traversable, which is what stops a walk at an
 *     inserted closure or a burnt cabinet;
 *   - a fibre on a failed cable is cut — nothing enters it, so every core of that
 *     cable is dark; a *root* sitting on a failed cable is still where the light
 *     is injected, but the light is not followed out of it, because the app does
 *     not know where along the span the break is;
 *   - a root whose own box failed is not a source at all — that is the headend
 *     going out, not a cut, and everything is dark.
 *
 * Reachability is what "dark" is measured against: a node is dark when it was
 * reachable before the failure and is not reachable after it.
 */
function reachableKeys(
  index,
  roots,
  { failureBoxIds = new Set(), failureCableIds = new Set(), rootBoxIds = new Set() } = {},
) {
  const reached = new Set();
  const queue = [];
  const onFailedCable = (key) => {
    if (keyKind(key) !== 'core') return false;
    const core = index.coreById.get(keyId(key));
    return Boolean(core) && failureCableIds.has(core.cable_id);
  };

  for (const root of roots) {
    if (reached.has(root)) continue;
    const core = index.coreById.get(keyId(root));
    const cable = core ? index.cableById.get(core.cable_id) : null;
    // Where the light is injected. Only this failure being *at* that box kills it.
    const sourceGone =
      Boolean(cable) &&
      ((failureBoxIds.has(cable.from_enclosure_id) && rootBoxIds.has(cable.from_enclosure_id)) ||
        (failureBoxIds.has(cable.to_enclosure_id) && rootBoxIds.has(cable.to_enclosure_id)));
    if (sourceGone) continue;
    reached.add(root);
    queue.push(root);
  }

  while (queue.length) {
    const key = queue.shift();
    if (onFailedCable(key)) continue; // the light dies inside a cut span
    for (const edge of lightEdges(index, key)) {
      if (reached.has(edge.node)) continue;
      if (edge.via?.box_id && failureBoxIds.has(edge.via.box_id)) continue; // dead joint
      if (onFailedCable(edge.node)) continue; // no light into a cut cable's fibre
      reached.add(edge.node);
      queue.push(edge.node);
    }
  }

  return reached;
}

/**
 * Walk downstream only: from each seed, follow the rooted tree's child edges.
 * This is what keeps a failure from reporting branches that merely share an
 * upstream box — light does not flow back up a splice.
 */
function floodDownstream(index, orientation, seeds, { maxNodes = DEFAULT_MAX_NODES } = {}) {
  const parents = new Map();
  const depths = new Map();
  const visited = new Set();
  const queue = [];
  const order = [];
  let truncated = false;

  for (const seed of uniq(seeds)) {
    if (!seed || visited.has(seed) || !orientation.reached.has(seed)) continue;
    visited.add(seed);
    depths.set(seed, 0);
    queue.push(seed);
    order.push(seed);
  }

  while (queue.length) {
    const key = queue.shift();
    for (const edge of orientation.children.get(key) || []) {
      if (visited.has(edge.node)) continue;
      visited.add(edge.node);
      parents.set(edge.node, { node: key, via: edge.via });
      depths.set(edge.node, (depths.get(key) ?? 0) + 1);
      order.push(edge.node);
      queue.push(edge.node);
      if (order.length >= maxNodes) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
  }

  return { keys: order, visited, parents, depths, truncated };
}

/**
 * Direction-agnostic flood — every edge, both ways. This is the fallback for
 * networks with no configured root, and for a failure point that is not
 * connected to one: it over-reports, and every caller says so in `warnings`.
 */
function floodUndirected(index, seeds, { maxNodes = DEFAULT_MAX_NODES } = {}) {
  const parents = new Map();
  const depths = new Map();
  const visited = new Set();
  const queue = [];
  const order = [];
  let truncated = false;

  for (const seed of uniq(seeds)) {
    if (!seed || visited.has(seed) || !nodeExists(index, seed)) continue;
    visited.add(seed);
    depths.set(seed, 0);
    queue.push(seed);
    order.push(seed);
  }

  while (queue.length) {
    const key = queue.shift();
    const edges = [
      ...(index.spliceEdges.get(key) || []),
      ...(index.downEdges.get(key) || []),
      ...(index.upEdges.get(key) || []),
      // A mid-span split is a step along one fiber; never step back into the
      // node we arrived from (that is the parent link, already recorded).
      ...continuationEdges(index, key).filter(
        (edge) => parents.get(key)?.node !== edge.node,
      ),
    ];
    for (const edge of edges) {
      if (visited.has(edge.node)) continue;
      visited.add(edge.node);
      parents.set(edge.node, { node: key, via: edge.via });
      depths.set(edge.node, (depths.get(key) ?? 0) + 1);
      order.push(edge.node);
      queue.push(edge.node);
      if (order.length >= maxNodes) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
  }

  return { keys: order, visited, parents, depths, truncated };
}

/**
 * Walk only away from a failed box when the light root cannot reach the failure
 * surface. This is deliberately narrower than `floodUndirected`: it starts at
 * connected output cores and splitter ports, follows splitter edges, crosses a
 * splice only from a cable arriving at a box to a cable leaving that box, and
 * follows a continuation from its parent half to its child half. It can recover
 * the useful downstream report for a partially documented segment without ever
 * walking back into the cable that feeds the failed box.
 */
function floodBoxDownstream(index, seeds, failureBoxIds, { maxNodes = DEFAULT_MAX_NODES } = {}) {
  const parents = new Map();
  const depths = new Map();
  const visited = new Set();
  const queue = [];
  const order = [];
  let truncated = false;

  const outgoingCore = (key) => {
    if (keyKind(key) !== 'core') return false;
    const core = index.coreById.get(keyId(key));
    const cable = core ? index.cableById.get(core.cable_id) : null;
    return Boolean(core && cable && failureBoxIds.has(cable.from_enclosure_id) && index.joinedCoreIds.has(core.id));
  };

  const startable = (key) => {
    if (keyKind(key) === 'splitter') {
      return failureBoxIds.has(index.splitterById.get(keyId(key))?.enclosure_id);
    }
    return outgoingCore(key);
  };

  const edgesAway = (key) => {
    const edges = [...(index.downEdges.get(key) || [])];
    if (keyKind(key) !== 'core') return edges;

    const core = index.coreById.get(keyId(key));
    const cable = core ? index.cableById.get(core.cable_id) : null;
    if (!core || !cable) return edges;

    // A splice carries light from the cable arriving at this enclosure to the
    // cable leaving it. The reverse edge is the IN path and is intentionally not
    // followed.
    for (const edge of index.spliceEdges.get(key) || []) {
      const next = index.coreById.get(keyId(edge.node));
      const nextCable = next ? index.cableById.get(next.cable_id) : null;
      const boxId = edge.via?.box_id;
      if (
        boxId &&
        cable.to_enclosure_id === boxId &&
        nextCable?.from_enclosure_id === boxId
      ) {
        edges.push(edge);
      }
    }

    // A continuation is directional in the cable model: parent half → child
    // half. `continuationEdges` also exposes the reverse edge, so keep only the
    // one that leaves this cable's downstream endpoint.
    for (const edge of continuationEdges(index, key)) {
      if (edge.via?.from_cable_id !== core.cable_id) continue;
      const next = index.coreById.get(keyId(edge.node));
      const nextCable = next ? index.cableById.get(next.cable_id) : null;
      if (nextCable?.from_enclosure_id === cable.to_enclosure_id) edges.push(edge);
    }
    return edges;
  };

  for (const seed of uniq(seeds)) {
    if (!seed || visited.has(seed) || !nodeExists(index, seed) || !startable(seed)) continue;
    visited.add(seed);
    depths.set(seed, 0);
    queue.push(seed);
    order.push(seed);
  }

  while (queue.length) {
    const key = queue.shift();
    for (const edge of edgesAway(key)) {
      if (visited.has(edge.node)) continue;
      visited.add(edge.node);
      parents.set(edge.node, { node: key, via: edge.via });
      depths.set(edge.node, (depths.get(key) ?? 0) + 1);
      order.push(edge.node);
      queue.push(edge.node);
      if (order.length >= maxNodes) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
  }

  return { keys: order, visited, parents, depths, truncated };
}

/** Combine several floods (rooted + unrooted seeds) into one result set. */
function mergeFloods(parts) {
  const keys = [];
  const visited = new Set();
  const parents = new Map();
  const depths = new Map();
  let truncated = false;

  for (const part of parts) {
    for (const key of part.keys) {
      if (visited.has(key)) continue;
      visited.add(key);
      keys.push(key);
    }
    for (const [key, value] of part.parents) if (!parents.has(key)) parents.set(key, value);
    for (const [key, value] of part.depths) if (!depths.has(key)) depths.set(key, value);
    truncated = truncated || part.truncated;
  }
  return { keys, visited, parents, depths, truncated };
}

// --- failure surface ----------------------------------------------------------

/**
 * Everything light would lose at the failure point, as graph seeds:
 *
 *   - a **cable** failure cuts every core that cable carries;
 *   - a **box** failure cuts every splice inside it, every splitter inside it
 *     (their ports go dark), and every core that lands on it — a core landing
 *     there is either spliced on, dead-ended (no descendants, so no false
 *     positives) or fed from elsewhere on the segment;
 *   - a **pole** failure arrives here as the boxes mounted on it plus any
 *     cables running through it (resolved by the route layer, with PostGIS).
 *
 * Seeding is deliberately generous: the downstream walk is what keeps
 * unaffected branches out of the result, not a narrow seed set.
 */
function failureSurfaceSeeds(index, { failureBoxIds = new Set(), failureCableIds = new Set() } = {}) {
  const seedKeys = new Set();
  const seedCoreIds = new Set();
  const seedSplitterIds = new Set();

  for (const core of index.cores) {
    const cable = index.cableById.get(core.cable_id);
    if (!cable) continue;
    const onCutCable = failureCableIds.has(cable.id);
    const landsAtFailedBox =
      failureBoxIds.has(cable.from_enclosure_id) ||
      failureBoxIds.has(cable.to_enclosure_id);
    if (onCutCable || landsAtFailedBox) {
      seedKeys.add(coreKey(core.id));
      seedCoreIds.add(core.id);
    }
  }

  for (const splice of index.splices) {
    if (!failureBoxIds.has(splice.enclosure_id)) continue;
    for (const coreId of [splice.core_a_id, splice.core_b_id]) {
      if (!coreId) continue;
      seedKeys.add(coreKey(coreId));
      seedCoreIds.add(coreId);
    }
  }

  for (const splitter of index.splitters) {
    if (!failureBoxIds.has(splitter.enclosure_id)) continue;
    seedKeys.add(splitterKey(splitter.id));
    seedSplitterIds.add(splitter.id);
    for (const port of index.portsBySplitter.get(splitter.id) || []) {
      if (port.output_core_id) {
        seedKeys.add(coreKey(port.output_core_id));
        seedCoreIds.add(port.output_core_id);
      }
    }
  }

  return {
    seedKeys: [...seedKeys],
    seedCoreIds: [...seedCoreIds],
    seedSplitterIds: [...seedSplitterIds],
  };
}

// --- paths --------------------------------------------------------------------

function describeNode(index, key) {
  if (keyKind(key) === 'core') {
    const core = index.coreById.get(keyId(key));
    if (!core) return null;
    const cable = index.cableById.get(core.cable_id) || null;
    const from = cable ? index.boxById.get(cable.from_enclosure_id) : null;
    const to = cable ? index.boxById.get(cable.to_enclosure_id) : null;
    return {
      kind: 'fiber',
      core_id: core.id,
      core_number: core.core_number ?? null,
      status: core.status ?? null,
      cable_id: cable?.id ?? null,
      cable_code: cable?.code ?? null,
      cable_type: cable?.cable_type ?? null,
      box_from_id: from?.id ?? null,
      box_from_code: from?.code ?? null,
      box_to_id: to?.id ?? null,
      box_to_code: to?.code ?? null,
      customer_label: cable?.customer_label ?? null,
    };
  }
  const splitter = index.splitterById.get(keyId(key));
  if (!splitter) return null;
  const box = index.boxById.get(splitter.enclosure_id) || null;
  return {
    kind: 'splitter',
    splitter_id: splitter.id,
    name: splitter.name ?? null,
    split_count: splitter.split_count ?? null,
    box_id: box?.id ?? null,
    box_code: box?.code ?? null,
  };
}

function describeVia(index, via) {
  if (!via) return null;
  const box = index.boxById.get(via.box_id) || null;
  const fromCable = index.cableById.get(via.from_cable_id) || null;
  const toCable = index.cableById.get(via.to_cable_id) || null;
  return {
    kind: via.type,
    splice_id: via.splice_id ?? null,
    splitter_id: via.splitter_id ?? null,
    child_splitter_id: via.child_splitter_id ?? null,
    port_number: via.port_number ?? null,
    box_id: box?.id ?? via.box_id ?? null,
    box_code: box?.code ?? null,
    // For a mid-span continuation: the cable carrying on into the next one.
    from_cable_id: fromCable?.id ?? null,
    from_cable_code: fromCable?.code ?? null,
    to_cable_id: toCable?.id ?? null,
    to_cable_code: toCable?.code ?? null,
  };
}

/**
 * The chain from the failure seed down to `targetKey`, as display items:
 * fiber segments and the joints (splice / splitter port) between them.
 *
 * `parents` is the parent map of the flood that reached the target. When the
 * walk lands on a seed (the flood started there), there is no parent to
 * continue with — if the seed sits on the failed element, the chain is
 * extended up through the orientation so the path still shows which joint in
 * the failed box connects it (e.g. the splitter port a drop hangs off).
 */
const MAX_SEED_EXTENSION_HOPS = 6;
const MAX_PATH_STEPS = 60;

function buildPath(index, parents, targetKey, { orientation = null, failureBoxIds = null } = {}) {
  const chain = [];
  const guard = new Set();
  let key = targetKey;
  while (key && !guard.has(key)) {
    guard.add(key);
    const parent = parents.get(key);
    chain.push({ key, via: parent?.via ?? null });
    if (!parent) {
      if (orientation && failureBoxIds) {
        let cursor = key;
        for (let i = 0; i < MAX_SEED_EXTENSION_HOPS; i++) {
          const up = orientation.parents.get(cursor);
          if (!up || !up.via?.box_id || !failureBoxIds.has(up.via.box_id)) break;
          if (guard.has(up.node)) break;
          // The joint into `cursor` belongs to the cursor's own step …
          chain[chain.length - 1].via = up.via;
          guard.add(up.node);
          // … and the node above it carries its own joint on the next pass.
          chain.push({ key: up.node, via: null });
          cursor = up.node;
        }
      }
      break;
    }
    if (guard.size >= MAX_PATH_STEPS) break;
    key = parent.node;
  }
  chain.reverse(); // seed → target

  // Walked in light order: the seed segment, then for each following node the
  // joint that carries the light into it, then the node itself.
  const items = [];
  for (let i = 0; i < chain.length; i++) {
    const step = chain[i];
    if (i > 0 && step.via) {
      const joint = describeVia(index, step.via);
      if (joint) items.push(joint);
    }
    const node = describeNode(index, step.key);
    if (node) items.push(node);
  }
  return items;
}

// --- customers ----------------------------------------------------------------

/**
 * Does this core serve a customer? Two shapes exist in the data: a drop cable
 * carrying a `customer_id` / `customer_label`, and a core marked `terminated`
 * (patched to equipment at a box, which may or may not have a label).
 */
/**
 * Is this core carrying light to somewhere it ends?
 *
 * `terminated` means the strand ends at a premise or equipment; `spliced` means
 * it is part of the live chain. `available` is a spare, `reserved` is held for a
 * future customer, `damaged` is broken — none of those serve anybody, so a
 * multi-fiber drop's unused strands never inflate the outage count.
 */
function inService(core) {
  return core.status === 'terminated' || core.status === 'spliced';
}

/**
 * Is this fibre part of the working plant, rather than a spare?
 *
 * Its own status is the first answer — 'spliced' and 'terminated' carry service —
 * but it is not the only one. A fibre that a recorded joint names (either side of
 * a splice, a splitter's input, a splitter port's output) is joined to something
 * *in the database*, and a status column somebody edited by hand must not unhappen
 * that. `PATCH /api/fiber-cores/:id` can set a core back to 'available' while its
 * splice row still stands, and imported data arrives that way; the outage report
 * has to believe the joint, because the box is what holds it.
 *
 * This is the rule behind "every fibre spliced into that box is out when the box
 * is": the joint dies with the box, so the cable carrying the fibre is painted,
 * whether or not the status agreed it was in service. It was exactly this gap
 * that let the panel report a customer down while the map drew their drop cable
 * as though nothing had happened.
 *
 * A spare — 'available', in no splice, on no splitter — is deliberately *not* in
 * the plant: an unused strand must never paint the cable that feeds a failed box.
 */
function inPlant(index, core) {
  if (!core) return false;
  if (inService(core)) return true;
  return index.joinedCoreIds.has(core.id);
}

/**
 * Does this core end inside a customer's own box? The app creates those as
 * `terminal` enclosures ("Add customer box" → CUST-BOX-…), so a lit core
 * landing in one is that customer's leg even if nobody labelled the drop.
 */
function landsAtCustomerBox(index, core) {
  if (!inPlant(index, core)) return false;
  const cable = index.cableById.get(core.cable_id);
  if (!cable) return false;
  for (const boxId of [cable.from_enclosure_id, cable.to_enclosure_id]) {
    if (boxId && index.boxById.get(boxId)?.type === 'terminal') return true;
  }
  return false;
}

/**
 * Who does this core serve, if anyone?
 *
 * A core is a customer leg when any of these is true:
 *   1. the cable carries a `customer_id` or `customer_label` — documented premise;
 *   2. the core is `terminated` — the strand ends at a premise/equipment;
 *   3. the cable is a *drop* and the core is in service — a drop cable exists for
 *      no other reason than to reach one premise, and `to_enclosure_id` is null
 *      by design, so the premise is the far end by definition;
 *   4. the core lands in a `terminal` customer box.
 *
 * (3) and (4) exist because documentation is not always filled in: without them
 * the map paints a drop red while the panel insists nobody is affected, which is
 * worse than an unattributed entry — an unknown customer is still a customer.
 */
function servedCustomer(index, core) {
  const cable = index.cableById.get(core.cable_id) || null;
  const customerId = cable?.customer_id ?? null;
  const label = cable?.customer_label ?? null;
  const isDrop = cable?.cable_type === 'drop';
  const terminated = core.status === 'terminated';
  const inferred = !customerId && !label && ((isDrop && inPlant(index, core)) || landsAtCustomerBox(index, core));
  if (!customerId && !label && !terminated && !inferred) return null;

  const known = customerId ? index.customerById.get(customerId) : null;
  const key = customerId
    ? `customer:${customerId}`
    : label
      ? `label:${label}`
      // One drop cable reaches one premises, so its lit strands are one
      // customer, not one per strand.
      : isDrop
        ? `drop:${cable.id}`
        : `core:${core.id}`;
  return {
    key,
    customer_id: customerId,
    customer_label: label || known?.customer_code || null,
    customer_name: known?.name || null,
    unnamed: !customerId && !label,
    // How we decided this is a customer: 'documented' (label/customer record),
    // 'terminated' / 'drop' / 'customer_box' (inferred from the network shape).
    source: customerId || label ? 'documented' : terminated ? 'terminated' : isDrop ? 'drop' : 'customer_box',
    core_id: core.id,
    core_number: core.core_number ?? null,
    cable_id: cable?.id ?? null,
    cable_code: cable?.code ?? null,
    cable_type: cable?.cable_type ?? null,
    status: core.status ?? null,
  };
}

/** The box a customer terminates at (the box the drop leaves from). */
function servingBox(index, core) {
  const cable = index.cableById.get(core.cable_id);
  if (!cable) return null;
  const boxId = cable.from_enclosure_id || cable.to_enclosure_id || null;
  const box = boxId ? index.boxById.get(boxId) : null;
  return box ? { id: box.id, code: box.code } : null;
}

// --- the analysis itself --------------------------------------------------------

function analyzeImpact({
  cores = [],
  cables = [],
  enclosures = [],
  splices = [],
  splitters = [],
  ports = [],
  customers = [],
  boxIds = [],
  cableIds = [],
  rootCoreIds = [],
  // The headend's own enclosure(s): the boxes the light is injected at. Failing
  // one of those takes the source out; failing any other box is a cut.
  rootBoxIds = [],
  maxNodes = DEFAULT_MAX_NODES,
  maxCustomers = DEFAULT_MAX_CUSTOMERS,
} = {}) {
  const index = indexNetwork({
    cores, cables, enclosures, splices, splitters, ports, customers,
  });

  const failureBoxIds = new Set(boxIds.filter(Boolean));
  const failureCableIds = new Set(cableIds.filter(Boolean));
  // The boxes the light is injected at (the headend's own) — see reachableKeys.
  const rootBoxSet = new Set(rootBoxIds.filter(Boolean));
  const warnings = [];

  const roots = uniq(rootCoreIds.filter((id) => index.coreById.has(id))).map(coreKey);
  const directed = roots.length > 0;

  // Root the light path at the OLT, if one is configured: the tree is what paths
  // are read off, and the two reachable sets are what "dark" is measured against.
  const orientation = directed ? orientLightPath(index, roots, { maxNodes }) : null;

  // Light before the failure, and light after it. A node is dark when it was
  // reachable before and is not reachable now — no node is dark merely because
  // something broke nearby. Both are full graph walks, so a node with a second
  // path to the root stays lit (a ring, a core patched twice at one box).
  const intactKeys = directed ? reachableKeys(index, roots) : null;
  const litKeys = directed
    ? reachableKeys(index, roots, { failureBoxIds, failureCableIds, rootBoxIds: rootBoxSet })
    : null;

  // Only *lit* cores matter here: a spare 'available' core that reaches nothing
  // is normal (that is what spares are), but a spliced/terminated core that
  // cannot trace back to the OLT is a documentation gap worth surfacing.
  const unreachedCoreIds = directed
    ? index.cores
        .filter((core) => core.status !== 'available')
        .filter((core) => !intactKeys.has(coreKey(core.id)))
        .map((core) => core.id)
    : [];

  const surface = failureSurfaceSeeds(index, { failureBoxIds, failureCableIds });
  const rootedSeeds = directed
    ? surface.seedKeys.filter((seed) => intactKeys.has(seed))
    : [];
  const unrootedSeeds = directed
    ? surface.seedKeys.filter((seed) => !intactKeys.has(seed))
    : [];

  /** The dark set, in walk order, with anything the walk missed appended. */
  function darkKeys() {
    const keys = [];
    const seen = new Set();
    for (const key of [...flood.keys, ...intactKeys]) {
      if (seen.has(key) || litKeys.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
    return keys;
  }

  // A public failure is a box failure, not a cable cut. If the root cannot
  // reach the failure surface, recover only the connected output side — never
  // by flooding back through the IN cable. The old undirected fallback remains
  // for lower-level cable/pole surface analysis, where the caller explicitly
  // supplied a cut and that fallback is part of the graph API.
  const boxFailureOnly = failureBoxIds.size > 0 && failureCableIds.size === 0;
  const boxOutputFlood = boxFailureOnly
    ? floodBoxDownstream(index, surface.seedKeys, failureBoxIds, { maxNodes })
    : null;
  const unrootedFlood = directed
    ? boxFailureOnly
      ? boxOutputFlood?.keys.length
        ? boxOutputFlood
        : null
      : unrootedSeeds.length
        ? floodUndirected(index, unrootedSeeds, { maxNodes })
        : null
    : null;

  const flood = directed
    ? mergeFloods([
        rootedSeeds.length
          ? floodDownstream(index, orientation, rootedSeeds, { maxNodes })
          : null,
        unrootedFlood,
      ].filter(Boolean))
    : boxFailureOnly && boxOutputFlood?.keys.length
      ? boxOutputFlood
      : floodUndirected(index, surface.seedKeys, { maxNodes });

  // What the outage took out. Directed: everything that had light and no longer
  // does — the walk's own keys (which carry the paths, and cover a failure point
  // that was not connected to the root in the first place) plus whatever else
  // lost its light but the walk never entered (a node light reached by a second
  // path the tree does not contain). A fibre that still has light is never in
  // there. Undirected (no root): everything the walk through the failure reaches,
  // both ways, which is the documented over-approximation.
  const reportKeys = directed ? darkKeys() : flood.keys;

  // A seed that cannot trace back to the root is only worth warning about when
  // it actually carries something: a spare core sitting in the failed cable
  // reaches nothing, and saying "1 element is unrooted" about it is noise.
  const unrootedParents = unrootedFlood
    ? new Set([...unrootedFlood.parents.values()].map((parent) => parent.node))
    : new Set();
  const strayUnrootedSeeds = unrootedFlood
    ? unrootedSeeds.filter((seed) => {
        if (unrootedParents.has(seed)) return true; // other fibers hang off it
        const core = index.coreById.get(keyId(seed));
        return core ? Boolean(servedCustomer(index, core)) : false;
      })
    : [];

  // Either walk being capped means the answer is incomplete, and a silently
  // incomplete outage report is worse than a slow one.
  if (flood.truncated || orientation?.truncated) {
    warnings.push(
      `The network or the affected area is larger than ${maxNodes} nodes and the walk was ` +
        'truncated — the customer list may be incomplete.',
    );
  }
  if (!surface.seedKeys.length) {
    warnings.push(
      'No fibers are documented at this failure point, so nothing could be traced from it.',
    );
  }
  if (!directed) {
    warnings.push(
      boxFailureOnly && boxOutputFlood?.keys.length
        ? 'No network root (headend/OLT) is configured. The report uses the box and cable endpoints ' +
          'to follow connected output fibres only; the IN cable is not included. Set a headend root ' +
          'on the OLT box to validate light reachability.'
        : 'No network root (headend/OLT) is configured, so direction could not be resolved: the ' +
          'report walks both ways from the failure point. It may include the span that feeds the ' +
          'failure (which still has light on it) and branches that are still lit, and it may paint ' +
          'them red — set a headend root on the OLT box for direction-aware results.',
    );
  } else {
    if (strayUnrootedSeeds.length) {
      const count = strayUnrootedSeeds.length;
      warnings.push(
        `${count} element${count === 1 ? '' : 's'} at the failure point ` +
          `${count === 1 ? 'is' : 'are'} not connected to a configured network root — ` +
          `${count === 1 ? 'it was' : 'they were'} reported without direction and may over-report.`,
      );
    }
    if (unreachedCoreIds.length) {
      warnings.push(
        `${unreachedCoreIds.length} spliced/terminated core${unreachedCoreIds.length === 1 ? ' is' : 's are'} ` +
          'not reachable from the network root — check for unspliced segments, a root set on the ' +
          'wrong box, or a mid-span closure whose two cable halves the app could not pair up ' +
          '(downstream "<upstream code>-B", same box, same type and core count).',
      );

      // If the gap has a shape we recognise — a downstream cable named
      // `<upstream>-B` starting where that cable ends — name the pair. The links
      // are already inferred from that naming rule before the walk, so a pair
      // reaching here failed the geometric half of it: the two split points are
      // more than 25 m apart, and only a human can say they are really one fiber.
      const candidates = unlinkedSplitCandidates(index, unreachedCoreIds);
      if (candidates.length) {
        const named = candidates
          .slice(0, 3)
          .map((pair) => `${pair.child_code} ← ${pair.parent_code}`)
          .join(', ');
        const more = candidates.length > 3 ? ` (+${candidates.length - 3} more)` : '';
        warnings.push(
          `${candidates.length} mid-span split${candidates.length === 1 ? ' looks' : 's look'} ` +
            `like one fiber but ${candidates.length === 1 ? 'does' : 'do'} not line up: ${named}${more}. If the halves are really the same ` +
            'fiber, link one by hand — "npm run db:link-splits" in backend/ lists the ' +
            'candidates it can confirm, and --child CODE --parent CODE links a pair outright.',
        );
      }
    }
  }

  const affectedBoxes = new Map();
  const addBox = (boxId, extra = {}) => {
    if (!boxId) return;
    const box = index.boxById.get(boxId);
    const existing = affectedBoxes.get(boxId);
    const entry = {
      id: boxId,
      code: box?.code ?? null,
      name: box?.name ?? null,
      type: box?.type ?? null,
      is_failure: failureBoxIds.has(boxId),
      ...extra,
    };
    affectedBoxes.set(boxId, existing ? { ...existing, ...entry } : entry);
  };
  for (const boxId of failureBoxIds) addBox(boxId, { is_failure: true });

  const affectedCables = new Map();
  const addCable = (cableId, extra = {}) => {
    if (!cableId) return;
    const cable = index.cableById.get(cableId);
    const existing = affectedCables.get(cableId);
    const entry = {
      id: cableId,
      code: cable?.code ?? null,
      cable_type: cable?.cable_type ?? null,
      is_failure: failureCableIds.has(cableId),
      // Which half this cable continues, and the closure they meet in — the
      // reason a red chain steps across a box that is not a splice. Recorded in
      // the database when it has the column, inferred from cable naming when it
      // does not (the service marks which, see impactAnalysis.js).
      ...cableContinuationFields(index, cable),
      ...extra,
    };
    affectedCables.set(cableId, existing ? { ...existing, ...entry } : entry);
  };
  for (const cableId of failureCableIds) addCable(cableId, { is_failure: true });

  const affectedCoreIds = [];
  const customersByKey = new Map();
  let customerOverflow = false;

  // How much of each cable is actually out. A cable is one physical span but
  // many fibres, and an outage that darkens 1 of its 12 cores must not read the
  // same as a span that is gone: `partially_dark` is what the map styles
  // differently and what the panel counts separately.
  //
  // Both numbers are counted in *light*, and the evidence for light is the same
  // evidence the rest of this file uses. With a headend configured it is a fact —
  // light reached the fibre from the root — and a joint is only how it got there.
  // Without one there is nothing to trace, so a recorded joint (a splice, a
  // splitter's input, a port's output) is the evidence instead. What is never
  // evidence is a status column on a strand nothing joins: an import leftover or
  // a hand-edited row. Counting those as working fibres is what drew the span
  // hanging off a failed box's splitter port as "1 of 3 out" — a faint, dashed
  // line — while every fibre on that span that had light was dark, which is not
  // what the technician sent to the fault reads.
  const carriesLight = (core) =>
    directed ? intactKeys.has(coreKey(core.id)) : index.joinedCoreIds.has(core.id);
  const inServiceByCable = new Map();
  for (const core of index.cores) {
    if (core.cable_id && inPlant(index, core) && carriesLight(core)) {
      inServiceByCable.set(core.cable_id, (inServiceByCable.get(core.cable_id) || 0) + 1);
    }
  }
  const darkCoresByCable = new Map();

  for (const key of reportKeys) {
    if (keyKind(key) === 'core') {
      const core = index.coreById.get(keyId(key));
      if (!core) continue;
      // Spares carry no light, so they can neither go dark nor paint a cable:
      // an unused strand on the cable that *feeds* a failed box is not an
      // outage, and counting it painted the upstream span red.
      if (inPlant(index, core)) {
        affectedCoreIds.push(core.id);
        // Only a fibre that carried light can have lost it — see carriesLight.
        if (core.cable_id && carriesLight(core)) {
          darkCoresByCable.set(core.cable_id, (darkCoresByCable.get(core.cable_id) || 0) + 1);
        }
      }
      const cable = index.cableById.get(core.cable_id);
      if (cable && (inPlant(index, core) || failureCableIds.has(cable.id))) {
        addCable(cable.id, { is_failure: failureCableIds.has(cable.id) });
      }
      // A box goes dark when a joint inside it is dead, so the boxes that host
      // traversed joints are painted — and only those. The box at the *live*
      // end of a cut cable is deliberately left alone: it still has light.
      const parentVia = flood.parents.get(key);
      if (parentVia?.via?.box_id) addBox(parentVia.via.box_id);

      const customer = servedCustomer(index, core);
      if (customer && !customersByKey.has(customer.key)) {
        if (customersByKey.size >= maxCustomers) customerOverflow = true;
        else {
          // The flood's own parent chain is the path through the failure; the
          // orientation is only consulted to show how a seed (a core sitting on
          // the failed element itself) attaches to it.
          const path = buildPath(index, flood.parents, key, { orientation, failureBoxIds });
          const box = servingBox(index, core);
          if (box?.id) addBox(box.id);
          const patch = patchPointForPath(index, path, failureBoxIds, box?.id ?? null);
          customersByKey.set(customer.key, {
            ...customer,
            serving_box_id: box?.id ?? null,
            serving_box_code: box?.code ?? null,
            hops: flood.depths.get(key) ?? 0,
            patch_box_id: patch.box_id,
            patch_box_code: patch.box_code,
            path_through_failure: path,
          });
        }
      }
    } else {
      const splitter = index.splitterById.get(keyId(key));
      if (splitter?.enclosure_id) addBox(splitter.enclosure_id);
    }
  }

  if (customerOverflow) {
    warnings.push(
      `More than ${maxCustomers} customers are affected — the list was truncated.`,
    );
  }

  // Every affected cable carries how much of it is out; a cut span is out in
  // full whatever its strand count, so `is_failure` wins over the arithmetic.
  for (const [cableId, entry] of affectedCables) {
    const inServiceCount = inServiceByCable.get(cableId) || 0;
    const darkCount = darkCoresByCable.get(cableId) || 0;
    affectedCables.set(cableId, {
      ...entry,
      cores_dark: darkCount,
      cores_in_service: inServiceCount,
      partially_dark: !entry.is_failure && darkCount > 0 && darkCount < inServiceCount,
    });
  }

  const affectedCustomers = [...customersByKey.values()].sort(
    (a, b) => a.hops - b.hops || String(a.customer_label).localeCompare(String(b.customer_label)),
  );

  return {
    direction: directed ? 'directed' : 'undirected',
    directed,
    root_core_ids: roots.map(keyId),
    warnings,
    surface: {
      box_ids: [...failureBoxIds],
      cable_ids: [...failureCableIds],
      seed_core_ids: surface.seedCoreIds,
      seed_splitter_ids: surface.seedSplitterIds,
      entry_count: surface.seedKeys.length,
    },
    unreached: {
      core_ids: unreachedCoreIds.slice(0, 50),
      core_count: unreachedCoreIds.length,
    },
    affected: {
      core_ids: uniq(affectedCoreIds),
      core_count: uniq(affectedCoreIds).length,
      boxes: [...affectedBoxes.values()].sort(
        (a, b) => Number(b.is_failure) - Number(a.is_failure) || String(a.code).localeCompare(String(b.code)),
      ),
      cables: [...affectedCables.values()].sort(
        (a, b) => Number(b.is_failure) - Number(a.is_failure) || String(a.code).localeCompare(String(b.code)),
      ),
      customers: affectedCustomers,
      customer_count: affectedCustomers.length,
      unnamed_count: affectedCustomers.filter((c) => c.unnamed).length,
      partial_cable_count: [...affectedCables.values()].filter((c) => c.partially_dark).length,
      truncated: flood.truncated || customerOverflow || Boolean(orientation?.truncated),
    },
  };
}

/**
 * Where would light have to be re-injected to bring this customer back?
 *
 * Walking from the failure toward the customer:
 *   1. the first joint that is NOT part of the failure — an intact box where a
 *      patch can be spliced in;
 *   2. otherwise the box serving the customer (a cut drop is re-spliced at the
 *      NAP it leaves from);
 *   3. otherwise the first intact cable end on the customer's side;
 *   4. otherwise the failure box itself — the case where the customer hangs
 *      directly off the failed box, so it has to be rebuilt.
 */
function patchPointForPath(index, path, failureBoxIds, servingBoxId = null) {
  const box = (boxId) =>
    boxId ? { box_id: boxId, box_code: index.boxById.get(boxId)?.code ?? null } : null;
  const intact = (boxId) => boxId && !failureBoxIds.has(boxId);

  for (const item of path) {
    if (item.kind === 'fiber') continue;
    if (intact(item.box_id)) return box(item.box_id);
  }
  if (intact(servingBoxId)) return box(servingBoxId);

  // The customer's own segment (the last fiber on the path) is where a cut
  // drop gets re-spliced — not the upstream segments the light passed through.
  const customerFiber = [...path].reverse().find((item) => item.kind === 'fiber');
  if (customerFiber) {
    const candidate = [customerFiber.box_from_id, customerFiber.box_to_id].find(intact);
    if (candidate) return box(candidate);
  }

  const fallback =
    path.find((item) => item.box_id)?.box_id ??
    path.flatMap((item) => [item.box_from_id, item.box_to_id]).find(Boolean) ??
    null;
  return box(fallback);
}

// --- restoration planning -------------------------------------------------------

/**
 * Group affected customers by the box light would be re-injected at, and pair
 * each group with the nearest source box found by the capacity BFS (the same
 * hop-by-hop search used by requirement #7). Pure: the caller supplies the BFS
 * results, `sourcesByPatchBox[patchBoxId]`.
 *
 *   { found: true,  source_box_id, source_box_code, available_cores, hops, path }
 *   { found: false, nearest: { box_id, box_code, distance_m } }   // no intact path
 */
function groupRestorationCandidates(customers = [], sourcesByPatchBox = {}) {
  const groups = new Map();
  for (const customer of customers) {
    if (!customer?.patch_box_id) continue;
    const group = groups.get(customer.patch_box_id) || {
      patch_box_id: customer.patch_box_id,
      patch_box_code: customer.patch_box_code ?? null,
      customers: [],
    };
    group.customers.push(customer);
    groups.set(customer.patch_box_id, group);
  }

  const candidates = [];
  for (const [patchBoxId, group] of groups) {
    const source = sourcesByPatchBox[patchBoxId] || {};
    const found = source.found === true;
    const nearest = source.nearest || null;
    candidates.push({
      patch_box_id: patchBoxId,
      patch_box_code: group.patch_box_code,
      source_box_id: found ? source.source_box_id : null,
      source_box_code: found ? source.source_box_code ?? null : null,
      available_cores: found ? source.available_cores ?? 0 : null,
      hops: found ? source.hops ?? 0 : null,
      path: found ? source.path || [] : [],
      viability: found ? 'cabled' : nearest ? 'new_span' : 'unknown',
      approx_distance_m: !found && nearest ? nearest.distance_m ?? null : null,
      // When there is no cable path, the nearest lit box is still the place a
      // new span would come from — name it, the suggestion is useless without.
      nearest_source_box_id: !found && nearest ? nearest.box_id ?? null : null,
      nearest_source_box_code: !found && nearest ? nearest.box_code ?? null : null,
      restorable_count: group.customers.length,
      restorable_customers: group.customers.slice(0, MAX_RESTORABLE_LISTED).map((c) => ({
        customer_label: c.customer_label,
        customer_id: c.customer_id ?? null,
        customer_name: c.customer_name ?? null,
        // How the customer was identified, so the UI can name an unlabelled leg.
        source: c.source ?? null,
        core_id: c.core_id,
        cable_code: c.cable_code ?? null,
        serving_box_code: c.serving_box_code ?? null,
      })),
    });
  }

  candidates.sort(
    (a, b) =>
      b.restorable_count - a.restorable_count ||
      (a.hops ?? 99) - (b.hops ?? 99) ||
      (a.approx_distance_m ?? 1e9) - (b.approx_distance_m ?? 1e9),
  );
  return candidates;
}

// --- geo helper (distance fallback for the restoration plan) ---------------------

/** Great-circle distance in metres — used when no intact cable path exists. */
function haversineMeters(a, b) {
  if (!a || !b || a.lat == null || a.lng == null || b.lat == null || b.lng == null) {
    return null;
  }
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(h))));
}

module.exports = {
  DEFAULT_MAX_NODES,
  DEFAULT_MAX_CUSTOMERS,
  coreKey,
  splitterKey,
  keyKind,
  keyId,
  indexNetwork,
  inferSourceBoxes,
  rootCoreIdsForBoxes,
  lightEdges,
  reachableKeys,
  orientLightPath,
  floodDownstream,
  floodUndirected,
  mergeFloods,
  failureSurfaceSeeds,
  analyzeImpact,
  buildPath,
  patchPointForPath,
  servedCustomer,
  groupRestorationCandidates,
  haversineMeters,
};
