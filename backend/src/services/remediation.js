const db = require('../db');
const {
  MAX_SEARCH_HOPS,
  MAX_SEARCH_DISTANCE_M,
  SAFETY_MARGIN_DB,
  SPLITTER_INSERTION_LOSS_DB,
  DEFAULT_FIBER_ATTENUATION_DB_PER_KM,
  DEFAULT_SPLICE_LOSS_DB,
  numeric,
  round2,
  isFreePort,
} = require('../utils/serviceabilityRules');
const {
  loadServiceabilitySnapshot,
  resolveTopology,
  searchDownstream,
  spareCoresAt,
  splittersAt,
  buildOpticalPathToEnclosure,
  splitterChainToPort,
  connectionPath,
  stateWithParts,
  customerDropSegment,
  connectorCountForEnclosures,
  fullBudgetForState,
} = require('./serviceability');
const { haversineMeters } = require('./streetRoute');

function normalizedLocation(value) {
  if (!value || typeof value !== 'object') return null;
  const lat = numeric(value.lat);
  const lng = numeric(value.lng);
  return lat != null && lng != null && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
    ? { lat, lng }
    : null;
}

function snapshotLocation(enclosure) {
  return normalizedLocation({ lat: enclosure?.lat, lng: enclosure?.lng });
}

function readOptions(options = {}) {
  return {
    dbClient: options.dbClient || db,
    snapshot: options.snapshot,
    loadSnapshot: options.loadSnapshot || loadServiceabilitySnapshot,
    maxSearchHops: Number.isInteger(options.maxSearchHops) && options.maxSearchHops > 0
      ? options.maxSearchHops
      : MAX_SEARCH_HOPS,
    maxSearchDistanceM: Number.isFinite(Number(options.maxSearchDistanceM)) && Number(options.maxSearchDistanceM) > 0
      ? Number(options.maxSearchDistanceM)
      : MAX_SEARCH_DISTANCE_M,
    currentCoreId: options.currentCoreId || null,
  };
}

async function getSnapshot(options = {}) {
  const resolved = readOptions(options);
  return resolved.snapshot || resolved.loadSnapshot(resolved.dbClient);
}

function topologyError(topology) {
  if (topology.reason === 'UNKNOWN_BUDGET') {
    return { type: 'UNKNOWN_TOPOLOGY', reason: 'UNKNOWN_BUDGET', headend_id: topology.headend?.id ?? null };
  }
  return {
    type: 'UNKNOWN_TOPOLOGY',
    reason: topology.reason || 'HEADEND_UNRESOLVED',
    ...(topology.headend_ids ? { headend_ids: topology.headend_ids } : {}),
  };
}

function severityForMargin(marginDb, safetyMarginDb = SAFETY_MARGIN_DB) {
  if (marginDb < 0) return 'FAIL';
  if (marginDb < safetyMarginDb) return 'MARGINAL';
  return 'OK';
}

async function findCoreRemediation(enclosureId, customerLocation, options = {}) {
  // Accept the tool's { enclosure_id, exclude_self } shape as well as the
  // business-rule function signature. `customer_location` remains optional in
  // the service API but is required before candidates can be budget-ranked.
  let excludeSelf = options.excludeSelf !== false;
  if (enclosureId && typeof enclosureId === 'object') {
    const args = enclosureId;
    options = customerLocation || {};
    enclosureId = args.enclosure_id;
    customerLocation = args.customer_location;
    excludeSelf = args.exclude_self !== false;
  }
  const deps = readOptions(options);
  const snapshot = await getSnapshot(deps);
  const target = (snapshot.enclosures || []).find((row) => row.id === enclosureId);
  if (!target) return { status: 'not_found', enclosure_id: enclosureId, candidates: [] };
  const location = normalizedLocation(customerLocation);
  if (!location) {
    return {
      status: 'needs_input',
      enclosure_id: enclosureId,
      candidates: [],
      reason: 'customer location is required to calculate the complete optical path',
      search_limits: { max_hops: deps.maxSearchHops, max_distance_m: deps.maxSearchDistanceM },
    };
  }

  const targetTopology = resolveTopology(snapshot, enclosureId);
  if (!targetTopology.known) {
    return { status: 'unknown', enclosure_id: enclosureId, candidates: [], issue: topologyError(targetTopology) };
  }
  const search = searchDownstream(snapshot, targetTopology, enclosureId, {
    maxHops: deps.maxSearchHops,
    maxDistanceM: deps.maxSearchDistanceM,
    includeTarget: !excludeSelf,
  });
  const candidateRows = [];
  let topologyFailure = null;
  let lossDataFailure = null;
  for (const candidate of search) {
    const spareCores = spareCoresAt(snapshot, candidate.enclosure_id);
    if (!spareCores.length) continue;
    const topology = resolveTopology(snapshot, candidate.enclosure_id);
    if (!topology.known || topology.headend.id !== targetTopology.headend.id) {
      topologyFailure ||= topologyError(topology);
      continue;
    }
    const opticalPath = buildOpticalPathToEnclosure(snapshot, topology);
    if (!opticalPath.known) {
      topologyFailure ||= { type: 'UNKNOWN_TOPOLOGY', reason: opticalPath.reason };
      continue;
    }
    const enclosure = topology.enclosure;
    const drop = customerDropSegment(enclosure, location);
    if (!drop) {
      topologyFailure ||= { type: 'UNKNOWN_TOPOLOGY', reason: 'ENCLOSURE_LOCATION_UNKNOWN' };
      continue;
    }
    const connectors = connectorCountForEnclosures(snapshot, opticalPath.route_enclosure_ids);
    if (!connectors.known) {
      lossDataFailure ||= {
        type: 'UNKNOWN_TOPOLOGY',
        reason: connectors.reason,
        missing: connectors.missing,
        missing_enclosure_ids: connectors.missing_enclosure_ids,
      };
      continue;
    }

    const stateByCore = new Map((opticalPath.states || []).map((state) => [state.core_id, state]));
    for (const spareCore of spareCores) {
      const base = stateByCore.get(spareCore.id) || opticalPath.states?.[0];
      if (!base) continue;
      const state = base.core_id === spareCore.id
        ? { ...base, service_type: 'spare_core', spare_core: spareCore }
        : {
            ...base,
            service_type: 'spare_core',
            spare_core: spareCore,
            splices: [...base.splices, { splice_id: null, loss_db: DEFAULT_SPLICE_LOSS_DB, proposed: true }],
            loss_db: base.loss_db + DEFAULT_SPLICE_LOSS_DB,
          };
      const budget = fullBudgetForState(state, topology.budget_db, drop, SAFETY_MARGIN_DB, connectors.connector_count);
      if (!budget.known) {
        lossDataFailure ||= {
          type: 'UNKNOWN_TOPOLOGY',
          reason: budget.detail || budget.reason || 'LOSS_DATA_INCOMPLETE',
          ...(budget.missing ? { missing: budget.missing } : {}),
        };
        continue;
      }
      if (budget.margin_db < 0) continue;
      candidateRows.push({
        type: 'spare_core',
        source_enclosure_id: candidate.enclosure_id,
        core_id: spareCore.id,
        cable_id: spareCore.cable_id,
        cable_code: spareCore.cable_code || null,
        core_number: Number(spareCore.core_number),
        hops: candidate.hops,
        distance_m: round2(candidate.distance_m),
        path: candidate.path.map((edge) => ({ cable_id: edge.cable_id, cable_code: edge.cable?.code ?? null })),
        total_loss_db: budget.total_loss_db,
        margin_db: budget.margin_db,
        severity: severityForMargin(budget.margin_db),
        budget,
        requires_review: false,
      });
    }
  }

  candidateRows.sort((a, b) => a.hops - b.hops || a.distance_m - b.distance_m || String(a.core_id).localeCompare(String(b.core_id)));
  if (!candidateRows.length) {
    const foundSpare = search.some((candidate) => spareCoresAt(snapshot, candidate.enclosure_id).length > 0);
    return {
      status: topologyFailure || lossDataFailure ? 'unknown' : 'ok',
      enclosure_id: enclosureId,
      candidates: [],
      reason: foundSpare
        ? 'no path meets required margin within search limits'
        : 'no spare core found within search limits',
      ...((topologyFailure || lossDataFailure) ? { issue: topologyFailure || lossDataFailure } : {}),
      search_limits: { max_hops: deps.maxSearchHops, max_distance_m: deps.maxSearchDistanceM },
    };
  }
  return {
    status: 'ok',
    enclosure_id: enclosureId,
    headend_id: targetTopology.headend.id,
    candidates: candidateRows,
    search_limits: { max_hops: deps.maxSearchHops, max_distance_m: deps.maxSearchDistanceM },
  };
}

function freePortCandidates(snapshot, enclosureId) {
  const result = [];
  for (const splitter of splittersAt(snapshot, enclosureId)) {
    if (splitter.disabled !== false) continue;
    for (const port of splitter.ports) {
      if (!isFreePort(port)) continue;
      result.push({
        type: 'splitter_port',
        splitter_id: splitter.id,
        splitter_name: splitter.name ?? null,
        port_number: Number(port.port_number),
      });
    }
  }
  return result.sort((a, b) => String(a.splitter_id).localeCompare(String(b.splitter_id)) || a.port_number - b.port_number);
}

function occupiedPortDetails(snapshot, enclosureId) {
  const coreById = new Map((snapshot.cores || []).map((core) => [core.id, core]));
  const cableById = new Map((snapshot.cables || []).map((cable) => [cable.id, cable]));
  const terminationByCore = new Map((snapshot.terminations || []).map((row) => [row.core_id, row]));
  return splittersAt(snapshot, enclosureId).flatMap((splitter) => splitter.ports
    .filter((port) => port.output_core_id || port.output_splitter_id)
    .map((port) => {
      const core = port.output_core_id ? coreById.get(port.output_core_id) : null;
      const cable = core ? cableById.get(core.cable_id) : null;
      const termination = core ? terminationByCore.get(core.id) : null;
      const label = termination?.customer_label || cable?.customer_label || port.termination_customer_label || port.cable_customer_label || null;
      const hasCustomerTermination = Boolean(termination || cable?.customer_id || label || (cable?.cable_type === 'drop' && core?.status === 'in_use'));
      return {
        splitter_id: splitter.id,
        splitter_name: splitter.name ?? null,
        port_number: Number(port.port_number),
        output_core_id: port.output_core_id ?? null,
        output_splitter_id: port.output_splitter_id ?? null,
        core_status: core?.status ?? null,
        customer_label: label,
        has_customer_termination: hasCustomerTermination,
        port,
        splitter,
        core,
      };
    }));
}

function powerBaseForPort(snapshot, topology, opticalPath, port) {
  const chain = splitterChainToPort(snapshot, port.splitter_id);
  if (!chain.known) return { known: false, reason: chain.reason };
  const states = opticalPath.states || [];
  let best = null;
  const cache = new Map();
  for (const state of states) {
    const connection = connectionPath(snapshot, topology.enclosure.id, state.core_id, chain.input_core_id, cache);
    if (connection.unknown) return { known: false, reason: connection.reason };
    if (!connection.found) continue;
    const expanded = stateWithParts(state, connection.parts);
    const splitterLossDb = chain.splitters.reduce((sum, splitter) => sum + Number(splitter.loss_db), 0);
    const candidate = {
      ...expanded,
      splitters: [...expanded.splitters, ...chain.splitters],
      loss_db: expanded.loss_db + splitterLossDb,
    };
    if (!best || candidate.loss_db < best.loss_db) best = candidate;
  }
  return best ? { known: true, state: best, chain } : { known: false, reason: 'NO_CORE_CONNECTION' };
}

async function findPortRemediation(enclosureId, customerLocation, options = {}) {
  if (enclosureId && typeof enclosureId === 'object') {
    const args = enclosureId;
    options = customerLocation || {};
    enclosureId = args.enclosure_id;
    customerLocation = args.customer_location;
  }
  const deps = readOptions(options);
  const snapshot = await getSnapshot(deps);
  const target = (snapshot.enclosures || []).find((row) => row.id === enclosureId);
  if (!target) return { status: 'not_found', enclosure_id: enclosureId, candidates: [] };

  // Tier 1 is local and does not require a headend or a customer coordinate.
  const sameEnclosure = freePortCandidates(snapshot, enclosureId);
  if (sameEnclosure.length) {
    return {
      status: 'ok',
      enclosure_id: enclosureId,
      tier: 1,
      candidates: sameEnclosure.map((candidate) => ({ ...candidate, tier: 1, requires_review: false })),
    };
  }

  const topology = resolveTopology(snapshot, enclosureId);
  const radius = deps.maxSearchDistanceM;
  if (topology.known) {
    const nearby = searchDownstream(snapshot, topology, enclosureId, {
      maxHops: Math.max(1, (snapshot.enclosures || []).length),
      maxDistanceM: radius,
    });
    const tierTwo = [];
    for (const candidate of nearby) {
      const optionsAtCandidate = freePortCandidates(snapshot, candidate.enclosure_id);
      if (!optionsAtCandidate.length) continue;
      const candidateTopology = resolveTopology(snapshot, candidate.enclosure_id);
      if (!candidateTopology.known || candidateTopology.headend.id !== topology.headend.id) continue;
      const opticalPath = buildOpticalPathToEnclosure(snapshot, candidateTopology);
      if (!opticalPath.known) continue;
      const candidateEnclosure = candidateTopology.enclosure;
      for (const port of optionsAtCandidate) {
        // A free output port is not a usable remote option unless its splitter
        // input is actually reachable from the documented path at this box.
        const feed = powerBaseForPort(snapshot, candidateTopology, opticalPath, port);
        if (!feed.known) continue;
        tierTwo.push({
          ...port,
          tier: 2,
          enclosure_id: candidate.enclosure_id,
          hops: candidate.hops,
          distance_m: round2(candidate.distance_m),
          path: candidate.path.map((edge) => ({ cable_id: edge.cable_id, cable_code: edge.cable?.code ?? null })),
          existing_core_path_valid: true,
          source_core_id: feed.state.core_id,
          splitter_input_core_id: feed.chain.input_core_id,
          requires_review: false,
          candidate_location: snapshotLocation(candidateEnclosure),
        });
      }
    }
    tierTwo.sort((a, b) => a.distance_m - b.distance_m || a.hops - b.hops || String(a.splitter_id).localeCompare(String(b.splitter_id)) || a.port_number - b.port_number);
    if (tierTwo.length) {
      return { status: 'ok', enclosure_id: enclosureId, tier: 2, candidates: tierTwo };
    }
  }

  const occupiedPorts = occupiedPortDetails(snapshot, enclosureId);
  const nonServing = occupiedPorts.filter((item) =>
    item.splitter?.disabled === false &&
    item.port?.disabled === false &&
    item.port?.status === 'active' &&
    item.output_core_id &&
    item.core_status === 'in_use' &&
    !item.has_customer_termination,
  );
  if (!nonServing.length) {
    return {
      status: 'manual_review_required',
      enclosure_id: enclosureId,
      tier: 3,
      candidates: [],
      reason: 'cascade possible but requires selecting a port to sacrifice manually',
      occupied_ports: occupiedPorts.map(({ port, splitter, core, ...row }) => row),
      requires_review: true,
      ...(topology.known ? {} : { issue: topologyError(topology) }),
    };
  }

  const location = normalizedLocation(customerLocation);
  if (!location) {
    return {
      status: 'needs_input',
      enclosure_id: enclosureId,
      tier: 3,
      candidates: [],
      reason: 'customer location is required to calculate the cascade loss impact',
      occupied_ports: nonServing.map(({ port, splitter, core, ...row }) => row),
      requires_review: true,
    };
  }
  if (!topology.known) {
    return { status: 'unknown', enclosure_id: enclosureId, tier: 3, candidates: [], issue: topologyError(topology) };
  }
  const opticalPath = buildOpticalPathToEnclosure(snapshot, topology);
  if (!opticalPath.known) {
    return { status: 'unknown', enclosure_id: enclosureId, tier: 3, candidates: [], issue: { type: 'UNKNOWN_TOPOLOGY', reason: opticalPath.reason } };
  }
  const drop = customerDropSegment(target, location);
  if (!drop) {
    return { status: 'unknown', enclosure_id: enclosureId, tier: 3, candidates: [], issue: { type: 'UNKNOWN_TOPOLOGY', reason: 'ENCLOSURE_LOCATION_UNKNOWN' } };
  }
  const connectors = connectorCountForEnclosures(snapshot, opticalPath.route_enclosure_ids);
  if (!connectors.known) {
    return {
      status: 'unknown',
      enclosure_id: enclosureId,
      tier: 3,
      candidates: [],
      issue: {
        type: 'UNKNOWN_TOPOLOGY',
        reason: connectors.reason,
        missing: connectors.missing,
        missing_enclosure_ids: connectors.missing_enclosure_ids,
      },
      requires_review: true,
    };
  }

  const candidates = [];
  let lossIssue = null;
  for (const sacrificed of nonServing) {
    const parent = powerBaseForPort(snapshot, topology, opticalPath, sacrificed);
    if (!parent.known) continue;
    for (const [ratio, insertionLoss] of Object.entries(SPLITTER_INSERTION_LOSS_DB)) {
      const state = {
        ...parent.state,
        splitters: [...parent.state.splitters, {
          id: null,
          split_count: Number(ratio),
          insertion_loss_db: insertionLoss,
          loss_db: insertionLoss,
          proposed: true,
        }],
      };
      const budget = fullBudgetForState(state, topology.budget_db, drop, SAFETY_MARGIN_DB, connectors.connector_count);
      if (!budget.known) {
        lossIssue ||= {
          type: 'UNKNOWN_TOPOLOGY',
          reason: budget.detail || budget.reason || 'LOSS_DATA_INCOMPLETE',
          ...(budget.missing ? { missing: budget.missing } : {}),
        };
        continue;
      }
      candidates.push({
        type: 'cascade_splitter',
        tier: 3,
        enclosure_id: enclosureId,
        splitter_id: sacrificed.splitter_id,
        port_number: sacrificed.port_number,
        sacrificed_core_id: sacrificed.output_core_id,
        customer_label: sacrificed.customer_label,
        new_split_count: Number(ratio),
        insertion_loss_db: insertionLoss,
        total_loss_db: budget.total_loss_db,
        margin_db: budget.margin_db,
        severity: severityForMargin(budget.margin_db),
        requires_review: true,
        budget,
      });
    }
  }
  candidates.sort((a, b) => a.margin_db - b.margin_db || a.port_number - b.port_number || a.new_split_count - b.new_split_count);
  return {
    status: candidates.length ? 'ok' : 'unknown',
    enclosure_id: enclosureId,
    tier: 3,
    candidates,
    ...(candidates.length ? {} : { reason: lossIssue?.reason || 'cascade loss impact could not be calculated from the documented path' }),
    ...(!candidates.length && lossIssue ? { issue: lossIssue } : {}),
    requires_review: true,
  };
}

function cableById(snapshot, id) {
  return (snapshot.cables || []).find((cable) => cable.id === id) || null;
}

function chooseCoreEnclosure(snapshot, core, explicitEnclosureId = null) {
  if (explicitEnclosureId) {
    return (snapshot.enclosures || []).find((row) => row.id === explicitEnclosureId) || null;
  }
  const cable = cableById(snapshot, core.cable_id);
  if (!cable) return null;
  if (cable.cable_type === 'drop') {
    return (snapshot.enclosures || []).find((row) => row.id === cable.from_enclosure_id) || null;
  }
  const from = (snapshot.enclosures || []).find((row) => row.id === cable.from_enclosure_id);
  const to = (snapshot.enclosures || []).find((row) => row.id === cable.to_enclosure_id);
  if (!from || !to) return null;
  const fromTopology = resolveTopology(snapshot, from.id);
  const toTopology = resolveTopology(snapshot, to.id);
  if (!fromTopology.known || !toTopology.known || fromTopology.headend.id !== toTopology.headend.id) return null;
  const fromDepth = fromTopology.depth.get(from.id);
  const toDepth = toTopology.depth.get(to.id);
  if (fromDepth === toDepth) return null;
  return toDepth > fromDepth ? to : from;
}

function customerLocationForCore(snapshot, core) {
  const cable = cableById(snapshot, core.cable_id);
  const termination = (snapshot.terminations || []).find((row) => row.core_id === core.id);
  const customerId = termination?.customer_id || cable?.customer_id;
  if (!customerId) return null;
  const customer = (snapshot.customers || []).find((row) => row.id === customerId);
  return snapshotLocation(customer);
}

function currentPathForCore(snapshot, enclosure, topology, opticalPath, core) {
  const cable = cableById(snapshot, core.cable_id);
  const dropCable = cable?.cable_type === 'drop';
  const drop = dropCable ? fiberSegmentForDrop(cable) : null;
  const port = (snapshot.ports || []).find((row) => row.output_core_id === core.id);
  const cache = new Map();
  if (port) {
    const parent = powerBaseForPort(snapshot, topology, opticalPath, port);
    if (parent.known) return { state: parent.state, drop, drop_missing: dropCable && !drop };
  }
  const exact = (opticalPath.states || []).find((state) => state.core_id === core.id);
  if (exact) return { state: exact, drop, drop_missing: dropCable && !drop };
  for (const state of opticalPath.states || []) {
    const connection = connectionPath(snapshot, enclosure.id, state.core_id, core.id, cache);
    if (connection.found) return { state: stateWithParts(state, connection.parts), drop, drop_missing: dropCable && !drop };
  }
  return null;
}

function fiberSegmentForDrop(cable) {
  const length = numeric(cable?.length_m);
  if (length == null || length < 0) return null;
  return {
    cable_id: cable.id,
    length_m: length,
    attenuation_db_per_km: numeric(cable.attenuation_db_per_km) ?? DEFAULT_FIBER_ATTENUATION_DB_PER_KM,
  };
}

function serviceOptionsAt(snapshot, enclosure, topology, opticalPath, customerLocation) {
  const options = [];
  const states = opticalPath.states || [];
  const drop = customerDropSegment(enclosure, customerLocation);
  if (!drop) return { known: false, reason: 'CUSTOMER_LOCATION_UNAVAILABLE', options: [] };
  const connectors = connectorCountForEnclosures(snapshot, opticalPath.route_enclosure_ids);
  if (!connectors.known) return { known: false, reason: connectors.reason, missing: connectors.missing, missing_enclosure_ids: connectors.missing_enclosure_ids, options: [] };

  const spareCores = spareCoresAt(snapshot, enclosure.id);
  for (const spareCore of spareCores) {
    for (const base of states) {
      const state = base.core_id === spareCore.id
        ? { ...base, service_type: 'spare_core', spare_core: spareCore }
        : {
            ...base,
            service_type: 'spare_core',
            spare_core: spareCore,
            splices: [...base.splices, { splice_id: null, loss_db: DEFAULT_SPLICE_LOSS_DB, proposed: true }],
            loss_db: base.loss_db + DEFAULT_SPLICE_LOSS_DB,
          };
      const budget = fullBudgetForState(state, topology.budget_db, drop, SAFETY_MARGIN_DB, connectors.connector_count);
      if (budget.known) options.push({ service_type: 'spare_core', state, budget });
    }
  }

  const cache = new Map();
  for (const splitter of splittersAt(snapshot, enclosure.id).filter((row) => row.disabled === false)) {
    const chain = splitterChainToPort(snapshot, splitter.id);
    if (!chain.known) continue;
    for (const port of splitter.ports.filter(isFreePort)) {
      let best = null;
      for (const state of states) {
        const connection = connectionPath(snapshot, enclosure.id, state.core_id, chain.input_core_id, cache);
        if (!connection.found) continue;
        const connected = stateWithParts(state, connection.parts);
        const totalSplitterLoss = chain.splitters.reduce((sum, row) => sum + Number(row.loss_db), 0);
        const candidateState = {
          ...connected,
          splitters: [...connected.splitters, ...chain.splitters],
          loss_db: connected.loss_db + totalSplitterLoss,
        };
        if (!best || candidateState.loss_db < best.loss_db) best = candidateState;
      }
      if (!best) continue;
      const budget = fullBudgetForState(best, topology.budget_db, drop, SAFETY_MARGIN_DB, connectors.connector_count);
      if (budget.known) options.push({ service_type: 'splitter_port', splitter_id: splitter.id, port_number: port.port_number, state: best, budget });
    }
  }
  return { known: true, drop, options };
}

async function findPowerRemediation(enclosureId, customerLocation, requiredMarginDb = SAFETY_MARGIN_DB, options = {}) {
  if (enclosureId && typeof enclosureId === 'object') {
    const args = enclosureId;
    options = customerLocation || {};
    enclosureId = args.enclosure_id;
    customerLocation = args.customer_location;
    requiredMarginDb = args.required_margin_db ?? SAFETY_MARGIN_DB;
  }
  const deps = readOptions(options);
  const snapshot = await getSnapshot(deps);
  const target = (snapshot.enclosures || []).find((row) => row.id === enclosureId);
  if (!target) return { status: 'not_found', enclosure_id: enclosureId, candidates: [] };
  const location = normalizedLocation(customerLocation);
  if (!location) {
    return {
      status: 'needs_input',
      enclosure_id: enclosureId,
      required_margin_db: Number(requiredMarginDb),
      candidates: [],
      reason: 'customer location is required to calculate complete candidate path loss',
      olt_optics_review_suggested: false,
    };
  }
  const requiredMargin = numeric(requiredMarginDb) ?? SAFETY_MARGIN_DB;
  if (requiredMargin < 0) return { status: 'error', error: 'required_margin_db must be non-negative', candidates: [] };

  const topology = resolveTopology(snapshot, enclosureId);
  if (!topology.known) {
    return { status: 'unknown', enclosure_id: enclosureId, candidates: [], issue: topologyError(topology), olt_optics_review_suggested: false };
  }
  const opticalPath = buildOpticalPathToEnclosure(snapshot, topology);
  if (!opticalPath.known) {
    return { status: 'unknown', enclosure_id: enclosureId, candidates: [], issue: { type: 'UNKNOWN_TOPOLOGY', reason: opticalPath.reason }, olt_optics_review_suggested: false };
  }
  const currentStates = opticalPath.states || [];
  const currentDrop = customerDropSegment(target, location);
  const currentCore = deps.currentCoreId
    ? (snapshot.cores || []).find((core) => core.id === deps.currentCoreId)
    : null;
  const actualCurrentPath = currentCore
    ? currentPathForCore(snapshot, target, topology, opticalPath, currentCore)
    : null;
  const currentState = actualCurrentPath?.state || (currentCore ? null : currentStates[0]);
  const currentDropSegment = actualCurrentPath?.drop || currentDrop;
  if (!currentState || !currentDropSegment || actualCurrentPath?.drop_missing) {
    return {
      status: 'unknown',
      enclosure_id: enclosureId,
      candidates: [],
      issue: {
        type: 'UNKNOWN_TOPOLOGY',
        reason: actualCurrentPath?.drop_missing ? 'DROP_LENGTH_UNKNOWN' : currentDropSegment ? 'NO_OPTICAL_PATH_TO_ENCLOSURE' : 'ENCLOSURE_LOCATION_UNKNOWN',
      },
      olt_optics_review_suggested: false,
    };
  }
  const currentConnectors = connectorCountForEnclosures(snapshot, opticalPath.route_enclosure_ids);
  if (!currentConnectors.known) {
    return {
      status: 'unknown',
      enclosure_id: enclosureId,
      candidates: [],
      issue: {
        type: 'UNKNOWN_TOPOLOGY',
        reason: currentConnectors.reason,
        missing: currentConnectors.missing,
        missing_enclosure_ids: currentConnectors.missing_enclosure_ids,
      },
      olt_optics_review_suggested: false,
    };
  }
  const currentBudget = fullBudgetForState(currentState, topology.budget_db, currentDropSegment, SAFETY_MARGIN_DB, currentConnectors.connector_count);
  if (!currentBudget.known) {
    return {
      status: 'unknown',
      enclosure_id: enclosureId,
      candidates: [],
      issue: {
        type: 'UNKNOWN_TOPOLOGY',
        reason: currentBudget.detail || currentBudget.reason,
        ...(currentBudget.missing ? { missing: currentBudget.missing } : {}),
      },
      olt_optics_review_suggested: false,
    };
  }

  const center = location || snapshotLocation(target);
  const nearby = searchDownstream(snapshot, topology, enclosureId, {
    maxHops: Math.max(1, (snapshot.enclosures || []).length),
    maxDistanceM: deps.maxSearchDistanceM,
    includeTarget: true,
  });
  const candidateRows = [];
  const informational = [];
  for (const nearbyCandidate of nearby) {
    const candidateEnclosure = (snapshot.enclosures || []).find((row) => row.id === nearbyCandidate.enclosure_id);
    const candidatePoint = snapshotLocation(candidateEnclosure);
    const distanceToCustomer = center && candidatePoint ? haversineMeters(center, candidatePoint) : nearbyCandidate.distance_m;
    if (distanceToCustomer == null || distanceToCustomer > deps.maxSearchDistanceM) continue;
    const candidateTopology = resolveTopology(snapshot, nearbyCandidate.enclosure_id);
    if (!candidateTopology.known || candidateTopology.headend.id !== topology.headend.id) continue;
    const candidatePath = buildOpticalPathToEnclosure(snapshot, candidateTopology);
    if (!candidatePath.known) continue;
    const serviceOptions = serviceOptionsAt(snapshot, candidateEnclosure, candidateTopology, candidatePath, location);
    if (!serviceOptions.known) continue;
    for (const option of serviceOptions.options) {
      const candidate = {
        type: option.service_type,
        enclosure_id: nearbyCandidate.enclosure_id,
        splitter_id: option.splitter_id ?? null,
        port_number: option.port_number ?? null,
        core_id: option.state.core_id ?? null,
        hops: nearbyCandidate.hops,
        distance_m: round2(distanceToCustomer),
        total_loss_db: option.budget.total_loss_db,
        margin_db: option.budget.margin_db,
        severity: severityForMargin(option.budget.margin_db, SAFETY_MARGIN_DB),
        meets_required_margin: option.budget.margin_db >= requiredMargin,
        requires_review: false,
        budget: option.budget,
      };
      if (candidate.total_loss_db > currentBudget.total_loss_db) {
        informational.push({
          ...candidate,
          not_an_improvement: true,
          is_improvement: false,
        });
      } else if (candidate.meets_required_margin) {
        candidateRows.push({ ...candidate, is_improvement: true });
      } else {
        informational.push(candidate);
      }
    }
  }

  candidateRows.sort((a, b) => b.margin_db - a.margin_db || a.hops - b.hops || a.distance_m - b.distance_m);
  informational.sort((a, b) => b.margin_db - a.margin_db || a.hops - b.hops || a.distance_m - b.distance_m);
  if (!candidateRows.length) {
    return {
      status: 'ok',
      enclosure_id: enclosureId,
      required_margin_db: requiredMargin,
      current_path: currentBudget,
      candidates: [],
      ...(informational.length ? { informational_candidates: informational } : {}),
      reason: 'no path meets required margin within search limits',
      olt_optics_review_suggested: true,
      search_radius_m: deps.maxSearchDistanceM,
    };
  }
  return {
    status: 'ok',
    enclosure_id: enclosureId,
    required_margin_db: requiredMargin,
    current_path: currentBudget,
    candidates: candidateRows,
    ...(informational.length ? { informational_candidates: informational } : {}),
    olt_optics_review_suggested: false,
    search_radius_m: deps.maxSearchDistanceM,
  };
}

async function findPowerRemediationForCore(args = {}, options = {}) {
  const deps = readOptions(options);
  const snapshot = await getSnapshot(deps);
  const core = (snapshot.cores || []).find((row) => row.id === args.core_id);
  if (!core) return { status: 'not_found', core_id: args.core_id, candidates: [] };
  const target = chooseCoreEnclosure(snapshot, core, args.enclosure_id);
  if (!target) {
    return { status: 'unknown', core_id: core.id, candidates: [], issue: { type: 'UNKNOWN_TOPOLOGY', reason: 'CORE_ENCLOSURE_UNRESOLVED' }, olt_optics_review_suggested: false };
  }
  const customerLocation = normalizedLocation(args.customer_location) || customerLocationForCore(snapshot, core);
  if (!customerLocation) {
    return {
      status: 'needs_input',
      core_id: core.id,
      enclosure_id: target.id,
      candidates: [],
      reason: 'customer location is not recorded for this core; supply the customer coordinates before calculating remediation loss',
      olt_optics_review_suggested: false,
    };
  }
  return findPowerRemediation(target.id, customerLocation, args.required_margin_db ?? SAFETY_MARGIN_DB, { ...deps, snapshot, currentCoreId: core.id });
}

module.exports = {
  findCoreRemediation,
  findPortRemediation,
  findPowerRemediation,
  findPowerRemediationForCore,
  severityForMargin,
  freePortCandidates,
  occupiedPortDetails,
  serviceOptionsAt,
};
