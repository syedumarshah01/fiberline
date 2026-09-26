/**
 * Turning a serviceability check into what the CSR screen shows.
 *
 * Pure on purpose — no React, no fetch, no DOM — so the awkward parts (a price
 * band in a currency the app has never seen, a verdict that has to read
 * differently on a phone than in a spreadsheet, a box that is nearest but full)
 * can be tested without a browser. The panel is then just markup.
 */

/** Backend verdicts → the pill the panel shows. */
const VERDICT_VIEW = {
  serviceable: { key: 'serviceable', label: 'Can serve', tone: 'ok', short: 'Yes' },
  serviceable_with_work: { key: 'serviceable_with_work', label: 'Can serve with work', tone: 'warn', short: 'Yes, with work' },
  build_required: { key: 'build_required', label: 'Build required', tone: 'warn', short: 'Build' },
  out_of_reach: { key: 'out_of_reach', label: 'Cannot serve', tone: 'bad', short: 'No' },
  no_network: { key: 'no_network', label: 'No network nearby', tone: 'bad', short: 'No' },
};

/** `{ key, label, tone, short }` for a verdict — unknown ones read as "check". */
export function verdictView(verdict) {
  return (
    VERDICT_VIEW[verdict] || { key: 'unknown', label: 'Check required', tone: 'warn', short: 'Check' }
  );
}

const LOCALE = 'en-US';

/** `PKR 6,400` — grouped, no decimals: nobody quotes paisa on a drop. */
export function formatMoney(amount, currency = 'PKR') {
  if (amount == null || Number.isNaN(Number(amount))) return '—';
  const rounded = Math.round(Number(amount));
  return `${currency} ${rounded.toLocaleString(LOCALE)}`;
}

/** `PKR 5,900 – 7,100`, or a single figure when the band has no width. */
export function formatBand(band, currency = 'PKR') {
  if (!band) return null;
  if (band.low === band.high) return formatMoney(band.typical ?? band.low, currency);
  return `${formatMoney(band.low, currency)} – ${formatMoney(band.high, currency)}`;
}

/** `62 m`, `1.2 km` — the unit a person would say out loud. A missing distance is
 *  a dash: "0 m" reads like a measurement somebody took. */
export function formatDistance(metres) {
  if (metres == null || metres === '') return '—';
  const m = Number(metres);
  if (!Number.isFinite(m)) return '—';
  if (m >= 1000) return `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km`;
  return `${Math.round(m)} m`;
}

/**
 * What the panel says about the two boxes, because the interesting case is when
 * they differ: "NAP-12 is closest, but it is full — the connection comes from
 * NAP-14".
 */
export function boxSummary(result) {
  const nearest = result?.nearest_box || null;
  const serving = result?.recommended_box || null;
  if (!nearest && !serving) return { title: 'No box nearby', detail: null, serving, nearest, sameBox: false };
  const sameBox = Boolean(nearest && serving && nearest.id === serving.id);
  if (sameBox) {
    return {
      title: `Serve from ${serving.code} — ${formatDistance(serving.distance_m)}`,
      detail: capacityLine(serving),
      serving,
      nearest,
      sameBox: true,
    };
  }
  if (serving) {
    return {
      title: `Serve from ${serving.code} — ${formatDistance(serving.distance_m)}`,
      detail:
        `${nearest?.code} is closer (${formatDistance(nearest?.distance_m)}) but ${fullReason(nearest)}. ` +
        capacityLine(serving),
      serving,
      nearest,
      sameBox: false,
    };
  }
  return {
    title: `Nearest box ${nearest?.code} — ${formatDistance(nearest?.distance_m)}`,
    detail: capacityLine(nearest),
    serving: null,
    nearest,
    sameBox: false,
  };
}

function fullReason(box) {
  if (!box) return 'it is not usable';
  if (box.needs === 'capacity') return 'it has no free port and no spare fibre';
  if (box.needs === 'splitter') return 'its splitter ports are all taken';
  return 'it cannot take the connection';
}

function capacityLine(box) {
  if (!box) return null;
  if (box.free_ports > 0) {
    const ports = Array.isArray(box.free_port_numbers) ? box.free_port_numbers : [];
    return `${box.free_ports} free splitter port${box.free_ports === 1 ? '' : 's'}${
      ports.length ? ` (${ports.slice(0, 3).join(', ')})` : ''
    }`;
  }
  if (box.available_cores > 0) return `${box.available_cores} spare fibre${box.available_cores === 1 ? '' : 's'}`;
  return 'no free port, no spare fibre';
}

/** One line for the run: how long, and how sure we are of that length. */
export function runLine(result) {
  const drop = result?.drop;
  if (!drop || !drop.length_m) return null;
  const source = drop.source === 'street_route' ? 'along the street' : 'straight-line estimate';
  const cable = drop.cable_length_m && drop.cable_length_m !== drop.length_m
    ? ` (${drop.cable_length_m} m of cable with slack)`
    : '';
  return `${formatDistance(drop.length_m)} ${source}${cable}`;
}

/**
 * Everything the panel prints as key facts, in order, with an explicit note for
 * anything that is an estimate rather than a measurement.
 */
export function serviceabilityFacts(result) {
  if (!result) return [];
  const facts = [];
  const boxes = boxSummary(result);
  if (boxes.title) facts.push({ label: 'Serving box', value: boxes.title, detail: boxes.detail });
  const run = runLine(result);
  if (run) {
    facts.push({
      label: 'Run',
      value: run,
      detail: result.drop?.source === 'street_route' ? null : 'no street route available — measure before cutting',
    });
  }
  if (result.extension?.length_m) {
    facts.push({
      label: 'Extension',
      value: `${formatDistance(result.extension.length_m)} of new build to reach the property`,
      detail: 'a build, not a drop — survey the route before quoting',
    });
  }
  if (result.connection?.detail) facts.push({ label: 'At the box', value: result.connection.detail });
  const band = formatBand(result.quote?.band, result.quote?.currency);
  if (band) {
    facts.push({
      label: 'Estimated cost',
      value: band,
      detail: result.quote.survey_required ? 'indicative only — a survey is required' : 'labour, cable and the splice at the box',
    });
  }
  if (result.confidence) {
    facts.push({ label: 'Confidence', value: `${result.confidence}`, detail: result.confidence_reason || null });
  }
  return facts;
}

/** The box the map should fly to: the one that would serve, else the nearest. */
export function highlightBoxId(result) {
  return result?.recommended_box?.id || result?.nearest_box?.id || null;
}

/**
 * A one-line summary the panel can put at the very top — the same sentence the
 * text sheet opens with, minus the numbers it repeats below.
 */
export function headline(result) {
  if (!result) return '';
  const view = verdictView(result.verdict);
  if (result.verdict === 'no_network') return 'No box found near this address.';
  if (result.verdict === 'out_of_reach') {
    return `Cannot serve — nearest box ${result.nearest_box?.code || ''} is ${formatDistance(
      result.nearest_box?.distance_m,
    )} away.`;
  }
  const band = formatBand(result.quote?.band, result.quote?.currency);
  const box = result.recommended_box?.code || result.nearest_box?.code || '';
  return `${view.label} — ${box}${band ? `, ${band}` : ''}.`;
}

/**
 * The quote as something you can paste into a CRM or a WhatsApp message: the
 * text the API renders, fetched by the panel and handed here to be copied.
 * Kept separate so the panel never has to know the sheet's shape.
 */
export function quoteClipboardText(result) {
  const lines = [];
  if (!result) return '';
  const facts = serviceabilityFacts(result);
  lines.push(headline(result));
  for (const fact of facts) {
    lines.push(`${fact.label}: ${fact.value}${fact.detail ? ` — ${fact.detail}` : ''}`);
  }
  if (result.next_steps?.length) {
    lines.push('');
    lines.push('Next steps:');
    result.next_steps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
  }
  if (result.warnings?.length) {
    lines.push('');
    lines.push('Notes:');
    for (const warning of result.warnings) lines.push(`- ${warning}`);
  }
  return lines.join('\n');
}
