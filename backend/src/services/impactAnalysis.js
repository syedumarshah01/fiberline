const db = require('../db');
const { buildGraph, getAvailableCoreCounts } = require('./capacityGraph');
const {
  analyzeImpact,
  groupRestorationCandidates,
  haversineMeters,
} = require('../utils/impactGraph');

/**
 * Impact / outage analysis, database side.
 *
 * Loads the segment, resolves the network root (headend) that gives the graph
 * its upstream direction, runs the pure analysis in utils/impactGraph.js and
 * then plans restoration: for every box where light would have to be
 * re-injected, search outward for the nearest box that still has light AND
 * spare cores — the same hop-by-hop BFS as requirement #7 (capacityGraph), but
 * skipping boxes that are dark, because you cannot patch light through a dead
 * splice.
 */

const ENCLOSURE_FIELDS = ['id', 'code', 'name', 'type', 'pole_id'];
const CABLE_FIELDS = [
  'id', 'code', 'name', 'cable_type',
  'from_enclosure_id', 'to_enclosure_id',
  'customer_id', 'customer_label',
  // Mid-span splits: the downstream half of an inserted closure points at its
  // parent cable, which is how the graph knows the fiber continues there.
  'continues_cable_id',
];

async function loadNetwork() {
  const [enclosures, cables, cores, splices, splitters, ports, headends, customers] =
    await Promise.all([
      db('enclosures').select(...ENCLOSURE_FIELDS),
      db('cables').select(...CABLE_FIELDS),
      db('fiber_cores').select('id', 'cable_id', 'core_number', 'status'),
      db('splices').select('id', 'enclosure_id', 'core_a_id', 'core_b_id', 'splice_type'),
      db('splitters').select('id', 'enclosure_id', 'name', 'input_core_id', 'split_count'),
      db('splitter_ports').select(
        'id', 'splitter_id', 'port_number', 'output_core_id', 'output_splitter_id',
      ),
      db('headends').select('id', 'code', 'name', 'site_type', 'root_enclosure_id'),
      db('customers').select('id', 'customer_code', 'name'),
    ]);
  return { enclosures, cables, cores, splices, splitters, ports, headends, customers };
}

/**
 * The root cores: every core of a cable landing at a headend's root box. Light
 * enters those two ways — it is fed from the OLT there, or it is the far end of
 * an incoming feeder. Either way, everything reachable from them is downstream.
 */
function resolveRoots({ headends, enclosures, cables, cores }) {
  const boxIds = new Set(enclosures.map((e) => e.id));
  const rooted = headends.filter((h) => h.root_enclosure_id && boxIds.has(h.root_enclosure_id));
  const rootBoxIds = new Set(rooted.map((h) => h.root_enclosure_id));

  const cableById = new Map(cables.map((c) => [c.id, c]));
  const rootCoreIds = [];
  for (const core of cores) {
    const cable = cableById.get(core.cable_id);
    if (!cable) continue;
    if (rootBoxIds.has(cable.from_enclosure_id) || rootBoxIds.has(cable.to_enclosure_id)) {
      rootCoreIds.push(core.id);
    }
  }

  return { rooted, rootBoxIds: [...rootBoxIds], rootCoreIds };
}

// --- restoration planning --------------------------------------------------------

function bfsNearestSource(startBoxId, { adjacency, capacity, live, darkBoxIds }) {
  // The box we would re-inject at is itself dark; every other dark box is
  // impassable (its splices are gone, so no light can be patched through it).
  const isSource = (id) => live.has(id) && (capacity[id] || 0) > 0;

  if (isSource(startBoxId)) {
    return {
      found: true,
      source_box_id: startBoxId,
      available_cores: capacity[startBoxId] || 0,
      hops: 0,
      path: [],
      same_box: true,
    };
  }

  const visited = new Set([startBoxId]);
  const queue = [{ id: startBoxId, path: [] }];

  while (queue.length) {
    const { id, path } = queue.shift();
    for (const edge of adjacency[id] || []) {
      if (visited.has(edge.neighbor)) continue;
      if (darkBoxIds.has(edge.neighbor)) continue;
      visited.add(edge.neighbor);

      const step = {
        cable_id: edge.cableId,
        cable_code: edge.cableCode,
        length_m: edge.lengthM,
        to_enclosure_id: edge.neighbor,
      };
      const nextPath = [...path, step];

      if (isSource(edge.neighbor)) {
        return {
          found: true,
          source_box_id: edge.neighbor,
          available_cores: capacity[edge.neighbor] || 0,
          hops: nextPath.length,
          path: nextPath,
          same_box: false,
        };
      }
      queue.push({ id: edge.neighbor, path: nextPath });
    }
  }

  return { found: false };
}

/** No intact cable path: fall back to the nearest live box with spare cores. */
function nearestLiveSource(patchBoxId, { live, capacity, boxLocations }) {
  const here = boxLocations?.[patchBoxId];
  if (!here) return null;

  let best = null;
  for (const boxId of live) {
    if ((capacity[boxId] || 0) <= 0) continue;
    const distance = haversineMeters(here, boxLocations?.[boxId]);
    if (distance == null) continue;
    if (!best || distance < best.distance_m) {
      best = { box_id: boxId, available_cores: capacity[boxId] || 0, distance_m: distance };
    }
  }
  return best;
}

async function planRestoration({ analysis, rootBoxIds, boxLocations = null, boxCodes = null }) {
  const customers = analysis.affected.customers;
  if (!analysis.directed || !customers.length) {
    return { candidates: [], source_box_ids: [], patch_box_ids: [] };
  }

  const darkBoxIds = new Set(analysis.affected.boxes.map((b) => b.id));
  const [adjacency, capacity] = await Promise.all([buildGraph(), getAvailableCoreCounts()]);

  // Boxes that still have light: reachable from any segment root without
  // crossing a dark box.
  const live = new Set();
  const queue = [...rootBoxIds];
  for (const boxId of queue) live.add(boxId);
  while (queue.length) {
    const id = queue.shift();
    for (const edge of adjacency[id] || []) {
      if (live.has(edge.neighbor) || darkBoxIds.has(edge.neighbor)) continue;
      live.add(edge.neighbor);
      queue.push(edge.neighbor);
    }
  }

  const codeOf = (boxId) => (boxCodes?.get(boxId) ?? null);

  const patchBoxIds = [...new Set(customers.map((c) => c.patch_box_id).filter(Boolean))];
  const sourcesByPatchBox = {};
  for (const patchBoxId of patchBoxIds) {
    const found = bfsNearestSource(patchBoxId, { adjacency, capacity, live, darkBoxIds });
    if (found.found || !boxLocations) {
      sourcesByPatchBox[patchBoxId] = found.found
        ? { ...found, source_box_code: codeOf(found.source_box_id) }
        : found;
      continue;
    }
    const nearest = nearestLiveSource(patchBoxId, { live, capacity, boxLocations });
    sourcesByPatchBox[patchBoxId] = nearest
      ? {
          found: false,
          nearest: {
            box_id: nearest.box_id,
            box_code: codeOf(nearest.box_id),
            available_cores: nearest.available_cores,
            distance_m: nearest.distance_m,
          },
        }
      : { found: false };
  }

  const candidates = groupRestorationCandidates(customers, sourcesByPatchBox);
  return {
    candidates,
    source_box_ids: [...new Set(candidates.map((c) => c.source_box_id).filter(Boolean))],
    patch_box_ids: patchBoxIds,
  };
}

// --- entry point -------------------------------------------------------------------

function describeFailure({ kind, id, boxIds, cableIds, element, network }) {
  let label = element?.code || element?.name || null;
  if (!label && kind === 'box') label = network.enclosures.find((e) => e.id === id)?.code ?? null;
  if (!label && kind === 'cable') label = network.cables.find((c) => c.id === id)?.code ?? null;
  return {
    kind,
    id,
    label,
    name: element?.name ?? null,
    box_ids: [...new Set(boxIds.filter(Boolean))],
    cable_ids: [...new Set(cableIds.filter(Boolean))],
  };
}

/**
 * @param {object} params
 * @param {'box'|'pole'|'cable'} params.kind  what failed
 * @param {string} params.id                  the failed element's id
 * @param {string[]} [params.boxIds]          boxes at the failure (pole → several)
 * @param {string[]} [params.cableIds]        cables at the failure (pole → nearby spans)
 * @param {object}   [params.element]         { code, name } for the response's label
 * @param {object}   [params.boxLocations]    id → { lat, lng }, for the no-path fallback
 */
async function simulateFailure({
  kind,
  id,
  boxIds = [],
  cableIds = [],
  element = null,
  boxLocations = null,
  maxCustomers,
} = {}) {
  const network = await loadNetwork();
  const { rooted, rootBoxIds, rootCoreIds } = resolveRoots(network);

  const analysis = analyzeImpact({
    ...network,
    boxIds,
    cableIds,
    rootCoreIds,
    maxCustomers,
  });

  const restoration = await planRestoration({
    analysis,
    rootBoxIds,
    boxLocations,
    boxCodes: new Map(network.enclosures.map((e) => [e.id, e.code])),
  });

  // "No root configured" is the wrong diagnosis when every headend row is
  // simply not wired to a box yet.
  let warnings = analysis.warnings;
  if (network.headends.length && !rooted.length) {
    warnings = warnings
      .filter((w) => !/network root .*is configured/i.test(w))
      .concat(
        `${network.headends.length} headend record${network.headends.length === 1 ? '' : 's'} ` +
          'exist but none point at an existing enclosure — set headends.root_enclosure_id ' +
          'so the analysis knows which way is downstream.',
      );
  }

  const primaryHeadend = rooted.length === 1 ? rooted[0] : null;
  const rootBox = primaryHeadend
    ? network.enclosures.find((e) => e.id === primaryHeadend.root_enclosure_id) || null
    : null;

  return {
    failure: describeFailure({ kind, id, boxIds, cableIds, element, network }),
    direction_resolved: analysis.directed,
    headend: primaryHeadend
      ? {
          id: primaryHeadend.id,
          code: primaryHeadend.code,
          name: primaryHeadend.name ?? null,
          site_type: primaryHeadend.site_type ?? null,
          root_enclosure_id: primaryHeadend.root_enclosure_id,
          root_enclosure_code: rootBox?.code ?? null,
        }
      : null,
    headend_count: rooted.length,
    surface: analysis.surface,
    affected_count: analysis.affected.customer_count,
    affected: analysis.affected,
    upstream_reroute_candidates: restoration.candidates,
    restoration: {
      source_box_ids: restoration.source_box_ids,
      patch_box_ids: restoration.patch_box_ids,
      options: restoration.candidates.filter((c) => c.source_box_id || c.approx_distance_m).length,
    },
    unreached: analysis.unreached,
    warnings,
    summary: {
      affected_customers: analysis.affected.customer_count,
      unnamed_terminations: analysis.affected.unnamed_count,
      affected_boxes: analysis.affected.boxes.length,
      affected_cables: analysis.affected.cables.length,
      affected_cores: analysis.affected.core_count,
      restoration_options: restoration.candidates.length,
    },
  };
}

module.exports = {
  loadNetwork,
  resolveRoots,
  bfsNearestSource,
  nearestLiveSource,
  planRestoration,
  simulateFailure,
};
