/**
 * Pure customer connection planning.
 *
 * This module deliberately does not answer a sales yes/no question. It turns
 * the physical choices loaded by the service into an ordered work plan,
 * and keeps the optical budget beside that plan so a technician never receives
 * an unexplained connection recommendation.
 */
const {
  calculateLossBudget,
  resolveBudget,
  DEFAULT_ATTENUATION_DB_PER_KM,
} = require('./lossBudget');

const DEFAULT_NEW_SPLITTER_COUNT = 8;

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

function formatDistance(metres) {
  const value = num(metres);
  if (value == null) return 'unknown distance';
  return value >= 1000 ? `${(value / 1000).toFixed(1)} km` : `${Math.round(value)} m`;
}

/**
 * Keep the router result when it exists. When it does not, the two-point line is
 * an honest visual fallback only: it is explicitly not a street route.
 */
function routePlan(point, enclosure, streetRoute, haversine) {
  const directCoordinates = [
    [Number(point.lng), Number(point.lat)],
    [Number(enclosure.lng), Number(enclosure.lat)],
  ];

  if (streetRoute && Number.isFinite(Number(streetRoute.length_m))) {
    return {
      source: 'street_route',
      label: 'Street route',
      is_street_route: true,
      length_m: Math.round(Number(streetRoute.length_m)),
      coordinates: streetRoute.coordinates || directCoordinates,
    };
  }

  const length = typeof haversine === 'function' ? haversine(point, enclosure) : null;
  return {
    source: 'direct_haversine',
    label: 'Direct distance (haversine; not a street route)',
    is_street_route: false,
    length_m: length == null ? null : Math.round(length),
    coordinates: directCoordinates,
  };
}

function normalizePort(port) {
  if (!port) return null;
  return {
    id: port.id ?? null,
    splitter_id: port.splitter_id ?? null,
    splitter_name: port.splitter_name || port.name || null,
    port_number: num(port.port_number),
    split_count: num(port.split_count),
    loss_db: num(port.loss_db),
    input_core_id: port.input_core_id ?? null,
  };
}

function normalizeCore(core) {
  if (!core) return null;
  return {
    id: core.id ?? core.core_id ?? null,
    core_number: num(core.core_number),
    cable_id: core.cable_id ?? null,
    cable_code: core.cable_code || null,
    cable_type: core.cable_type || null,
    length_m: num(core.length_m),
    attenuation_db_per_km: num(core.attenuation_db_per_km),
  };
}

/** Choose the first deterministic physical option at the nearest enclosure. */
function chooseConnection({
  enclosure,
  splitterPorts = enclosure?.splitter_ports || [],
  availableCores = enclosure?.available_core_options || [],
  source = null,
  plannedSplitCount = DEFAULT_NEW_SPLITTER_COUNT,
} = {}) {
  const port = normalizePort(splitterPorts[0]);
  if (port) {
    return {
      type: 'splitter_port',
      label: 'Connect to an existing splitter port',
      enclosure_id: enclosure?.id ?? null,
      splitter: {
        id: port.splitter_id,
        name: port.splitter_name,
        split_count: port.split_count,
        loss_db: port.loss_db,
      },
      port,
      core: null,
      source: null,
      assumptions: [],
    };
  }

  const core = normalizeCore(availableCores[0]);
  if (core) {
    return {
      type: 'install_splitter_on_core',
      label: 'Install a splitter on an available fiber core',
      enclosure_id: enclosure?.id ?? null,
      splitter: {
        id: null,
        name: `New 1:${plannedSplitCount} splitter`,
        split_count: plannedSplitCount,
        loss_db: null,
      },
      port: { port_number: 1 },
      core,
      source: null,
      assumptions: [`The new splitter is planned as 1:${plannedSplitCount}; confirm the installed hardware loss.`],
    };
  }

  const sourceCore = normalizeCore(source?.source_core);
  return {
    type: 'bring_capacity',
    label: 'Bring spare capacity from a connected enclosure',
    enclosure_id: enclosure?.id ?? null,
    splitter: {
      id: null,
      name: `New 1:${plannedSplitCount} splitter after capacity is brought in`,
      split_count: plannedSplitCount,
      loss_db: null,
    },
    port: { port_number: 1 },
    core: null,
    source: source
      ? {
          source_enclosure_id: source.source_enclosure_id ?? null,
          source_enclosure: source.source_enclosure ?? null,
          available_cores: num(source.available_cores) ?? 0,
          source_core: sourceCore,
          hops: source.hops ?? 0,
          path: source.path ?? [],
        }
      : null,
    assumptions: source
      ? [`The new splitter is planned as 1:${plannedSplitCount}; confirm the installed hardware loss.`]
      : ['No connected enclosure with a spare core was found; network planning must choose the source path.'],
  };
}

function orderedSteps({ connection, enclosure, route }) {
  const boxLabel = enclosure?.code || enclosure?.name || enclosure?.id || 'the nearest enclosure';
  const drop = `${formatDistance(route.length_m)} ${route.is_street_route ? 'street route' : 'direct only — verify road path'}`;
  const steps = [];

  if (connection.type === 'splitter_port') {
    const splitter = connection.splitter.name || connection.splitter.id || 'identified splitter';
    steps.push(`At ${boxLabel}, assign ${splitter}, port ${connection.port.port_number}.`);
    steps.push(`Run the customer drop: ${drop}.`);
    steps.push(`Splice the drop to port ${connection.port.port_number}; test and record loss.`);
  } else if (connection.type === 'install_splitter_on_core') {
    steps.push(`At ${boxLabel}, reserve core ${connection.core.core_number} on ${connection.core.cable_code || connection.core.cable_id}.`);
    steps.push(`Install ${connection.splitter.name} on that core.`);
    steps.push(`Use new splitter port ${connection.port.port_number} for this customer.`);
    steps.push(`Run the drop: ${drop}; splice to port ${connection.port.port_number} and test.`);
  } else {
    const source = connection.source;
    if (source?.source_enclosure) {
      steps.push(`At ${source.source_enclosure.code || source.source_enclosure.id}, reserve core ${source.source_core?.core_number ?? 'identified spare'} on ${source.source_core?.cable_code || 'the source cable'}.`);
    } else {
      steps.push('Identify and reserve a spare source core before construction.');
    }
    if (source?.path?.length) {
      for (const edge of source.path) {
        steps.push(`Splice via ${edge.cable_code || edge.cable_id}: ${edge.from_code || edge.from_enclosure_id} → ${edge.to_code || edge.to_enclosure_id}.`);
      }
    } else {
      steps.push(`Document the connected cable path to ${boxLabel}.`);
    }
    steps.push(`At ${boxLabel}, install ${connection.splitter.name} and splice it to the brought-in core.`);
    steps.push(`Use port ${connection.port.port_number}; run the drop: ${drop}; test.`);
  }
  return steps;
}

function budgetStatus(totalLossDb, budget) {
  const margin = round2(budget.budget_db - totalLossDb);
  const status = margin > budget.safety_margin_db ? 'OK' : margin > 0 ? 'MARGINAL' : 'FAIL';
  return { margin_db: margin, status };
}

/**
 * Add the proposed work to an existing traced network budget. The existing
 * budget is passed in by the database service; all new components go through
 * calculateLossBudget so its attenuation/splice/splitter defaults remain the
 * single source of truth.
 */
function calculateConnectionBudget({
  settings = {},
  baseBudget = null,
  routeLengthM,
  connection,
  sourcePath = [],
  requireExistingPath = true,
} = {}) {
  const plannedHops = [];
  const splittersByCoreId = {};

  // A source path is ordered source -> target by the service. Include every
  // cable and an assumed fusion splice at each enclosure transition.
  for (const edge of sourcePath) {
    plannedHops.push({
      type: 'fiber',
      cable_id: edge.cable_id,
      cable_code: edge.cable_code,
      cable_type: edge.cable_type || 'distribution',
      length_m: num(edge.length_m),
      attenuation_db_per_km: num(edge.attenuation_db_per_km),
      core_id: `planned-source-${edge.cable_id}`,
    });
    plannedHops.push({ type: 'splice', splice_type: 'fusion', splice_id: `planned-${edge.cable_id}` });
  }

  const plannedCoreId = 'planned-customer-drop';
  if (connection?.type === 'install_splitter_on_core' || connection?.type === 'bring_capacity') {
    plannedHops.push({ type: 'splice', splice_type: 'fusion', splice_id: 'planned-splitter-input' });
    splittersByCoreId[plannedCoreId] = [connection.splitter];
  } else if (connection?.type === 'splitter_port' && connection.splitter?.id) {
    // If the traced base did not cross the existing splitter, still expose its
    // insertion loss rather than silently omitting it.
    const alreadyCounted = (baseBudget?.breakdown || []).some(
      (entry) => entry.type === 'splitter' && String(entry.splitter_id) === String(connection.splitter.id),
    );
    if (!alreadyCounted) splittersByCoreId[plannedCoreId] = [connection.splitter];
  }

  plannedHops.push({ type: 'splice', splice_type: 'fusion', splice_id: 'planned-customer-drop' });
  plannedHops.push({
    type: 'fiber',
    cable_id: 'planned-customer-drop',
    cable_code: 'Customer drop (planned)',
    cable_type: 'drop',
    core_id: plannedCoreId,
    length_m: num(routeLengthM),
    attenuation_db_per_km: DEFAULT_ATTENUATION_DB_PER_KM,
  });

  const planned = calculateLossBudget(plannedHops, {
    olt_type: settings.olt_type,
    budget_db: settings.budget_db,
    safety_margin_db: settings.safety_margin_db,
    splittersByCoreId,
  });
  const baseLoss = num(baseBudget?.total_loss_db) ?? 0;
  const totalLoss = round2(baseLoss + planned.total_loss_db);
  const budget = resolveBudget(settings);
  const result = {
    olt_type: budget.olt_type,
    budget_db: budget.budget_db,
    safety_margin_db: budget.safety_margin_db,
    total_loss_db: totalLoss,
    ...budgetStatus(totalLoss, budget),
    remaining_margin_db: round2(budget.budget_db - totalLoss),
    required_margin_db: budget.safety_margin_db,
    breakdown: [...(baseBudget?.breakdown || []), ...planned.breakdown],
    warnings: [...(baseBudget?.warnings || []), ...planned.warnings],
    assumptions: [
      ...(baseBudget ? [] : ['Existing OLT-to-enclosure path was not traceable; the total is a lower-bound estimate.']),
      ...(connection?.assumptions || []),
      'Customer drop attenuation uses the configured planning default of 0.35 dB/km.',
      routeLengthM == null ? 'Customer drop length is unknown, so this budget must be completed after a route survey.' : `Customer drop length uses ${Math.round(routeLengthM)} m of the selected route/distance.`,
    ],
    known_network_path: Boolean(baseBudget) || sourcePath.length > 0,
    consumes_required_margin: round2(budget.budget_db - totalLoss) <= budget.safety_margin_db,
    exceeds_budget: totalLoss > budget.budget_db,
    planned_loss_db: planned.total_loss_db,
    base_loss_db: baseBudget?.total_loss_db ?? null,
  };

  if (requireExistingPath && !baseBudget) {
    result.status = 'UNKNOWN';
    result.warnings.push('The proposed connection includes the drop and local hardware, but the existing OLT-to-source path is not traceable. Do not cut cable until that path is verified.');
  }
  if (result.exceeds_budget) result.warnings.push(`The proposed path exceeds the configured ${budget.budget_db} dB OLT budget by ${round2(totalLoss - budget.budget_db)} dB.`);
  else if (result.consumes_required_margin) result.warnings.push(`The proposed path leaves ${result.remaining_margin_db} dB, at or below the required ${budget.safety_margin_db} dB safety margin.`);

  return result;
}

function buildConnectionPlan({
  point,
  enclosure,
  streetRoute = null,
  haversine,
  splitterPorts,
  availableCores,
  source,
  settings,
  baseBudget,
  plannedSplitCount,
} = {}) {
  if (!point || !enclosure) {
    return { error: 'A customer point and a nearest enclosure are required.' };
  }
  const route = routePlan(point, enclosure, streetRoute, haversine);
  const connection = chooseConnection({ enclosure, splitterPorts, availableCores, source, plannedSplitCount });
  const sourcePath = connection.source?.path || [];
  const opticalBudget = calculateConnectionBudget({
    settings,
    baseBudget,
    routeLengthM: route.length_m,
    connection,
    sourcePath,
    requireExistingPath: true,
  });
  const plan = {
    customer_point: point,
    enclosure: {
      id: enclosure.id,
      code: enclosure.code,
      name: enclosure.name ?? null,
      type: enclosure.type ?? null,
      distance_m: enclosure.distance_m ?? null,
    },
    route: { ...route, route: route.coordinates },
    distance: {
      to_enclosure_m: enclosure.distance_m ?? null,
      route_m: route.length_m,
      source: route.source,
      label: route.label,
    },
    direct_distance: route.is_street_route
      ? null
      : {
          meters: route.length_m,
          method: 'haversine',
          label: route.label,
          coordinates: route.coordinates,
        },
    connection,
    optical_budget: opticalBudget,
    steps: orderedSteps({ connection, enclosure, route }),
    warnings: [
      ...(route.is_street_route ? [] : ['No street route was returned. The displayed line is a direct haversine distance, not a road path.']),
      ...(enclosure.outside_search_radius ? ['The nearest enclosure is outside the requested search radius.'] : []),
      ...opticalBudget.warnings,
    ],
  };
  return plan;
}

module.exports = {
  DEFAULT_NEW_SPLITTER_COUNT,
  formatDistance,
  routePlan,
  chooseConnection,
  orderedSteps,
  calculateConnectionBudget,
  buildConnectionPlan,
};
