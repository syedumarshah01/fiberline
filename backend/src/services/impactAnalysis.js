const db = require('../db');
const { buildGraph, getAvailableCoreCounts } = require('./capacityGraph');
const { migrationHint, isMissingColumnError } = require('../utils/schemaHint');
const { schemaCapabilities } = require('../utils/schemaCapabilities');
const { loadContinuationLinks } = require('../utils/continuationLinks');
const {
  analyzeImpact,
  groupRestorationCandidates,
  haversineMeters,
  inferSourceBoxes,
  rootCoreIdsForBoxes,
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
  // A database that has not run migration 14 still gets a working failure
  // simulation: the column is left out of the SELECT and the mid-span links are
  // inferred from cable naming instead (utils/continuationLinks.js), so a
  // closure inserted mid-span is walked across either way.
  const capabilities = await schemaCapabilities();

  if (capabilities.has_cables === false) {
    // Nothing to analyse: the database has no schema at all. Saying so beats
    // letting `relation "cables" does not exist` reach the panel.
    const err = new Error(capabilities.gaps[0].message);
    err.status = 503;
    throw err;
  }

  const cableFields = capabilities.columns.continues_cable_id
    ? CABLE_FIELDS
    : CABLE_FIELDS.filter((field) => field !== 'continues_cable_id');

  /**
   * Load the network and decorate it with the mid-span links, for a given
   * answer about the schema. Separate from the try/catch below because a stale
   * answer gets one retry with the column left out (no migration required).
   */
  async function analyse(withCapabilities, withFields) {
    const rows = await loadNetworkRows(withFields);
    const links = await loadContinuationLinks({
      capabilities: withCapabilities,
      cables: rows.cables,
    });

    // Hand the graph the links in the shape it already understands. Whether they
    // were recorded or inferred is reported separately, not hidden.
    const cables = links.inferred
      ? rows.cables.map((cable) =>
          links.childToParent.has(cable.id)
            ? { ...cable, continues_cable_id: links.childToParent.get(cable.id) }
            : cable,
        )
      : rows.cables;

    const schemaWarnings = withCapabilities.gaps
      .filter((gap) => gap.severity !== 'notice')
      .map((gap) => gap.message);
    if (links.inferred && links.childToParent.size) {
      schemaWarnings.push(
        `${links.childToParent.size} mid-span cable link${links.childToParent.size === 1 ? '' : 's'} ` +
          'inferred from cable naming (a downstream cable named "<upstream code>-B" starting ' +
          'where the upstream one ends) — the results below already include them. To record ' +
          'them so the report says so too, run "npm run db:schema" in backend/: it names the ' +
          'step for this database.',
      );
    }

    return { ...rows, cables, links, schema_warnings: schemaWarnings };
  }

  try {
    return await analyse(capabilities, cableFields);
  } catch (err) {
    // The probe said the column exists but a read just failed on it — a stale
    // cached answer (it is cached per process) or a column dropped between the
    // two queries. Re-ask, and if the column really is absent, do exactly what
    // the app does on a database that never had it: leave it out of the SELECT
    // and infer the mid-span links. No migration required either way.
    if (isMissingColumnError(err, 'continues_cable_id')) {
      const refreshed = await schemaCapabilities({ refresh: true });
      if (!refreshed.columns.continues_cable_id) {
        return analyse(
          refreshed,
          CABLE_FIELDS.filter((field) => field !== 'continues_cable_id'),
        );
      }
    }
    // Otherwise the database really does claim the column and the read still
    // fails: say what to do rather than leaking Postgres' 42703.
    throw migrationHint(err, {
      column: 'continues_cable_id',
      migration: 'migration 20260101000014_cable_continuations.js',
      feature: 'Failure simulation',
    });
  }
}

async function loadNetworkRows(cableFields = CABLE_FIELDS) {
  const [enclosures, cables, cores, splices, splitters, ports, headends, customers] =
    await Promise.all([
      db('enclosures').select(...ENCLOSURE_FIELDS),
      db('cables').select(...cableFields),
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
 * Where the light enters the network — the input that gives the graph a top.
 *
 * A `headends` row is the answer whenever one points at a real box: a person
 * said so, and the analysis says so back. The fallback matters more than it
 * looks. Without a root the walk goes both ways from the failure, and the span
 * that *feeds* the failed box comes back painted red even though it still has
 * light on it — a map that sends a technician to the wrong cable. So when no
 * headend is rooted, the shape of the network is asked instead
 * (utils/impactGraph.inferSourceBoxes): the boxes no cable feeds are where light
 * can enter.
 *
 * The result is labelled either way (`direction_source`), because an inferred
 * direction is an assumption the reader is entitled to see — and to overrule by
 * pointing a headend at the right box.
 */
function resolveRoots({ headends, enclosures, cables, cores }) {
  const boxIds = new Set(enclosures.map((e) => e.id));
  const rooted = headends.filter((h) => h.root_enclosure_id && boxIds.has(h.root_enclosure_id));

  if (rooted.length) {
    const rootBoxIds = [...new Set(rooted.map((h) => h.root_enclosure_id))];
    return {
      rooted,
      inferred: [],
      rootBoxIds,
      rootCoreIds: rootCoreIdsForBoxes({ cables, cores }, rootBoxIds),
      source: 'headend',
    };
  }

  const inferred = inferSourceBoxes({ enclosures, cables });
  const inferredBoxIds = inferred.map((box) => box.id);
  return {
    rooted,
    inferred,
    rootBoxIds: inferredBoxIds,
    rootCoreIds: rootCoreIdsForBoxes({ cables, cores }, inferredBoxIds),
    source: inferred.length ? 'inferred' : 'none',
  };
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
 * @param {'box'} params.kind                 what failed — public simulation is box-only
 * @param {string} params.id                  the failed box's id
 * @param {string[]} [params.boxIds]          the failed box (one id)
 * @param {string[]} [params.cableIds]        empty for public box failures
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
  if (kind !== 'box') {
    const error = new Error('Failure simulation supports boxes only');
    error.statusCode = 400;
    throw error;
  }

  const network = await loadNetwork();
  const { rooted, inferred, rootBoxIds, rootCoreIds, source: directionSource } = resolveRoots(network);

  const analysis = analyzeImpact({
    ...network,
    boxIds,
    cableIds,
    rootCoreIds,
    // Where the light is injected: failing the headend's own box kills the
    // source, failing any other box is a cut (see utils/impactGraph.js).
    rootBoxIds,
    maxCustomers,
  });

  // Say which kind of link each affected cable's continuation is: recorded in
  // the database, or inferred from the naming rule (utils/continuationLinks.js).
  // A red chain that steps across a box is only trustworthy if the reader can
  // see how the app knew the two halves are one fibre.
  for (const cable of analysis.affected.cables) {
    if (cable.continues_cable_id || cable.continued_by?.length) {
      cable.continuation_inferred = Boolean(network.links?.inferred);
    }
  }

  const restoration = await planRestoration({
    analysis,
    rootBoxIds,
    boxLocations,
    boxCodes: new Map(network.enclosures.map((e) => [e.id, e.code])),
  });

  // The direction the analysis actually used, and how it knows. A source box
  // without any documented cores is only a suggestion, not a usable light root,
  // so do not label an undirected walk as inferred.
  const inferredBoxes = inferred.map((box) => ({ id: box.id, code: box.code }));
  const effectiveDirectionSource = analysis.directed ? directionSource : 'none';

  let warnings = [...(network.schema_warnings || []), ...analysis.warnings];

  if (effectiveDirectionSource === 'inferred') {
    // Say what was assumed, and how to make it a fact — an inferred direction is
    // almost always right for a distribution network, but the reader is the only
    // one who can confirm it.
    const names = inferredBoxes.map((box) => box.code || box.id.slice(0, 8)).join(', ');
    warnings.push(
      'No headend is configured, so the direction was inferred from the network shape: ' +
        `light is assumed to enter at ${names} (no cable feeds ${inferredBoxes.length === 1 ? 'it' : 'them'}). ` +
        'Everything downstream of the failure is reported and the span that feeds it is left alone. ' +
        'Set a headend on the OLT box to make this explicit.',
    );
  } else if (effectiveDirectionSource === 'none') {
    warnings.push(
      'No headend is configured and the network shape does not say where the light enters ' +
        '(every box has a cable arriving at it, or the boxes nothing feeds only hand out drops), ' +
        'so the walk goes both ways from the failure and may include the span that feeds it. ' +
        'Set a headend on the OLT box for direction-aware results.',
    );
  }

  // "No root configured" is the wrong diagnosis when every headend row is
  // simply not wired to a box yet.
  if (network.headends.length && !rooted.length) {
    const inferredHint = inferredBoxes.length
      ? ' The shape of the network suggests ' +
        inferredBoxes.map((box) => box.code || box.id.slice(0, 8)).join(', ') +
        ' — point the headend there if that is the OLT.'
      : '';
    warnings = warnings
      .filter((w) => !/network root .*is configured/i.test(w))
      .concat(
        `${network.headends.length} headend record${network.headends.length === 1 ? '' : 's'} ` +
          'exist but none point at an existing enclosure — set headends.root_enclosure_id ' +
          `so the analysis knows which way is downstream.${inferredHint}`,
      );
  }

  const primaryHeadend = rooted.length === 1 ? rooted[0] : null;
  const rootBox = primaryHeadend
    ? network.enclosures.find((e) => e.id === primaryHeadend.root_enclosure_id) || null
    : null;

  return {
    failure: describeFailure({ kind, id, boxIds, cableIds, element, network }),
    direction_resolved: analysis.directed,
    // 'headend' — a person said where the light enters; 'inferred' — the shape of
    // the network said it (no cable feeds that box); 'none' — nobody said and the
    // shape does not, so the walk is undirected and the warnings say so.
    direction_source: effectiveDirectionSource,
    inferred_root_boxes: effectiveDirectionSource === 'inferred' ? inferredBoxes : [],
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
      partially_dark_cables: analysis.affected.partial_cable_count,
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
