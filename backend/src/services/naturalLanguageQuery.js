const db = require('../db');
const { getAvailableCoreCounts } = require('./capacityGraph');
const { simulateFailure } = require('./impactAnalysis');
const { resolveAddress } = require('./addressLookup');
const { planNetworkQuery } = require('./llmQueryPlanner');

const DEFAULT_RADIUS_M = 500;
const MAX_RADIUS_M = 10000;
const MAX_RESULTS = 100;

function cleanText(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function parseRadius(query) {
  const match = query.match(/\bwithin\s+(\d+(?:\.\d+)?)\s*(m|meter|meters|km|kilometer|kilometers)\b/i)
    || query.match(/\b(\d+(?:\.\d+)?)\s*(m|meter|meters|km|kilometer|kilometers)\b/i);
  if (!match) return DEFAULT_RADIUS_M;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const meters = unit.startsWith('km') || unit.startsWith('kilometer') ? amount * 1000 : amount;
  return Math.min(MAX_RADIUS_M, Math.max(1, Math.round(meters)));
}

function parseCoordinates(text) {
  const match = text.match(/\b(-?\d{1,3}(?:\.\d+)?)\s*[,/]\s*(-?\d{1,3}(?:\.\d+)?)\b/);
  if (!match) return null;
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng, label: `${lat}, ${lng}`, source: 'coordinates' };
}

function parsePoleTarget(query) {
  const match = query.match(/\bpole\s*(?:number|no\.?|#)?\s*([a-z0-9][a-z0-9_-]*)/i);
  return match ? match[1] : null;
}

function parseLocationText(query) {
  const coordinates = parseCoordinates(query);
  if (coordinates) return { coordinates, text: null };

  // The address follows "of" or "near" and ends before an optional capacity
  // clause. Keep this deliberately conservative: a failed address match is a
  // clarification request, never a guessed map point.
  const match = query.match(/\b(?:of|near|at)\s+(.+?)(?=\s+(?:with|that\s+has|having|and\s+(?:has|with))\b|$)/i);
  const text = cleanText(match?.[1] || '').replace(/[?.!,]+$/, '').trim();
  if (!text || /^(?:this address|the address|here)$/i.test(text)) {
    return { coordinates: null, text: null };
  }
  return { coordinates: null, text };
}

/**
 * Translate a small, explicit vocabulary into a structured graph operation.
 *
 * This is intentionally deterministic. An LLM may eventually supply this
 * structured object, but it must not be allowed to invent an asset, radius, or
 * customer set. The executor below only accepts these validated intents.
 */
function parseNaturalLanguageQuery(input) {
  const query = cleanText(input);
  if (!query) {
    return { intent: 'clarification', query, message: 'Ask about a pole outage or boxes with spare capacity near an address.' };
  }

  const outage = /\b(?:affected|outage|customers?|down|goes?\s+down|fails?|failure|offline|without\s+service)\b/i.test(query);
  const pole = parsePoleTarget(query);
  if (pole && outage) {
    return {
      intent: 'pole_outage',
      query,
      target: { kind: 'pole', text: pole },
    };
  }

  const capacity = /\b(?:spare|available|free)\s+(?:capacity|cores?|ports?)\b|\bcapacity\b/i.test(query);
  const box = /\b(?:box(?:es)?|enclosure(?:s)?|cabinet(?:s)?|nap(?:s)?)\b/i.test(query);
  const within = /\bwithin\b/i.test(query);
  if (box && within && capacity) {
    const location = parseLocationText(query);
    return {
      intent: 'nearby_capacity',
      query,
      radius_m: parseRadius(query),
      location,
      require_spare_capacity: true,
    };
  }

  return {
    intent: 'clarification',
    query,
    message: 'I can answer: “which customers are affected if pole 42 goes down?” or “show boxes within 500m of 12 Main Street with spare capacity.”',
  };
}

function normalize(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function digitPart(value) {
  const digits = String(value ?? '').match(/\d+/g);
  return digits ? digits.join('') : '';
}

function poleScore(target, pole) {
  const needle = normalize(target);
  const code = normalize(pole.code);
  const name = normalize(pole.name);
  if (!needle) return 0;
  if (code === needle || name === needle) return 1;
  if (digitPart(target) && digitPart(target) === digitPart(pole.code)) return 0.98;
  if (code.includes(needle) || name.includes(needle)) return 0.75;
  return 0;
}

async function findPole(target) {
  const result = await db.raw(`
    SELECT id, code, name, status, pole_type,
           ST_Y(location::geometry) AS lat,
           ST_X(location::geometry) AS lng
    FROM poles
    ORDER BY code
  `);
  const candidates = result.rows
    .map((pole) => ({ ...pole, score: poleScore(target, pole) }))
    .filter((pole) => pole.score > 0)
    .sort((a, b) => b.score - a.score || String(a.code).localeCompare(String(b.code)));
  if (!candidates.length) return { pole: null, candidates: [] };
  const best = candidates[0];
  const tied = candidates.filter((candidate) => candidate.score === best.score);
  return {
    pole: tied.length === 1 ? best : null,
    candidates: candidates.slice(0, 5),
  };
}

function customerKey(customer) {
  return customer.customer_id || customer.id || customer.key || customer.customer_code || customer.customer_label;
}

async function executePoleOutage(parsed) {
  const lookup = await findPole(parsed.target.text);
  if (!lookup.pole) {
    return {
      ...parsed,
      status: lookup.candidates.length ? 'needs_clarification' : 'not_found',
      message: lookup.candidates.length
        ? 'More than one pole matched. Choose a specific pole.'
        : `No pole matched “${parsed.target.text}”.`,
      candidates: lookup.candidates,
    };
  }

  const enclosures = await db('enclosures')
    .where({ pole_id: lookup.pole.id })
    .select('id', 'code', 'name', 'type');

  if (!enclosures.length) {
    return {
      ...parsed,
      status: 'ok',
      interpretation: { target: lookup.pole, failure_surface: 'all enclosures mounted on the pole' },
      answer: { affected_customers: [], affected_count: 0, affected_boxes: [], simulations: [] },
      warnings: ['This pole has no network box mounted on it, so no downstream graph impact could be simulated.'],
    };
  }

  const boxLocations = {};
  if (lookup.pole.lat != null && lookup.pole.lng != null) {
    for (const enclosure of enclosures) boxLocations[enclosure.id] = { lat: Number(lookup.pole.lat), lng: Number(lookup.pole.lng) };
  }

  const simulations = [];
  for (const enclosure of enclosures) {
    const result = await simulateFailure({
      kind: 'box',
      id: enclosure.id,
      boxIds: [enclosure.id],
      cableIds: [],
      element: { code: enclosure.code, name: enclosure.name, type: enclosure.type },
      boxLocations,
    });
    simulations.push(result);
  }

  const affectedCustomers = new Map();
  const affectedBoxes = new Map();
  const warnings = [];
  for (const simulation of simulations) {
    for (const customer of simulation.affected?.customers || []) {
      const key = customerKey(customer) || JSON.stringify(customer);
      if (!affectedCustomers.has(key)) affectedCustomers.set(key, { ...customer, key });
    }
    for (const box of simulation.affected?.boxes || []) {
      if (!affectedBoxes.has(box.id)) affectedBoxes.set(box.id, box);
    }
    warnings.push(...(simulation.warnings || []));
  }

  const customers = [...affectedCustomers.values()];
  return {
    ...parsed,
    status: 'ok',
    interpretation: {
      target: lookup.pole,
      failure_surface: 'all enclosures mounted on the pole',
      simulated_boxes: enclosures,
    },
    answer: {
      affected_customers: customers,
      affected_count: customers.length,
      affected_boxes: [...affectedBoxes.values()],
      simulations: simulations.map((simulation) => ({
        failure: simulation.failure,
        direction_source: simulation.direction_source,
        warnings: simulation.warnings,
        summary: simulation.summary,
      })),
    },
    warnings: [...new Set(warnings)],
  };
}

async function resolveQueryLocation(parsed) {
  if (parsed.location.coordinates) return parsed.location.coordinates;
  if (!parsed.location.text) return null;
  const resolved = await resolveAddress(parsed.location.text, { limit: 5 });
  return resolved.resolved ? {
    lat: Number(resolved.resolved.lat),
    lng: Number(resolved.resolved.lng),
    label: resolved.resolved.label,
    source: resolved.resolved.source,
    confidence: resolved.resolved.confidence,
    candidates: resolved.candidates,
    warnings: resolved.warnings,
  } : {
    candidates: resolved.candidates,
    warnings: resolved.warnings,
  };
}

async function executeNearbyCapacity(parsed) {
  const location = await resolveQueryLocation(parsed);
  if (location?.lat == null || location?.lng == null || !Number.isFinite(Number(location.lat)) || !Number.isFinite(Number(location.lng))) {
    return {
      ...parsed,
      status: 'needs_location',
      message: parsed.location.text
        ? `I could not place “${parsed.location.text}”. Choose a suggested address or provide coordinates.`
        : 'Add an address after “of”, for example: “within 500m of 12 Main Street”.',
      location,
    };
  }

  const radius = parsed.radius_m;
  const rows = await db.raw(`
    SELECT e.id, e.code, e.name, e.type,
           COALESCE(ST_Y(e.location::geometry), ST_Y(p.location::geometry)) AS lat,
           COALESCE(ST_X(e.location::geometry), ST_X(p.location::geometry)) AS lng,
           ST_Distance(
             COALESCE(e.location, p.location),
             ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography
           ) AS distance_m
    FROM enclosures e
    LEFT JOIN poles p ON p.id = e.pole_id
    WHERE COALESCE(e.location, p.location) IS NOT NULL
      AND ST_DWithin(
        COALESCE(e.location, p.location),
        ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography,
        ?
      )
    ORDER BY distance_m ASC
    LIMIT ?
  `, [location.lng, location.lat, location.lng, location.lat, radius, MAX_RESULTS]);

  const capacity = await getAvailableCoreCounts();
  const boxes = rows.rows.map((row) => ({
    ...row,
    distance_m: Math.round(Number(row.distance_m)),
    available_cores: Number(capacity[row.id] || 0),
  })).filter((row) => row.available_cores > 0);

  return {
    ...parsed,
    status: 'ok',
    interpretation: {
      location: { lat: location.lat, lng: location.lng, label: location.label || parsed.location.text, source: location.source },
      radius_m: radius,
      filter: 'available_cores > 0',
    },
    answer: {
      boxes,
      count: boxes.length,
      total_boxes_in_radius: rows.rows.length,
    },
    warnings: location.warnings || [],
  };
}

async function executeNaturalLanguageQuery(input, options = {}) {
  let parsed;
  if (typeof input === 'string') {
    const planned = await planNetworkQuery(input, options);
    parsed = planned
      ? { ...planned, query: cleanText(input), planner_source: 'llm' }
      : { ...parseNaturalLanguageQuery(input), planner_source: 'deterministic' };
  } else {
    parsed = input;
  }
  if (!parsed || parsed.intent === 'clarification') return parsed;
  if (parsed.intent === 'pole_outage') return executePoleOutage(parsed);
  if (parsed.intent === 'nearby_capacity') return executeNearbyCapacity(parsed);
  return { intent: 'clarification', status: 'unsupported', message: 'I do not recognize that network question yet.' };
}

module.exports = {
  DEFAULT_RADIUS_M,
  MAX_RADIUS_M,
  parseRadius,
  parseCoordinates,
  parseNaturalLanguageQuery,
  executeNaturalLanguageQuery,
  findPole,
};
