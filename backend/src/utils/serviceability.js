/**
 * "Can we serve this address?" — the answer, and the work it implies.
 *
 * The question arrives in one of two shapes and has to come back in one:
 *
 *   sales/CSR:  "customer at House 12-B, Street 4 — can we, from what box, and
 *                what will the drop cost?"
 *   field:      the same, standing at the gate with a phone.
 *
 * So the answer is built in the order the work happens, not in the order the
 * database is shaped:
 *
 *   1. which box do we serve from   — nearest box *with room* beats nearest box,
 *                                     and the API says which is which, because
 *                                     "NAP-12 is closest but full" is exactly
 *                                     what a CSR has to tell the customer;
 *   2. what the connection needs    — a free splitter port (assign it), a
 *                                     splitter that is not there yet, or
 *                                     capacity work at a box that has room;
 *   3. how far the fibre has to run — the street route when OSRM answers, the
 *                                     straight line × 1.25 when it does not,
 *                                     flagged either way; and
 *   4. what that costs              — utils/dropCost.js, with the rates it used.
 *
 * Everything here is pure: candidates, the route and the project's rates are
 * passed in. The database work (and the one network call) lives in
 * services/serviceability.js, which keeps this file testable without a
 * Postgres or an internet connection, and keeps a single place that decides.
 */

const {
  estimateDropCost,
  resolveCostModel,
  formatMoney,
  formatBand,
} = require('./dropCost');
const { wrapLine, wrapInto, labelledRow } = require('./textWrap');

/** Straight-line → street distance. Streets are not straight; this is the
 *  planning factor the whole industry quotes with, and it is always reported
 *  as an assumption rather than passed off as a measurement. */
const STRAIGHT_LINE_FACTOR = 1.25;

/** How many alternatives the answer carries. A CSR needs options, not a list. */
const MAX_ALTERNATIVES = 5;

const VERDICTS = {
  serviceable: {
    serviceable: true,
    label: 'Can serve',
    detail: 'a box is within drop range and can take the connection today',
  },
  serviceable_with_work: {
    serviceable: true,
    label: 'Can serve with work',
    detail: 'a box is within drop range but the connection needs work at the box first',
  },
  build_required: {
    serviceable: false,
    label: 'Not a standard drop — build required',
    detail: 'the nearest box is further than a drop reaches; the fibre has to be extended first',
  },
  out_of_reach: {
    serviceable: false,
    label: 'Cannot serve',
    detail: 'no box is close enough to reach with an extension',
  },
  no_network: {
    serviceable: false,
    label: 'No network nearby',
    detail: 'no box was found near this address at all',
  },
};

/**
 * What this box would have to do to take a new customer. `candidate` comes from
 * services/serviceability.js:
 *
 *   free_ports       splitter ports with nothing assigned (output_core_id and
 *                    output_splitter_id both empty — the same rule the panel
 *                    uses to call a port free)
 *   splitter_count   splitters installed in the box
 *   ports_total      all of their ports
 *   available_cores  spare fibres on the non-drop cables landing at the box
 *
 * Order matters: a free port is the cheap path; a splitter with no room or no
 * splitter at all costs a splitter; no spare fibre either means capacity work,
 * which is a different job and a different quote (survey).
 */
function connectionNeeds(candidate) {
  const freePorts = Number(candidate?.free_ports) || 0;
  if (freePorts > 0) {
    return {
      needs: 'port',
      label: 'Free splitter port available',
      detail:
        `${candidate.code} has ${freePorts} free splitter port${freePorts === 1 ? '' : 's'}` +
        (freePortNumbers(candidate).length ? ` (${freePortNumbers(candidate).join(', ')})` : ''),
    };
  }
  const splitters = Number(candidate?.splitter_count) || 0;
  if (splitters > 0) {
    return {
      needs: 'splitter',
      label: 'Splitter full',
      detail: `every port on the ${splitters === 1 ? 'splitter' : `${splitters} splitters`} in ${candidate.code} is assigned — install or replace one to free a port`,
    };
  }
  const cores = Number(candidate?.available_cores) || 0;
  if (cores > 0) {
    return {
      needs: 'splitter',
      label: 'No splitter in the box yet',
      detail: `${candidate.code} has ${cores} spare fibre${cores === 1 ? '' : 's'} but no splitter — install one to serve from here`,
    };
  }
  return {
    needs: 'capacity',
    label: 'Box is full',
    detail: `${candidate.code} has no free port and no spare fibre — capacity has to be brought in from another box`,
  };
}

/** Up to four port numbers, so a next step can name the one to assign. */
function freePortNumbers(candidate) {
  const numbers = candidate?.free_port_numbers;
  if (!Array.isArray(numbers)) return [];
  return numbers.filter((n) => Number.isFinite(Number(n))).slice(0, 4).map(Number);
}

const NEEDS_RANK = { port: 0, splitter: 1, capacity: 2 };

function withNeeds(candidate) {
  if (!candidate) return null;
  return { ...candidate, ...connectionNeeds(candidate) };
}

/**
 * Choose the box to serve from.
 *
 * `nearest` is the box a technician would walk to first — the honest answer to
 * "what's the nearest box". `recommended` is the box the connection should
 * actually be built from: the closest one that can take it, preferring a free
 * port over a splitter install over capacity work. When they differ the answer
 * carries both, which is the whole point of the call.
 */
function rankBoxes(candidates, model) {
  const list = (candidates || [])
    .filter((c) => c && c.id)
    .map(withNeeds)
    .sort((a, b) => (Number(a.distance_m) || 0) - (Number(b.distance_m) || 0));

  const nearest = list[0] || null;
  const withinDrop = list.filter((c) => (Number(c.distance_m) || 0) <= model.max_drop_m);
  const usable = withinDrop
    .filter((c) => c.needs !== 'capacity')
    .sort(
      (a, b) =>
        NEEDS_RANK[a.needs] - NEEDS_RANK[b.needs] ||
        (Number(a.distance_m) || 0) - (Number(b.distance_m) || 0),
    );

  return {
    nearest,
    recommended: usable[0] || null,
    withinDrop,
    // Boxes that could serve but are not the pick — offered as alternatives.
    alternatives: list.filter((c) => c.id !== (usable[0]?.id ?? nearest?.id)).slice(0, MAX_ALTERNATIVES),
    list,
  };
}

/**
 * Assess one address. See the file header for the flow.
 *
 * options:
 *   point       { lat, lng } — already resolved
 *   candidates  boxes with capability counts (services/serviceability.js)
 *   settings    project_settings row (or a resolved cost model)
 *   route       { length_m, coordinates, source } | null (source:
 *               'street_route' | 'straight_line')
 *   extras      { suggested_source, headend_configured, radius_m, searched_m }
 */
function assessServiceability({ point, candidates = [], settings = {}, route = null, extras = {} } = {}) {
  const model = resolveCostModel(settings);
  const ranked = rankBoxes(candidates, model);
  const warnings = [];
  const { nearest, recommended } = ranked;

  // --- the verdict -----------------------------------------------------------
  let verdict = 'no_network';
  if (nearest) {
    const nearestDistance = Number(nearest.distance_m) || 0;
    if (recommended) {
      verdict = recommended.needs === 'port' ? 'serviceable' : 'serviceable_with_work';
    } else if (nearestDistance <= model.max_drop_m) {
      // A box is close, but nothing there can take a customer.
      verdict = 'serviceable_with_work';
    } else if (nearestDistance <= model.max_extension_m) {
      verdict = 'build_required';
    } else {
      verdict = 'out_of_reach';
    }
  }

  const meta = VERDICTS[verdict];
  // Which box is this answer about? The recommended one when something there can
  // take the connection — including the capacity case, where the box is still the
  // place the work happens. For a build, there is no box that can take it yet, so
  // the answer is about the box the extension would start from: the nearest one.
  const serving =
    recommended ||
    (verdict === 'serviceable_with_work' || verdict === 'build_required' ? nearest : null);

  // --- the run of fibre ------------------------------------------------------
  const distanceToServing = serving ? Number(serving.distance_m) || 0 : nearest ? Number(nearest.distance_m) || 0 : 0;
  const measured = route && Number(route.length_m) > 0 ? Number(route.length_m) : null;
  const routeSource = measured ? route.source || 'street_route' : 'straight_line';
  const runLength = measured ?? Math.round(distanceToServing * STRAIGHT_LINE_FACTOR);

  if (!measured && distanceToServing > 0) {
    warnings.push(
      `no street route could be computed, so the run is the straight-line distance × ${STRAIGHT_LINE_FACTOR} ` +
        `(≈${Math.round(distanceToServing)} m → ${runLength} m) — treat the length as planning, not as a measurement`,
    );
  }
  if (extras.headend_configured === false) {
    warnings.push(
      'no headend (network root) is configured, so this is a distance-and-capacity answer: nothing here ' +
        'confirms the spare fibre is lit — set the root on the OLT box to include that',
    );
  }
  if (verdict === 'serviceable_with_work' && (!serving || serving.needs === 'capacity')) {
    warnings.push(
      `no box within ${model.max_drop_m} m can take a connection as it stands — capacity has to be brought in`,
    );
  }
  if (verdict === 'build_required') {
    warnings.push(
      `the nearest box is ${Math.round(distanceToServing)} m away, beyond the ${model.max_drop_m} m a drop ` +
        'reaches — the price below is an indicative extension build, not a drop quote',
    );
  }
  if (verdict === 'out_of_reach') {
    warnings.push(
      `the nearest box is ${Math.round(distanceToServing)} m away, past the ${model.max_extension_m} m limit ` +
        'this API will price — refer it to network planning',
    );
  }
  if (nearest?.outside_search_radius) {
    warnings.push(
      `no box is within the ${extras.radius_m ?? 'searched'} m search radius — ${nearest.code} is the nearest ` +
        `one on the map, ${Math.round(Number(nearest.distance_m) || 0)} m away`,
    );
  }
  if (!point || point.lat == null || point.lng == null) {
    warnings.push('the address could not be placed on the map, so no distance could be measured');
  }

  // --- the price -------------------------------------------------------------
  let quote = null;
  let extension = null;
  if (serving && (verdict === 'serviceable' || verdict === 'serviceable_with_work')) {
    quote = estimateDropCost({ drop_m: runLength, needs: serving.needs, settings });
  } else if (serving && verdict === 'build_required') {
    extension = { length_m: runLength, from_box_id: serving.id, from_box_code: serving.code };
    quote = estimateDropCost({
      drop_m: 0,
      needs: serving.needs,
      settings,
      extension_m: runLength,
    });
  }
  if (quote) quote.survey_required = quote.survey_required || verdict === 'build_required';

  // --- what to do next -------------------------------------------------------
  const nextSteps = buildNextSteps({ verdict, serving, nearest, quote, extension, model, extras });

  // --- how sure we are -------------------------------------------------------
  const confidence = confidenceFor({ verdict, routeSource, serving });
  const summary = summarise({
    verdict, serving, nearest, quote, extension, model, runLength, routeSource,
  });

  return {
    point: point ? { lat: Number(point.lat), lng: Number(point.lng) } : null,
    verdict,
    verdict_label: meta.label,
    verdict_detail: meta.detail,
    serviceable: meta.serviceable,
    serviceable_now: verdict === 'serviceable',
    requires_work: verdict === 'serviceable_with_work',
    requires_build: verdict === 'build_required' || verdict === 'out_of_reach',
    survey_required: Boolean(quote?.survey_required) || verdict === 'build_required' || verdict === 'out_of_reach',
    confidence,
    confidence_reason: confidenceReason({ verdict, routeSource, serving, nearest }),
    summary,

    nearest_box: nearest ? boxView(nearest) : null,
    recommended_box: serving ? boxView(serving) : null,
    connection: serving
      ? { needs: serving.needs, label: serving.label, detail: serving.detail }
      : null,

    distance: {
      to_nearest_m: nearest ? Math.round(Number(nearest.distance_m) || 0) : null,
      to_recommended_m: serving ? Math.round(distanceToServing) : null,
      run_m: runLength,
      run_source: routeSource,
      straight_line_m: Math.round(distanceToServing) || null,
    },
    drop: {
      length_m: runLength,
      cable_length_m: quote?.cable_length_m ?? null,
      source: routeSource,
      route: route?.coordinates || null,
    },
    extension,
    quote,
    alternatives: ranked.alternatives.map(boxView),
    suggested_source: extras.suggested_source || null,
    searched: {
      radius_m: extras.radius_m ?? null,
      boxes_seen: ranked.list.length,
      boxes_within_drop_m: ranked.withinDrop.length,
    },
    warnings,
    next_steps: nextSteps,
  };
}

function boxView(candidate) {
  return {
    id: candidate.id,
    code: candidate.code,
    name: candidate.name ?? null,
    type: candidate.type ?? null,
    lat: candidate.lat != null ? Number(candidate.lat) : null,
    lng: candidate.lng != null ? Number(candidate.lng) : null,
    distance_m: Math.round(Number(candidate.distance_m) || 0),
    free_ports: Number(candidate.free_ports) || 0,
    free_port_numbers: freePortNumbers(candidate),
    splitter_count: Number(candidate.splitter_count) || 0,
    ports_total: Number(candidate.ports_total) || 0,
    available_cores: Number(candidate.available_cores) || 0,
    needs: candidate.needs,
    ...(candidate.splitter_name ? { splitter_name: candidate.splitter_name } : {}),
    ...(candidate.outside_search_radius ? { outside_search_radius: true } : {}),
  };
}

function buildNextSteps({ verdict, serving, nearest, quote, extension, model, extras }) {
  const steps = [];
  if (verdict === 'no_network') {
    steps.push('No box was found near this address — check the address, or widen the search radius.');
    steps.push('If the address is right, this is new-build territory: hand it to network planning.');
    return steps;
  }
  if (verdict === 'out_of_reach') {
    steps.push(`Nearest box is ${nearest.code} at ${Math.round(Number(nearest.distance_m) || 0)} m — hand the address to network planning.`);
    return steps;
  }

  if (serving && serving.needs === 'port') {
    const ports = freePortNumbers(serving);
    steps.push(
      `Assign a free splitter port in ${serving.code}${ports.length ? ` (port ${ports[0]}${ports.length > 1 ? `, or ${ports.slice(1).join(', ')}` : ''})` : ''}.`,
    );
  } else if (serving && serving.needs === 'splitter') {
    steps.push(`Install a splitter in ${serving.code} — that is the work the price below adds.`);
  } else if (serving) {
    steps.push(`Bring capacity into ${serving.code}: the box has no free port and no spare fibre.`);
    if (extras.suggested_source?.source_enclosure_id) {
      steps.push(
        `Nearest box with spare capacity: ${extras.suggested_source.source_enclosure_id}` +
          (extras.suggested_source.hops ? ` (${extras.suggested_source.hops} hop${extras.suggested_source.hops === 1 ? '' : 's'} away)` : '') +
          `${extras.suggested_source.available_cores ? `, ${extras.suggested_source.available_cores} spare fibre(s)` : ''}.`,
      );
    }
  }

  if (verdict === 'build_required') {
    steps.push(
      `The run is ${extension?.length_m ?? 0} m of new build to reach the property — survey the route before quoting.`,
    );
    steps.push('Once the extension lands, the connection itself is a standard drop off the new end.');
    return steps;
  }

  const cable = quote?.cable_length_m ?? 0;
  steps.push(`Run about ${cable} m of drop cable from ${serving?.code} to the address (cut length, slack included).`);
  steps.push('Splice the drop onto the assigned port and record the splice loss.');
  steps.push('Register the customer, attach the drop cable, and confirm the light at the ONT.');
  if (quote?.survey_required) {
    steps.push(`Capacity work is needed first — survey ${serving?.code} before promising an install date.`);
  }
  return steps;
}

function confidenceFor({ verdict, routeSource, serving }) {
  if (verdict === 'no_network' || verdict === 'out_of_reach') return 'low';
  if (verdict === 'build_required') return 'low';
  if (routeSource !== 'street_route') return 'medium';
  if (serving?.needs !== 'port') return 'medium';
  return 'high';
}

function confidenceReason({ verdict, routeSource, serving, nearest }) {
  if (verdict === 'no_network') return 'nothing in the network to reason from';
  if (verdict === 'out_of_reach') return 'the answer is a negative, resting on the nearest box being far away';
  if (verdict === 'build_required') return 'a build is priced from a distance estimate, not from a design';
  if (routeSource !== 'street_route') return 'the run length is a straight-line estimate, not a street route';
  if (serving?.needs !== 'port') return 'a splitter install or capacity work is priced from planning rates';
  if (nearest && serving && nearest.id !== serving.id) {
    return 'street route measured, free port confirmed, but the serving box is not the nearest one';
  }
  return 'street route measured and a free port confirmed';
}

function summarise({ verdict, serving, nearest, quote, extension, model, runLength, routeSource }) {
  const where = serving || nearest;
  if (verdict === 'no_network') return 'No box found near this address.';
  if (verdict === 'out_of_reach') {
    return `Cannot serve — nearest box ${nearest.code} is ${Math.round(Number(nearest.distance_m) || 0)} m away.`;
  }
  const price = quote ? `${formatBand(quote.band, quote.currency)}` : null;
  const lengthNote = routeSource === 'street_route' ? '' : ' (straight-line estimate)';
  if (verdict === 'build_required') {
    return (
      `Build required — nearest box ${where.code} is ${Math.round(Number(where.distance_m) || 0)} m away` +
      `${extension ? `, extension ≈ ${extension.length_m} m` : ''}${price ? `, indicative ${price}` : ''}.`
    );
  }
  const capacity = serving ? `${serving.free_ports} free port${serving.free_ports === 1 ? '' : 's'}` : 'capacity work';
  const prefix = verdict === 'serviceable' ? 'Can serve' : 'Can serve with work';
  return (
    `${prefix} — ${where.code} is ${Math.round(Number(where.distance_m) || 0)} m away (${capacity}); ` +
    `run ≈ ${runLength} m${lengthNote}${price ? `, ${price}` : ''}.`
  );
}

// --- The one-liner a CSR reads out loud --------------------------------------

/**
 * The same answer as plain text — for a phone, a WhatsApp message, or pasting
 * into the CRM against the customer's record. Not a rendering of the JSON: it is
 * written the way the CSR reads it, and it names the numbers the price came from
 * so the customer can see there is no magic in it.
 */
function serviceabilityText(result, { width = 78 } = {}) {
  if (!result) return '';
  const lines = [];
  const heading = result.query?.label || result.query?.address || result.query?.input || 'Serviceability check';
  lines.push(`SERVICEABILITY — ${heading}`);
  lines.push('='.repeat(Math.min(width, Math.max(12, heading.length + 16))));

  lines.push(labelledRow('Verdict', `${result.verdict_label} — ${result.verdict_detail}`, { width }));
  if (result.nearest_box) {
    lines.push(
      labelledRow(
        'Nearest box',
        `${result.nearest_box.code} — ${result.nearest_box.distance_m} m` +
          (result.nearest_box.free_ports ? `, ${result.nearest_box.free_ports} free port(s)` : ', no free port'),
        { width },
      ),
    );
  }
  if (result.recommended_box) {
    lines.push(
      labelledRow(
        'Serve from',
        `${result.recommended_box.code} — ${result.recommended_box.distance_m} m` +
          (result.connection ? ` (${result.connection.label.toLowerCase()})` : ''),
        { width },
      ),
    );
  }
  if (result.drop?.length_m) {
    lines.push(
      labelledRow(
        'Run',
        `${result.drop.length_m} m${result.drop.source === 'street_route' ? ' along the street' : ' straight-line estimate'}` +
          (result.drop.cable_length_m ? ` → ${result.drop.cable_length_m} m of cable with slack` : ''),
        { width },
      ),
    );
  }
  if (result.quote) {
    lines.push(
      labelledRow(
        'Price',
        `${formatBand(result.quote.band, result.quote.currency)} (typical ${formatMoney(result.quote.total, result.quote.currency)})`,
        { width },
      ),
    );
  } else {
    lines.push(labelledRow('Price', 'no quote — see the verdict', { width }));
  }

  if (result.quote?.lines?.length) {
    lines.push('');
    lines.push('Cost lines');
    for (const line of result.quote.lines) {
      const qty = `${line.quantity} ${line.unit}`;
      const amount = formatMoney(line.amount, result.quote.currency);
      const left = `${qty.padEnd(12)} ${line.item.padEnd(22)}`.trimEnd();
      const right = `${amount}`;
      // Two spaces of indent, then the row padded out to the right-hand column.
      const gap = Math.max(1, width - 2 - left.length - right.length);
      lines.push(`  ${left}${' '.repeat(gap)}${right}`);
      wrapInto(lines, line.detail, { width, indent: '      ', hanging: '      ' });
    }
  }

  if (result.next_steps?.length) {
    lines.push('');
    lines.push('Next steps');
    result.next_steps.forEach((step, index) => {
      wrapInto(lines, step, { width, indent: `  ${index + 1}. `, hanging: '     ' });
    });
  }

  if (result.warnings?.length) {
    lines.push('');
    lines.push('Notes');
    for (const warning of result.warnings) wrapInto(lines, warning, { width, indent: '  - ', hanging: '    ' });
  }

  if (result.quote?.assumptions?.length) {
    lines.push('');
    lines.push('Assumptions');
    for (const assumption of result.quote.assumptions) {
      wrapInto(lines, assumption, { width, indent: '  - ', hanging: '    ' });
    }
  }

  lines.push('');
  wrapInto(
    lines,
    `Confidence: ${result.confidence} (${result.confidence_reason}). ` +
      'Distances are planning figures until a survey.',
    { width },
  );
  return `${lines.join('\n')}\n`;
}

module.exports = {
  assessServiceability,
  connectionNeeds,
  rankBoxes,
  serviceabilityText,
  VERDICTS,
  STRAIGHT_LINE_FACTOR,
  MAX_ALTERNATIVES,
};
