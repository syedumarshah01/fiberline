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

// Build an undirected adjacency list of enclosures connected by feeder/distribution cables
async function buildGraph() {
  const cables = await db('cables')
    .whereIn('cable_type', ['feeder', 'distribution'])
    .whereNotNull('to_enclosure_id')
    .select('id', 'code', 'from_enclosure_id', 'to_enclosure_id', 'length_m');

  const adjacency = {};
  for (const cable of cables) {
    const { from_enclosure_id: a, to_enclosure_id: b } = cable;
    if (!adjacency[a]) adjacency[a] = [];
    if (!adjacency[b]) adjacency[b] = [];
    adjacency[a].push({ neighbor: b, cableId: cable.id, cableCode: cable.code, lengthM: cable.length_m });
    adjacency[b].push({ neighbor: a, cableId: cable.id, cableCode: cable.code, lengthM: cable.length_m });
  }
  return adjacency;
}

/**
 * Requirement #7: starting at `targetEnclosureId` (the box with no spare
 * capacity), BFS outward hop-by-hop across physically connected boxes and
 * return the nearest one (fewest hops) that has spare cores, along with the
 * path of cables you'd need to splice through to bring a connection over.
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
      return {
        found: true,
        source_enclosure_id: enclosureId,
        available_cores: capacity[enclosureId] || 0,
        hops: path.length,
        path, // ordered list of { throughCableId, throughCableCode, enclosureId }
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
          to_enclosure_id: edge.neighbor,
        }],
      });
    }
  }

  return { found: false, message: 'No connected enclosure with spare capacity was found.' };
}

module.exports = { getAvailableCoreCounts, buildGraph, findNearestSource };
