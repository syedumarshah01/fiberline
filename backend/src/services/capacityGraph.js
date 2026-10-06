const db = require('../db');

function applySparePredicates(query, executor = db) {
  query.where('fc.status', 'spare')
    .whereNotExists(function () {
      this.select(executor.raw('1'))
        .from('splices as s')
        .whereRaw('s.core_a_id = fc.id OR s.core_b_id = fc.id');
    })
    .whereNotExists(function () {
      this.select(executor.raw('1')).from('terminations as t').whereRaw('t.core_id = fc.id');
    })
    .whereNotExists(function () {
      this.select(executor.raw('1')).from('splitters as s').whereRaw('s.input_core_id = fc.id');
    })
    .whereNotExists(function () {
      this.select(executor.raw('1')).from('splitter_ports as sp').whereRaw('sp.output_core_id = fc.id');
    });
  return query;
}

// The same fail-closed predicate is used by map capacity badges, customer
// planning, serviceability and remediation: explicit spare state, no splice,
// customer termination, or splitter connection. Unknown/inconsistent rows do
// not count as capacity.
async function getAvailableCoreCounts(executor = db) {
  const rows = await executor.raw(`
    SELECT e.id AS enclosure_id, COUNT(DISTINCT fc.id) AS available_cores
    FROM enclosures e
    LEFT JOIN cables c
      ON (c.from_enclosure_id = e.id OR c.to_enclosure_id = e.id)
    LEFT JOIN fiber_cores fc
      ON fc.cable_id = c.id
      AND fc.status = 'spare'
      AND NOT EXISTS (SELECT 1 FROM splices s WHERE s.core_a_id = fc.id OR s.core_b_id = fc.id)
      AND NOT EXISTS (SELECT 1 FROM terminations t WHERE t.core_id = fc.id)
      AND NOT EXISTS (SELECT 1 FROM splitters s WHERE s.input_core_id = fc.id)
      AND NOT EXISTS (SELECT 1 FROM splitter_ports sp WHERE sp.output_core_id = fc.id)
    GROUP BY e.id
  `);
  const map = {};
  for (const row of rows.rows) map[row.enclosure_id] = parseInt(row.available_cores, 10);
  return map;
}

/** Return the actual eligible spare cores at each endpoint enclosure. */
async function getAvailableCoreOptions(enclosureIds = null, executor = db) {
  const query = executor('fiber_cores as fc')
    .join('cables as c', 'c.id', 'fc.cable_id')
    .select(
      'fc.id',
      'fc.core_number',
      'fc.cable_id',
      'c.code as cable_code',
      'c.cable_type',
      'c.length_m',
      'c.attenuation_db_per_km',
      'c.from_enclosure_id',
      'c.to_enclosure_id',
    )
    .orderBy('c.code')
    .orderBy('fc.core_number');
  applySparePredicates(query, executor);

  if (Array.isArray(enclosureIds)) {
    if (!enclosureIds.length) return {};
    query.where(function () {
      this.whereIn('c.from_enclosure_id', enclosureIds).orWhereIn('c.to_enclosure_id', enclosureIds);
    });
  }

  const rows = await query;
  const options = {};
  for (const row of rows) {
    const option = {
      id: row.id,
      core_number: Number(row.core_number),
      cable_id: row.cable_id,
      cable_code: row.cable_code,
      cable_type: row.cable_type,
      length_m: row.length_m == null ? null : Number(row.length_m),
      attenuation_db_per_km: row.attenuation_db_per_km == null ? null : Number(row.attenuation_db_per_km),
      from_enclosure_id: row.from_enclosure_id,
      to_enclosure_id: row.to_enclosure_id,
    };
    for (const enclosureId of [row.from_enclosure_id, row.to_enclosure_id]) {
      if (!enclosureId || (enclosureIds && !enclosureIds.includes(enclosureId))) continue;
      (options[enclosureId] = options[enclosureId] || []).push(option);
    }
  }
  return options;
}

// Build an undirected adjacency list of active feeder/distribution cables.
async function buildGraph(executor = db) {
  const cables = await executor('cables')
    .whereIn('cable_type', ['feeder', 'distribution'])
    .where('status', 'active')
    .whereNotNull('to_enclosure_id')
    .select('id', 'code', 'from_enclosure_id', 'to_enclosure_id', 'length_m', 'attenuation_db_per_km');

  const adjacency = {};
  for (const cable of cables) {
    const { from_enclosure_id: a, to_enclosure_id: b } = cable;
    if (!a || !b || a === b) continue;
    if (!adjacency[a]) adjacency[a] = [];
    if (!adjacency[b]) adjacency[b] = [];
    const edge = {
      cableId: cable.id,
      cableCode: cable.code,
      lengthM: cable.length_m == null ? null : Number(cable.length_m),
      attenuationDbPerKm: cable.attenuation_db_per_km == null ? null : Number(cable.attenuation_db_per_km),
    };
    adjacency[a].push({ neighbor: b, ...edge });
    adjacency[b].push({ neighbor: a, ...edge });
  }
  return adjacency;
}

async function findNearestSource(targetEnclosureId, { excludeSelf = true } = {}) {
  const [adjacency, capacity] = await Promise.all([buildGraph(), getAvailableCoreCounts()]);
  const queue = [{ enclosureId: targetEnclosureId, path: [] }];
  const visited = new Set([targetEnclosureId]);
  while (queue.length) {
    const { enclosureId, path } = queue.shift();
    const hasCapacity = (capacity[enclosureId] || 0) > 0;
    if (hasCapacity && !(excludeSelf && enclosureId === targetEnclosureId)) {
      const options = await getAvailableCoreOptions([enclosureId]);
      return {
        found: true,
        source_enclosure_id: enclosureId,
        available_cores: capacity[enclosureId] || 0,
        source_core: options[enclosureId]?.[0] || null,
        hops: path.length,
        path,
      };
    }
    for (const edge of adjacency[enclosureId] || []) {
      if (visited.has(edge.neighbor)) continue;
      visited.add(edge.neighbor);
      queue.push({
        enclosureId: edge.neighbor,
        path: [...path, {
          cable_id: edge.cableId,
          cable_code: edge.cableCode,
          length_m: edge.lengthM,
          attenuation_db_per_km: edge.attenuationDbPerKm,
          from_enclosure_id: enclosureId,
          to_enclosure_id: edge.neighbor,
        }],
      });
    }
  }
  return { found: false, message: 'No connected enclosure with spare capacity was found.' };
}

module.exports = {
  applySparePredicates,
  getAvailableCoreCounts,
  getAvailableCoreOptions,
  buildGraph,
  findNearestSource,
};
