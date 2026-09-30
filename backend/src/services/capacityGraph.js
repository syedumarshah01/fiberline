const db = require('../db');

// Available core count "at" an enclosure = free cores on any cable (not drop)
// that lands at that enclosure, either end. This is what a tech could actually
// splice into if they opened that box today.
async function getAvailableCoreCounts() {
  const rows = await db.raw(`
    SELECT e.id AS enclosure_id, COUNT(fc.id) AS available_cores
    FROM enclosures e
    LEFT JOIN cables c
      ON (c.from_enclosure_id = e.id OR c.to_enclosure_id = e.id)
      AND c.cable_type != 'drop'
    LEFT JOIN fiber_cores fc
      ON fc.cable_id = c.id AND fc.status = 'available'
    GROUP BY e.id
  `);
  const map = {};
  for (const r of rows.rows) map[r.enclosure_id] = parseInt(r.available_cores, 10);
  return map;
}

/**
 * The count above is useful for map badges, but an installation plan needs the
 * exact core and cable. Keep this query next to the count so both definitions of
 * "available" stay identical.
 */
async function getAvailableCoreOptions(enclosureIds = null) {
  const query = db('fiber_cores as fc')
    .join('cables as c', 'c.id', 'fc.cable_id')
    .where('fc.status', 'available')
    .whereNot('c.cable_type', 'drop')
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
      attenuation_db_per_km:
        row.attenuation_db_per_km == null ? null : Number(row.attenuation_db_per_km),
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

// Build an undirected adjacency list of enclosures connected by feeder/distribution cables
async function buildGraph() {
  const cables = await db('cables')
    .whereIn('cable_type', ['feeder', 'distribution'])
    .whereNotNull('to_enclosure_id')
    .select('id', 'code', 'from_enclosure_id', 'to_enclosure_id', 'length_m', 'attenuation_db_per_km');

  const adjacency = {};
  for (const cable of cables) {
    const { from_enclosure_id: a, to_enclosure_id: b } = cable;
    if (!adjacency[a]) adjacency[a] = [];
    if (!adjacency[b]) adjacency[b] = [];
    const edge = {
      cableId: cable.id,
      cableCode: cable.code,
      lengthM: cable.length_m == null ? null : Number(cable.length_m),
      attenuationDbPerKm:
        cable.attenuation_db_per_km == null ? null : Number(cable.attenuation_db_per_km),
    };
    adjacency[a].push({ neighbor: b, ...edge });
    adjacency[b].push({ neighbor: a, ...edge });
  }
  return adjacency;
}

/**
 * Starting at the target box, BFS outward hop-by-hop across physically connected
 * boxes and return the nearest one with a spare core and the ordered cable path.
 * This remains the one graph traversal used by customer planning; the planner
 * only adds the exact source core and physical labels to its result.
 */
async function findNearestSource(targetEnclosureId, { excludeSelf = true } = {}) {
  const [adjacency, capacity] = await Promise.all([buildGraph(), getAvailableCoreCounts()]);

  const queue = [{ enclosureId: targetEnclosureId, path: [] }];
  const visited = new Set([targetEnclosureId]);

  while (queue.length) {
    const { enclosureId, path } = queue.shift();

    const hasCapacity = (capacity[enclosureId] || 0) > 0;
    const isCandidate = hasCapacity && !(excludeSelf && enclosureId === targetEnclosureId);
    if (isCandidate) {
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
        path: [
          ...path,
          {
            cable_id: edge.cableId,
            cable_code: edge.cableCode,
            length_m: edge.lengthM,
            attenuation_db_per_km: edge.attenuationDbPerKm,
            from_enclosure_id: enclosureId,
            to_enclosure_id: edge.neighbor,
          },
        ],
      });
    }
  }

  return { found: false, message: 'No connected enclosure with spare capacity was found.' };
}

module.exports = {
  getAvailableCoreCounts,
  getAvailableCoreOptions,
  buildGraph,
  findNearestSource,
};
