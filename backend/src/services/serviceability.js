const db = require('../db');
const {
  MAX_SEARCH_HOPS,
  MAX_SEARCH_DISTANCE_M,
  SAFETY_MARGIN_DB,
  DEFAULT_FIBER_ATTENUATION_DB_PER_KM,
  DEFAULT_SPLICE_LOSS_DB,
  numeric,
  round2,
  isSpareCore,
  isFreePort,
  fiberLoss,
  splitterLoss,
  calculateLossBudget,
  dropSegment,
} = require('../utils/serviceabilityRules');
const { haversineMeters } = require('./streetRoute');

const CORE_STATUSES = new Set(['spare', 'in_use', 'reserved', 'damaged', 'unknown']);

function point(value) {
  if (!value || typeof value !== 'object') return null;
  const lat = numeric(value.lat);
  const lng = numeric(value.lng);
  if (lat == null || lng == null || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function enclosurePoint(enclosure) {
  return point(enclosure);
}

function activeCable(cable) {
  return Boolean(
    cable && cable.status === 'active' && cable.cable_type !== 'drop' &&
    cable.from_enclosure_id && cable.to_enclosure_id,
  );
}

async function loadServiceabilitySnapshot(dbClient = db) {
  const [enclosureResult, headends, cables, cores, splices, splitters, ports, terminations, customers] = await Promise.all([
    dbClient.raw(`
      SELECT e.id, e.code, e.name, e.headend_id, e.pole_id,
             e.connector_count_in, e.connector_count_out,
             COALESCE(ST_Y(e.location::geometry), ST_Y(p.location::geometry)) AS lat,
             COALESCE(ST_X(e.location::geometry), ST_X(p.location::geometry)) AS lng
      FROM enclosures AS e
      LEFT JOIN poles AS p ON p.id = e.pole_id
    `),
    dbClient('headends').select('id', 'code', 'root_enclosure_id', 'budget_db'),
    dbClient('cables').select(
      'id', 'code', 'cable_type', 'status', 'from_enclosure_id', 'to_enclosure_id',
      'length_m', 'attenuation_db_per_km', 'continues_cable_id', 'customer_id', 'customer_label',
    ),
    dbClient('fiber_cores as fc')
      .join('cables as c', 'c.id', 'fc.cable_id')
      .select(
        'fc.id', 'fc.cable_id', 'fc.core_number', 'fc.status',
        'c.code as cable_code', 'c.cable_type', 'c.from_enclosure_id', 'c.to_enclosure_id',
        'c.customer_id', 'c.customer_label',
      ),
    dbClient('splices as s')
      .join('fiber_cores as ca', 'ca.id', 's.core_a_id')
      .join('fiber_cores as cb', 'cb.id', 's.core_b_id')
      .select(
        's.id', 's.enclosure_id', 's.splice_type', 's.loss_db',
        's.core_a_id', 's.core_b_id', 'ca.cable_id as core_a_cable_id', 'cb.cable_id as core_b_cable_id',
      ),
    dbClient('splitters').select(
      'id', 'enclosure_id', 'name', 'split_count', 'input_core_id',
      'insertion_loss_db', 'loss_db', 'disabled',
    ),
    dbClient('splitter_ports as sp')
      .join('splitters as s', 's.id', 'sp.splitter_id')
      .leftJoin('fiber_cores as fc', 'fc.id', 'sp.output_core_id')
      .leftJoin('cables as c', 'c.id', 'fc.cable_id')
      .leftJoin('terminations as t', 't.core_id', 'fc.id')
      .select(
        'sp.id', 'sp.splitter_id', 'sp.port_number', 'sp.status', 'sp.disabled',
        'sp.output_core_id', 'sp.output_splitter_id', 's.enclosure_id as splitter_enclosure_id',
        's.disabled as splitter_disabled', 'fc.status as core_status',
        'c.customer_label as cable_customer_label', 't.customer_label as termination_customer_label',
        't.customer_id',
      ),
    dbClient('terminations').select('id', 'core_id', 'cable_id', 'customer_id', 'customer_label'),
    dbClient.raw(`
      SELECT id, customer_code, status,
             ST_Y(location::geometry) AS lat,
             ST_X(location::geometry) AS lng
      FROM customers
    `),
  ]);

  return {
    enclosures: enclosureResult.rows || [],
    headends,
    cables,
    cores,
    splices,
    splitters,
    ports,
    terminations,
    customers: customers.rows || [],
  };
}

function buildEnclosureGraph(snapshot) {
  const graph = new Map((snapshot.enclosures || []).map((enclosure) => [enclosure.id, []]));
  for (const cable of snapshot.cables || []) {
    if (!activeCable(cable)) continue;
    const edge = {
      cable,
      cable_id: cable.id,
      from_enclosure_id: cable.from_enclosure_id,
      to_enclosure_id: cable.to_enclosure_id,
    };
    if (!graph.has(cable.from_enclosure_id)) graph.set(cable.from_enclosure_id, []);
    if (!graph.has(cable.to_enclosure_id)) graph.set(cable.to_enclosure_id, []);
    graph.get(cable.from_enclosure_id).push({ neighbor: cable.to_enclosure_id, ...edge });
    graph.get(cable.to_enclosure_id).push({ neighbor: cable.from_enclosure_id, ...edge });
  }
  for (const edges of graph.values()) {
    edges.sort((a, b) => String(a.cable_id).localeCompare(String(b.cable_id)) || String(a.neighbor).localeCompare(String(b.neighbor)));
  }
  return graph;
}

function componentFrom(graph, start) {
  const seen = new Set();
  if (!graph.has(start)) return seen;
  const queue = [start];
  seen.add(start);
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    for (const edge of graph.get(current) || []) {
      if (seen.has(edge.neighbor)) continue;
      seen.add(edge.neighbor);
      queue.push(edge.neighbor);
    }
  }
  return seen;
}

function componentHasCycle(graph, component) {
  const visited = new Set();
  const parentCable = new Map();
  for (const start of component) {
    if (visited.has(start)) continue;
    visited.add(start);
    const queue = [start];
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index];
      for (const edge of graph.get(current) || []) {
        if (!component.has(edge.neighbor)) continue;
        if (!visited.has(edge.neighbor)) {
          visited.add(edge.neighbor);
          parentCable.set(edge.neighbor, edge.cable_id);
          queue.push(edge.neighbor);
        } else if (parentCable.get(current) !== edge.cable_id) {
          return true;
        }
      }
    }
  }
  return false;
}

function resolveTopology(snapshot, enclosureId) {
  const enclosureById = new Map((snapshot.enclosures || []).map((row) => [row.id, row]));
  const enclosure = enclosureById.get(enclosureId);
  if (!enclosure) return { known: false, reason: 'ENCLOSURE_NOT_FOUND', enclosureById };

  const graph = buildEnclosureGraph(snapshot);
  const component = componentFrom(graph, enclosureId);
  const reachableHeadendIds = new Set();
  for (const id of component) {
    const assigned = enclosureById.get(id)?.headend_id;
    if (assigned) reachableHeadendIds.add(assigned);
  }
  for (const headend of snapshot.headends || []) {
    if (headend.root_enclosure_id && component.has(headend.root_enclosure_id)) reachableHeadendIds.add(headend.id);
  }

  if (reachableHeadendIds.size === 0) {
    return { known: false, reason: 'HEADEND_UNRESOLVED', enclosure, enclosureById, graph, component };
  }
  if (reachableHeadendIds.size > 1) {
    return {
      known: false,
      reason: 'MULTIPLE_HEADENDS',
      enclosure,
      enclosureById,
      graph,
      component,
      headend_ids: [...reachableHeadendIds].sort(),
    };
  }

  const headendId = [...reachableHeadendIds][0];
  const headend = (snapshot.headends || []).find((row) => row.id === headendId);
  if (!headend || !headend.root_enclosure_id || !component.has(headend.root_enclosure_id)) {
    return { known: false, reason: 'HEADEND_ROOT_UNRESOLVED', enclosure, enclosureById, graph, component, headend };
  }
  if (componentHasCycle(graph, component)) {
    return { known: false, reason: 'CYCLE_DETECTED', enclosure, enclosureById, graph, component, headend };
  }

  const parent = new Map([[headend.root_enclosure_id, null]]);
  const parentEdge = new Map();
  const depth = new Map([[headend.root_enclosure_id, 0]]);
  const queue = [headend.root_enclosure_id];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    for (const edge of graph.get(current) || []) {
      if (parent.has(edge.neighbor)) continue;
      parent.set(edge.neighbor, current);
      parentEdge.set(edge.neighbor, edge);
      depth.set(edge.neighbor, depth.get(current) + 1);
      queue.push(edge.neighbor);
    }
  }
  if (!parent.has(enclosureId)) {
    return { known: false, reason: 'NO_PATH_TO_HEADEND', enclosure, enclosureById, graph, component, headend };
  }

  const routeEdges = [];
  let cursor = enclosureId;
  while (cursor !== headend.root_enclosure_id) {
    const edge = parentEdge.get(cursor);
    if (!edge || routeEdges.some((prior) => prior.cable_id === edge.cable_id)) {
      return { known: false, reason: 'CYCLE_DETECTED', enclosure, enclosureById, graph, component, headend };
    }
    const from = parent.get(cursor);
    routeEdges.push({ ...edge, from_enclosure_id: from, to_enclosure_id: cursor });
    cursor = from;
  }
  routeEdges.reverse();
  const routeEnclosureIds = [headend.root_enclosure_id, ...routeEdges.map((edge) => edge.to_enclosure_id)];
  const children = new Map();
  for (const [childId, parentId] of parent.entries()) {
    if (!parentId) continue;
    const edge = parentEdge.get(childId);
    if (!children.has(parentId)) children.set(parentId, []);
    children.get(parentId).push({ enclosure_id: childId, edge: { ...edge, from_enclosure_id: parentId, to_enclosure_id: childId } });
  }
  for (const list of children.values()) list.sort((a, b) => String(a.enclosure_id).localeCompare(String(b.enclosure_id)));

  const budget = numeric(headend.budget_db);
  return {
    known: budget != null,
    reason: budget == null ? 'UNKNOWN_BUDGET' : null,
    enclosure,
    enclosureById,
    graph,
    component,
    headend,
    budget_db: budget,
    root_enclosure_id: headend.root_enclosure_id,
    parent,
    parentEdge,
    depth,
    children,
    routeEdges,
    routeEnclosureIds,
  };
}

function cableDistanceMeters(edge, snapshot) {
  const length = numeric(edge.cable?.length_m);
  if (length != null && length >= 0) return length;
  const from = (snapshot.enclosures || []).find((row) => row.id === edge.from_enclosure_id);
  const to = (snapshot.enclosures || []).find((row) => row.id === edge.to_enclosure_id);
  const fromPoint = enclosurePoint(from);
  const toPoint = enclosurePoint(to);
  if (!fromPoint || !toPoint) return null;
  const distance = haversineMeters(fromPoint, toPoint);
  return Number.isFinite(distance) && distance >= 0 ? distance : null;
}

function searchDownstream(snapshot, topology, startEnclosureId, {
  maxHops = MAX_SEARCH_HOPS,
  maxDistanceM = MAX_SEARCH_DISTANCE_M,
  includeTarget = false,
} = {}) {
  if (!topology?.known || !topology.children || !topology.depth?.has(startEnclosureId)) return [];
  const hopLimit = Number.isInteger(maxHops) && maxHops >= 0 ? maxHops : MAX_SEARCH_HOPS;
  const distanceLimit = Number.isFinite(Number(maxDistanceM)) && Number(maxDistanceM) >= 0 ? Number(maxDistanceM) : MAX_SEARCH_DISTANCE_M;
  const queue = [{ enclosure_id: startEnclosureId, hops: 0, distance_m: 0, path: [], ancestors: new Set([startEnclosureId]) }];
  const result = [];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (current.hops > 0 || includeTarget) {
      result.push({ enclosure_id: current.enclosure_id, hops: current.hops, distance_m: current.distance_m, path: current.path });
    }
    if (current.hops >= hopLimit) continue;
    for (const child of topology.children.get(current.enclosure_id) || []) {
      if (current.ancestors.has(child.enclosure_id)) continue;
      const edge = child.edge;
      const edgeDistance = cableDistanceMeters(edge, snapshot);
      if (edgeDistance == null) continue;
      const distance = current.distance_m + edgeDistance;
      if (distance > distanceLimit) continue;
      const ancestors = new Set(current.ancestors);
      ancestors.add(child.enclosure_id);
      queue.push({
        enclosure_id: child.enclosure_id,
        hops: current.hops + 1,
        distance_m: distance,
        path: [...current.path, edge],
        ancestors,
      });
    }
  }
  return result.sort((a, b) => a.hops - b.hops || a.distance_m - b.distance_m || String(a.enclosure_id).localeCompare(String(b.enclosure_id)));
}

function coreReferences(snapshot, coreId) {
  const spliceCount = (snapshot.splices || []).filter((row) => row.core_a_id === coreId || row.core_b_id === coreId).length;
  const terminationCount = (snapshot.terminations || []).filter((row) => row.core_id === coreId).length;
  const splitterInputCount = (snapshot.splitters || []).filter((row) => row.input_core_id === coreId).length;
  const splitterPortCount = (snapshot.ports || []).filter((row) => row.output_core_id === coreId).length;
  return {
    splice_count: spliceCount,
    termination_count: terminationCount,
    splitter_use_count: splitterInputCount + splitterPortCount,
  };
}

function spareCoresAt(snapshot, enclosureId) {
  const incidentCableIds = new Set((snapshot.cables || [])
    .filter((cable) => cable.from_enclosure_id === enclosureId || cable.to_enclosure_id === enclosureId)
    .map((cable) => cable.id));
  return (snapshot.cores || [])
    .filter((core) => incidentCableIds.has(core.cable_id) && isSpareCore({ ...core, ...coreReferences(snapshot, core.id) }))
    .sort((a, b) => Number(a.core_number) - Number(b.core_number) || String(a.id).localeCompare(String(b.id)));
}

function coreDataQualityAt(snapshot, enclosureId) {
  const incidentCableIds = new Set((snapshot.cables || [])
    .filter((cable) => cable.from_enclosure_id === enclosureId || cable.to_enclosure_id === enclosureId)
    .map((cable) => cable.id));
  const cores = (snapshot.cores || []).filter((core) => incidentCableIds.has(core.cable_id));
  const undocumented = cores.filter((core) => !CORE_STATUSES.has(core.status)).length;
  const unknown = cores.filter((core) => core.status === 'unknown' || !CORE_STATUSES.has(core.status)).length;
  const staleSpare = cores.filter((core) => core.status === 'spare' && !isSpareCore({ ...core, ...coreReferences(snapshot, core.id) })).length;
  return { total: cores.length, undocumented, unknown, stale_spare: staleSpare };
}

function splittersAt(snapshot, enclosureId) {
  const splitters = (snapshot.splitters || []).filter((splitter) => splitter.enclosure_id === enclosureId);
  const bySplitter = new Map(splitters.map((splitter) => [splitter.id, []]));
  for (const port of snapshot.ports || []) {
    if (bySplitter.has(port.splitter_id)) bySplitter.get(port.splitter_id).push(port);
  }
  return splitters.map((splitter) => ({
    ...splitter,
    ports: (bySplitter.get(splitter.id) || []).sort((a, b) => Number(a.port_number) - Number(b.port_number)),
  }));
}

function fiberSegmentForCable(cable) {
  const length = numeric(cable?.length_m);
  if (length == null || length < 0) return null;
  return {
    cable_id: cable.id,
    length_m: length,
    attenuation_db_per_km: numeric(cable.attenuation_db_per_km) ?? DEFAULT_FIBER_ATTENUATION_DB_PER_KM,
  };
}

function addConnectionEdge(graph, from, to, parts, bidirectional = false) {
  if (!from || !to) return;
  const lossDb = parts.reduce((sum, part) => sum + (numeric(part.value?.loss_db) ?? 0), 0);
  if (!graph.has(from)) graph.set(from, []);
  graph.get(from).push({ to, parts, loss_db: lossDb, bidirectional });
  if (bidirectional) {
    if (!graph.has(to)) graph.set(to, []);
    graph.get(to).push({ to: from, parts, loss_db: lossDb, bidirectional });
  }
}

function localConnectionGraph(snapshot, enclosureId) {
  const graph = new Map();
  const cores = new Set((snapshot.cores || []).map((core) => core.id));
  for (const splice of snapshot.splices || []) {
    if (splice.enclosure_id !== enclosureId || !cores.has(splice.core_a_id) || !cores.has(splice.core_b_id)) continue;
    const spliceLoss = numeric(splice.loss_db) ?? DEFAULT_SPLICE_LOSS_DB;
    addConnectionEdge(graph, splice.core_a_id, splice.core_b_id, [{ type: 'splice', value: { ...splice, loss_db: spliceLoss } }], true);
  }

  const splitters = (snapshot.splitters || []).filter((splitter) => splitter.enclosure_id === enclosureId && splitter.disabled === false);
  let cycle = false;
  for (const splitter of splitters) {
    if (!splitter.input_core_id || !cores.has(splitter.input_core_id)) continue;
    const loss = splitterLoss(splitter);
    if (!loss) continue;
    const splitterPart = {
      type: 'splitter',
      value: { ...splitter, loss_db: loss.loss_db, insertion_loss_db: loss.loss_db },
    };
    for (const port of (snapshot.ports || []).filter((row) => row.splitter_id === splitter.id)) {
      if (port.disabled !== false || port.status !== 'active') continue;
      if (!port.output_core_id || !cores.has(port.output_core_id)) continue;
      addConnectionEdge(graph, splitter.input_core_id, port.output_core_id, [splitterPart], false);
    }
  }

  // Detect cycles in the undirected splice portion; splitter edges are directed
  // and cannot be traversed backwards as optical service paths.
  const spliceGraph = new Map();
  for (const [coreId, edges] of graph.entries()) {
    if (!spliceGraph.has(coreId)) spliceGraph.set(coreId, []);
    for (const edge of edges) {
      if (!edge.bidirectional) continue;
      spliceGraph.get(coreId).push(edge.to);
    }
  }
  const visited = new Set();
  for (const start of spliceGraph.keys()) {
    if (visited.has(start)) continue;
    const stack = [{ id: start, parent: null }];
    while (stack.length) {
      const current = stack.pop();
      if (visited.has(current.id)) { cycle = true; continue; }
      visited.add(current.id);
      for (const next of spliceGraph.get(current.id) || []) {
        if (next !== current.parent && visited.has(next)) cycle = true;
        else if (!visited.has(next)) stack.push({ id: next, parent: current.id });
      }
    }
  }
  for (const edges of graph.values()) {
    edges.sort((a, b) => a.loss_db - b.loss_db || String(a.to).localeCompare(String(b.to)));
  }
  return { graph, cycle };
}

function connectionPath(snapshot, enclosureId, fromCoreId, toCoreId, cache = new Map()) {
  if (!fromCoreId || !toCoreId) return { found: false };
  if (fromCoreId === toCoreId) return { found: true, parts: [], loss_db: 0 };
  const cacheKey = `${enclosureId}\0${fromCoreId}\0${toCoreId}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  const local = localConnectionGraph(snapshot, enclosureId);
  if (local.cycle) {
    const result = { found: false, unknown: true, reason: 'CYCLE_DETECTED' };
    cache.set(cacheKey, result);
    return result;
  }

  const distances = new Map([[fromCoreId, 0]]);
  const previous = new Map();
  const pending = new Set([fromCoreId]);
  while (pending.size) {
    let current = null;
    let best = Infinity;
    for (const candidate of pending) {
      const distance = distances.get(candidate);
      if (distance < best) { best = distance; current = candidate; }
    }
    if (current == null) break;
    pending.delete(current);
    if (current === toCoreId) break;
    for (const edge of local.graph.get(current) || []) {
      const nextDistance = best + edge.loss_db;
      if (nextDistance >= (distances.get(edge.to) ?? Infinity)) continue;
      distances.set(edge.to, nextDistance);
      previous.set(edge.to, { from: current, edge });
      pending.add(edge.to);
    }
  }
  if (!distances.has(toCoreId)) {
    const result = { found: false };
    cache.set(cacheKey, result);
    return result;
  }
  const parts = [];
  let cursor = toCoreId;
  const seen = new Set();
  while (cursor !== fromCoreId) {
    if (seen.has(cursor)) {
      const result = { found: false, unknown: true, reason: 'CYCLE_DETECTED' };
      cache.set(cacheKey, result);
      return result;
    }
    seen.add(cursor);
    const step = previous.get(cursor);
    if (!step) {
      const result = { found: false };
      cache.set(cacheKey, result);
      return result;
    }
    parts.unshift(...step.edge.parts);
    cursor = step.from;
  }
  const result = { found: true, parts, loss_db: distances.get(toCoreId) };
  cache.set(cacheKey, result);
  cache.set(`${enclosureId}\0${toCoreId}\0${fromCoreId}`, result);
  return result;
}

function coreIdsOnCable(snapshot, cableId) {
  return (snapshot.cores || [])
    .filter((core) => core.cable_id === cableId)
    .sort((a, b) => Number(a.core_number) - Number(b.core_number) || String(a.id).localeCompare(String(b.id)))
    .map((core) => core.id);
}

function buildOpticalPathToEnclosure(snapshot, topology) {
  if (!topology.known) return { known: false, reason: topology.reason };
  if (!topology.routeEdges.length) {
    return { known: true, states: [], route_edges: [], route_enclosure_ids: topology.routeEnclosureIds };
  }
  const firstEdge = topology.routeEdges[0];
  const firstSegment = fiberSegmentForCable(firstEdge.cable);
  const firstCoreIds = coreIdsOnCable(snapshot, firstEdge.cable_id);
  if (!firstSegment || !firstCoreIds.length) return { known: false, reason: 'PATH_DATA_MISSING' };

  let states = new Map(firstCoreIds.map((coreId) => [coreId, {
    core_id: coreId,
    fiber_segments: [firstSegment],
    splices: [],
    splitters: [],
    loss_db: numeric(firstSegment.length_m) / 1000 * (numeric(firstSegment.attenuation_db_per_km) ?? DEFAULT_FIBER_ATTENUATION_DB_PER_KM),
    path_core_ids: [coreId],
  }]));
  const connectionCache = new Map();

  for (let edgeIndex = 1; edgeIndex < topology.routeEdges.length; edgeIndex += 1) {
    const incoming = topology.routeEdges[edgeIndex - 1];
    const outgoing = topology.routeEdges[edgeIndex];
    const junction = incoming.to_enclosure_id;
    const nextSegment = fiberSegmentForCable(outgoing.cable);
    const nextCoreIds = coreIdsOnCable(snapshot, outgoing.cable_id);
    if (!nextSegment || !nextCoreIds.length) return { known: false, reason: 'PATH_DATA_MISSING' };
    const local = localConnectionGraph(snapshot, junction);
    if (local.cycle) return { known: false, reason: 'CYCLE_DETECTED' };

    const nextStates = new Map();
    for (const state of states.values()) {
      for (const nextCoreId of nextCoreIds) {
        const connection = connectionPath(snapshot, junction, state.core_id, nextCoreId, connectionCache);
        if (connection.unknown) return { known: false, reason: connection.reason };
        if (!connection.found) continue;
        const connectionSplices = connection.parts.filter((part) => part.type === 'splice').map((part) => part.value);
        const connectionSplitters = connection.parts.filter((part) => part.type === 'splitter').map((part) => part.value);
        const fiberLossDb = Number(nextSegment.length_m) / 1000 * (numeric(nextSegment.attenuation_db_per_km) ?? DEFAULT_FIBER_ATTENUATION_DB_PER_KM);
        const candidate = {
          core_id: nextCoreId,
          fiber_segments: [...state.fiber_segments, nextSegment],
          splices: [...state.splices, ...connectionSplices],
          splitters: [...state.splitters, ...connectionSplitters],
          loss_db: state.loss_db + connection.loss_db + fiberLossDb,
          path_core_ids: [...state.path_core_ids, ...connection.parts.map((part) => part.value.id).filter(Boolean), nextCoreId],
        };
        const current = nextStates.get(nextCoreId);
        if (!current || candidate.loss_db < current.loss_db) nextStates.set(nextCoreId, candidate);
      }
    }
    if (!nextStates.size) return { known: false, reason: 'NO_CORE_CONNECTION' };
    states = nextStates;
  }

  return {
    known: true,
    states: [...states.values()].sort((a, b) => a.loss_db - b.loss_db || String(a.core_id).localeCompare(String(b.core_id))),
    route_edges: topology.routeEdges,
    route_enclosure_ids: topology.routeEnclosureIds,
  };
}

function splitterChainToPort(snapshot, splitterId) {
  const splitterById = new Map((snapshot.splitters || []).map((row) => [row.id, row]));
  const parentByChild = new Map();
  for (const port of snapshot.ports || []) {
    if (port.output_splitter_id) parentByChild.set(port.output_splitter_id, port);
  }
  const chain = [];
  const seen = new Set();
  let current = splitterById.get(splitterId);
  while (current) {
    if (seen.has(current.id)) return { known: false, reason: 'CYCLE_DETECTED' };
    seen.add(current.id);
    if (current.disabled !== false) return { known: false, reason: 'SPLITTER_DISABLED' };
    chain.unshift(current);
    const parentPort = parentByChild.get(current.id);
    if (!parentPort) break;
    if (parentPort.disabled !== false || parentPort.status !== 'active') {
      return { known: false, reason: 'SPLITTER_FEED_DISABLED' };
    }
    current = splitterById.get(parentPort.splitter_id);
  }
  if (!chain.length || !chain[0].input_core_id) return { known: false, reason: 'SPLITTER_INPUT_UNKNOWN' };
  const losses = [];
  for (const splitter of chain) {
    const loss = splitterLoss(splitter);
    if (!loss) return { known: false, reason: 'SPLITTER_LOSS_UNKNOWN' };
    losses.push({ id: splitter.id, split_count: splitter.split_count, insertion_loss_db: loss.loss_db, loss_db: loss.loss_db });
  }
  return { known: true, input_core_id: chain[0].input_core_id, chain, splitters: losses };
}

function stateWithParts(state, parts) {
  const splices = parts.filter((part) => part.type === 'splice').map((part) => part.value);
  const splitters = parts.filter((part) => part.type === 'splitter').map((part) => part.value);
  const loss = parts.reduce((sum, part) => sum + (numeric(part.value?.loss_db) ?? 0), 0);
  return {
    ...state,
    splices: [...state.splices, ...splices],
    splitters: [...state.splitters, ...splitters],
    loss_db: state.loss_db + loss,
  };
}

function localServiceStates(snapshot, enclosureId, opticalPath, { requireAvailable = true } = {}) {
  const states = opticalPath.states || [];
  const results = [];
  const cores = spareCoresAt(snapshot, enclosureId);
  const connectionCache = new Map();

  for (const spareCore of cores) {
    for (const state of states) {
      if (state.core_id === spareCore.id) {
        results.push({ ...state, service_type: 'spare_core', core_id: spareCore.id, spare_core: spareCore });
      } else {
        results.push({
          ...state,
          service_type: 'spare_core',
          core_id: spareCore.id,
          spare_core: spareCore,
          splices: [...state.splices, { splice_id: null, loss_db: DEFAULT_SPLICE_LOSS_DB, proposed: true }],
          loss_db: state.loss_db + DEFAULT_SPLICE_LOSS_DB,
        });
      }
    }
  }

  const splitters = splittersAt(snapshot, enclosureId).filter((splitter) => splitter.disabled === false);
  for (const splitter of splitters) {
    const chain = splitterChainToPort(snapshot, splitter.id);
    if (!chain.known) continue;
    const freePorts = splitter.ports.filter((port) => isFreePort(port));
    for (const port of freePorts) {
      for (const state of states) {
        const connection = connectionPath(snapshot, enclosureId, state.core_id, chain.input_core_id, connectionCache);
        if (connection.unknown || !connection.found) continue;
        const connected = stateWithParts(state, connection.parts);
        results.push({
          ...connected,
          service_type: 'splitter_port',
          splitter_id: splitter.id,
          port_number: port.port_number,
          splitters: [...connected.splitters, ...chain.splitters],
          loss_db: connected.loss_db + chain.splitters.reduce((sum, value) => sum + Number(value.loss_db), 0),
        });
      }
    }
  }

  if (!results.length && !requireAvailable) {
    results.push(...states.map((state) => ({ ...state, service_type: 'documented_path' })));
  }
  return results.sort((a, b) => a.loss_db - b.loss_db || String(a.core_id || '').localeCompare(String(b.core_id || '')));
}

function customerDropSegment(enclosure, customerLocation) {
  const from = enclosurePoint(enclosure);
  const to = point(customerLocation);
  return from && to ? dropSegment(from, to) : null;
}

function connectorCountForEnclosures(snapshot, enclosureIds) {
  const ids = [...new Set(enclosureIds || [])];
  const byId = new Map((snapshot.enclosures || []).map((row) => [row.id, row]));
  let connectorCount = 0;
  const inventory = [];
  for (const enclosureId of ids) {
    const enclosure = byId.get(enclosureId);
    const incoming = numeric(enclosure?.connector_count_in);
    const outgoing = numeric(enclosure?.connector_count_out);
    if (
      incoming == null || outgoing == null ||
      !Number.isInteger(incoming) || !Number.isInteger(outgoing) ||
      incoming < 0 || outgoing < 0
    ) {
      return {
        known: false,
        reason: 'CONNECTOR_COUNT_UNAVAILABLE',
        missing: ['connector_count_in', 'connector_count_out'],
        missing_enclosure_ids: [enclosureId],
      };
    }
    connectorCount += incoming + outgoing;
    inventory.push({ enclosure_id: enclosureId, connector_count_in: incoming, connector_count_out: outgoing });
  }
  return { known: true, connector_count: connectorCount, inventory };
}

function fullBudgetForState(state, budgetDb, drop = null, safetyMargin = SAFETY_MARGIN_DB, connectorCount = null) {
  return calculateLossBudget({
    fiber_segments: [...(state.fiber_segments || []), ...(drop ? [drop] : [])],
    splices: state.splices || [],
    splitters: state.splitters || [],
    // Missing connector inventory is unknown topology, never an assumed zero.
    connector_count: connectorCount,
    budget_db: budgetDb,
    safety_margin_db: safetyMargin,
  });
}

function issue(type, details = {}) {
  return { type, ...details };
}

function resolveSnapshot(args, deps) {
  if (deps.snapshot) return Promise.resolve(deps.snapshot);
  const loader = deps.loadSnapshot || loadServiceabilitySnapshot;
  return loader(deps.dbClient || db, args);
}

async function checkServiceability(args = {}, deps = {}) {
  const enclosureId = String(args.enclosure_id ?? '').trim();
  if (!enclosureId) return { status: 'error', error: 'enclosure_id is required', issues: [] };
  const hasLat = args.lat !== undefined && args.lat !== null;
  const hasLng = args.lng !== undefined && args.lng !== null;
  if (hasLat !== hasLng) return { status: 'error', error: 'lat and lng must be supplied together', issues: [] };
  const customerLocation = hasLat ? point({ lat: args.lat, lng: args.lng }) : null;
  if (hasLat && !customerLocation) return { status: 'error', error: 'lat/lng must be valid coordinates', issues: [] };

  const snapshot = await resolveSnapshot(args, deps);
  const enclosure = (snapshot.enclosures || []).find((row) => row.id === enclosureId);
  if (!enclosure) return { status: 'not_found', enclosure_id: enclosureId, issues: [] };
  const spareCores = spareCoresAt(snapshot, enclosureId);
  const splitters = splittersAt(snapshot, enclosureId);
  const freePorts = splitters.flatMap((splitter) =>
    splitter.disabled === false
      ? splitter.ports.filter((port) => isFreePort(port)).map((port) => ({ splitter_id: splitter.id, port_number: port.port_number }))
      : [],
  );
  const dataQuality = coreDataQualityAt(snapshot, enclosureId);
  const enclosurePorts = splitters.flatMap((splitter) => splitter.ports);
  const unknownPorts = enclosurePorts.filter((port) =>
    !['active', 'inactive', 'damaged'].includes(port.status) || typeof port.disabled !== 'boolean',
  ).length;
  const disabledPorts = enclosurePorts.filter((port) => port.disabled === true || ['inactive', 'damaged'].includes(port.status)).length;
  const issues = [];

  if (spareCores.length === 0) issues.push(issue('NO_SPARE_CORE', { spare_core_count: 0 }));
  if (splitters.length > 0 && freePorts.length === 0) {
    issues.push(issue('NO_SPLITTER_PORT', { splitter_count: splitters.length, free_port_count: 0 }));
  }

  const topology = resolveTopology(snapshot, enclosureId);
  if (topology.reason === 'UNKNOWN_BUDGET') {
    issues.push(issue('UNKNOWN_TOPOLOGY', { reason: 'UNKNOWN_BUDGET', headend_id: topology.headend?.id ?? null }));
  } else if (!topology.known) {
    issues.push(issue('UNKNOWN_TOPOLOGY', { reason: topology.reason, headend_ids: topology.headend_ids || undefined }));
  }

  let power = null;
  if (customerLocation && topology.known) {
    const opticalPath = buildOpticalPathToEnclosure(snapshot, topology);
    if (!opticalPath.known) {
      issues.push(issue('UNKNOWN_TOPOLOGY', { reason: opticalPath.reason }));
    } else {
      const drop = customerDropSegment(enclosure, customerLocation);
      if (!drop) {
        issues.push(issue('UNKNOWN_TOPOLOGY', { reason: 'ENCLOSURE_LOCATION_UNKNOWN' }));
      } else {
        const options = localServiceStates(snapshot, enclosureId, opticalPath, { requireAvailable: true });
        const states = options.length
          ? options
          : localServiceStates(snapshot, enclosureId, opticalPath, { requireAvailable: false });
        if (!states.length) {
          issues.push(issue('UNKNOWN_TOPOLOGY', { reason: 'NO_OPTICAL_PATH_TO_ENCLOSURE' }));
        } else {
          const connectors = connectorCountForEnclosures(snapshot, opticalPath.route_enclosure_ids);
          if (!connectors.known) {
            issues.push(issue('UNKNOWN_TOPOLOGY', {
              reason: connectors.reason,
              missing: connectors.missing,
              missing_enclosure_ids: connectors.missing_enclosure_ids,
            }));
          } else {
            const budgets = states.map((state) => ({
              state,
              budget: fullBudgetForState(state, topology.budget_db, drop, SAFETY_MARGIN_DB, connectors.connector_count),
            }));
            const evaluated = budgets
              .filter((item) => item.budget.known)
              .sort((a, b) => a.budget.total_loss_db - b.budget.total_loss_db);
            if (!evaluated.length) {
              const missing = budgets.find((item) => !item.budget.known)?.budget;
              issues.push(issue('UNKNOWN_TOPOLOGY', {
                reason: missing?.detail || missing?.reason || 'LOSS_DATA_INCOMPLETE',
                ...(missing?.missing ? { missing: missing.missing } : {}),
              }));
            } else {
              const best = evaluated[0];
              power = {
                ...best.budget,
                service_type: best.state.service_type,
                core_id: best.state.core_id ?? null,
                splitter_id: best.state.splitter_id ?? null,
                port_number: best.state.port_number ?? null,
                connector_inventory: connectors.inventory,
                customer_drop: {
                  length_m: round2(drop.length_m),
                  attenuation_db_per_km: drop.attenuation_db_per_km,
                  basis: drop.basis,
                },
              };
              if (power.low_power) {
                issues.push(issue('LOW_POWER', {
                  margin_db: power.margin_db,
                  total_loss_db: power.total_loss_db,
                  budget_db: power.budget_db,
                  severity: power.severity,
                }));
              }
            }
          }
        }
      }
    }
  }

  const unknown = issues.some((item) => item.type === 'UNKNOWN_TOPOLOGY');
  return {
    status: unknown ? 'unknown' : issues.length ? 'issues' : 'serviceable',
    enclosure_id: enclosureId,
    issues,
    capacity: {
      spare_core_count: spareCores.length,
      free_splitter_port_count: freePorts.length,
      splitter_count: splitters.length,
      unknown_core_count: dataQuality.unknown,
      undocumented_core_count: dataQuality.undocumented,
      inconsistent_spare_status_count: dataQuality.stale_spare,
      unknown_splitter_port_count: unknownPorts,
      disabled_splitter_port_count: disabledPorts,
    },
    ...(power ? { power } : {}),
    ...(customerLocation ? {} : { power_check: 'skipped_customer_location_missing' }),
  };
}

module.exports = {
  CORE_STATUSES,
  point,
  enclosurePoint,
  activeCable,
  loadServiceabilitySnapshot,
  buildEnclosureGraph,
  componentFrom,
  componentHasCycle,
  resolveTopology,
  searchDownstream,
  coreReferences,
  spareCoresAt,
  coreDataQualityAt,
  splittersAt,
  fiberSegmentForCable,
  localConnectionGraph,
  connectionPath,
  buildOpticalPathToEnclosure,
  splitterChainToPort,
  localServiceStates,
  stateWithParts,
  customerDropSegment,
  connectorCountForEnclosures,
  fullBudgetForState,
  checkServiceability,
};
