const express = require("express");
const db = require("../db");
const {
  coordinatesToWkt,
  measurePolylineMeters,
  splitRouteAtDistance,
} = require("../services/streetRoute");
const { validateCableData } = require("../middleware/validation");
const router = express.Router();

// GET /api/cables — includes route as [ [lng,lat], [lng,lat] ] for map drawing
// Also includes spliced_core_count to determine if cable should show moving dashes
router.get("/", async (req, res, next) => {
  try {
    const rows = await db.raw(`
      SELECT c.id, c.code, c.name, c.cable_type, c.core_count, c.status,
             c.from_enclosure_id, c.to_enclosure_id, c.customer_id, c.customer_label,
             c.length_m,
             (SELECT COUNT(*) FROM fiber_cores fc WHERE fc.cable_id = c.id AND fc.status = 'spliced') AS spliced_core_count,
             ST_AsGeoJSON(c.route::geometry) AS route_geojson
      FROM cables c
      ORDER BY c.created_at DESC
    `);
    const cables = rows.rows.map((c) => ({
      ...c,
      route: c.route_geojson ? JSON.parse(c.route_geojson).coordinates : null,
      route_geojson: undefined,
    }));
    res.json(cables);
  } catch (err) {
    next(err);
  }
});

// GET /api/cables/:id  — with its full list of cores
router.get("/:id", async (req, res, next) => {
  try {
    const cable = await db("cables").where({ id: req.params.id }).first();
    if (!cable) return res.status(404).json({ error: "Cable not found" });
    const cores = await db("fiber_cores")
      .where({ cable_id: req.params.id })
      .orderBy("core_number");
    res.json({ ...cable, cores });
  } catch (err) {
    next(err);
  }
});

// Helper: fetch lat/lng for an enclosure (via its pole or direct location) or a customer
async function getPointFor({ enclosure_id, customer_id }) {
  if (enclosure_id) {
    // First try to get location from the enclosure's direct location (customer enclosures)
    const directRow = await db.raw(
      `SELECT ST_X(location::geometry) AS lng, ST_Y(location::geometry) AS lat
       FROM enclosures WHERE id = ? AND location IS NOT NULL`,
      [enclosure_id],
    );
    if (directRow.rows[0]) return directRow.rows[0];
    
    // Otherwise, get location from the pole
    const row = await db.raw(
      `SELECT ST_X(p.location::geometry) AS lng, ST_Y(p.location::geometry) AS lat
       FROM enclosures e JOIN poles p ON p.id = e.pole_id WHERE e.id = ?`,
      [enclosure_id],
    );
    return row.rows[0];
  }
  if (customer_id) {
    const row = await db.raw(
      `SELECT ST_X(location::geometry) AS lng, ST_Y(location::geometry) AS lat
       FROM customers WHERE id = ?`,
      [customer_id],
    );
    return row.rows[0];
  }
  return null;
}

function normalizeRoutePoints(route_points) {
  if (!Array.isArray(route_points)) return [];

  return route_points.map((point, index) => {
    const lng = Array.isArray(point) ? point[0] : point?.lng;
    const lat = Array.isArray(point) ? point[1] : point?.lat;

    if (
      lng == null ||
      lat == null ||
      Number.isNaN(Number(lng)) ||
      Number.isNaN(Number(lat))
    ) {
      throw new Error(
        `route_points[${index}] must include numeric lng and lat`,
      );
    }

    return { lng: Number(lng), lat: Number(lat) };
  });
}

function normalizeRouteGeometry(route_geometry) {
  if (!Array.isArray(route_geometry) || route_geometry.length < 2) {
    throw new Error("route_geometry must contain at least two coordinates");
  }

  return route_geometry.map((point, index) => {
    const lng = Array.isArray(point) ? point[0] : point?.lng;
    const lat = Array.isArray(point) ? point[1] : point?.lat;

    if (
      lng == null ||
      lat == null ||
      Number.isNaN(Number(lng)) ||
      Number.isNaN(Number(lat))
    ) {
      throw new Error(
        `route_geometry[${index}] must include numeric lng and lat`,
      );
    }

    return { lng: Number(lng), lat: Number(lat) };
  });
}

function buildExactRoutePoints({ fromPoint, toPoint, route_points }) {
  const normalizedRoutePoints = normalizeRoutePoints(route_points);
  return [
    { lng: fromPoint.lng, lat: fromPoint.lat },
    ...normalizedRoutePoints,
    { lng: toPoint.lng, lat: toPoint.lat },
  ];
}

function haversineMeters(a, b) {
  const radiusMeters = 6371000;
  const toRadians = (value) => (value * Math.PI) / 180;
  const deltaLat = toRadians(b.lat - a.lat);
  const deltaLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const sinLat = Math.sin(deltaLat / 2);
  const sinLng = Math.sin(deltaLng / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  return 2 * radiusMeters * Math.asin(Math.min(1, Math.sqrt(h)));
}

function measureRouteMeters(points) {
  return points.reduce((sum, point, index) => {
    if (index === 0) return sum;
    return sum + haversineMeters(points[index - 1], point);
  }, 0);
}

async function resolveRoute(body) {
  const {
    from_enclosure_id,
    to_enclosure_id,
    customer_id,
    cable_type,
    route_points,
  } = body;

  const fromPoint = await getPointFor({ enclosure_id: from_enclosure_id });
  
  // For drop cables, try customer first, then toEnclosure (for customer enclosures)
  let toPoint;
  if (cable_type === "drop") {
    toPoint = customer_id
      ? await getPointFor({ customer_id })
      : to_enclosure_id
        ? await getPointFor({ enclosure_id: to_enclosure_id })
        : null;
  } else {
    toPoint = await getPointFor({ enclosure_id: to_enclosure_id });
  }

  if (!fromPoint || !toPoint) {
    const error = new Error(
      "Could not resolve coordinates for one of the endpoints",
    );
    error.statusCode = 400;
    throw error;
  }

  const route = buildExactRoutePoints({ fromPoint, toPoint, route_points });
  return {
    control_points: route,
    route,
    length_m: measureRouteMeters(route),
  };
}

function buildRouteFromGeometry(route_geometry, length_m) {
  const route = normalizeRouteGeometry(route_geometry);
  return {
    route,
    length_m: length_m ?? measureRouteMeters(route),
  };
}

function measureRouteMeters(route) {
  return measurePolylineMeters(route);
}

async function loadCableWithRoute(trx, cableId) {
  const dbInstance = trx || db;
  const result = await dbInstance.raw(
    `SELECT id, code, name, cable_type, core_count, status, from_enclosure_id, to_enclosure_id,
            customer_id, customer_label, length_m, notes,
            ST_AsGeoJSON(route::geometry) AS route_geojson
     FROM cables
     WHERE id = ?`,
    [cableId],
  );

  return result.rows[0] || null;
}

// ---------------------------------------------------------------------------
// GET /api/cables/:id/split-info
// Returns route metadata so the frontend can render a split-location slider.
// ---------------------------------------------------------------------------
router.get("/:id/split-info", async (req, res, next) => {
  try {
    const cable = await loadCableWithRoute(null, req.params.id);
    if (!cable) return res.status(404).json({ error: "Cable not found" });

    if (cable.cable_type === "drop") {
      return res.status(400).json({ error: "Drop cables cannot be split" });
    }

    const route = JSON.parse(cable.route_geojson).coordinates;
    const totalLengthM = measurePolylineMeters(route);

    const cores = await db("fiber_cores")
      .where({ cable_id: req.params.id })
      .orderBy("core_number")
      .select("id", "core_number", "status");

    const statusCounts = {};
    for (const c of cores) {
      statusCounts[c.status] = (statusCounts[c.status] || 0) + 1;
    }

    res.json({
      cable_id: cable.id,
      cable_code: cable.code,
      cable_type: cable.cable_type,
      core_count: cable.core_count,
      total_length_m: Math.round(totalLengthM),
      cores,
      core_summary: statusCounts,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/cables/:id/insert-enclosure
//
// Enhanced mid-span enclosure insertion:
// 1. Accepts optional `split_ratio` (0-1) or `split_distance_m` to control
//    where along the cable the new enclosure is placed. Defaults to midpoint.
// 2. Handles mixed-status cores: available cores get spliced through to the
//    downstream cable; already-spliced/terminated cores are "passed through"
//    (they keep their status and are NOT re-spliced — the downstream cable
//    gets matching cores with the same status so continuity is preserved).
// ---------------------------------------------------------------------------
router.post("/:id/insert-enclosure", async (req, res, next) => {
  const trx = await db.transaction();
  try {
    const cableId = req.params.id;
    const {
      pole_code,
      pole_name,
      pole_status = "active",
      pole_type = "wooden",
      pole_height_m = null,
      pole_notes = null,
      enclosure_code,
      enclosure_name,
      enclosure_type = "splice_closure",
      enclosure_capacity = 0,
      enclosure_status = "active",
      enclosure_mounting = "pole-mounted",
      enclosure_notes = null,
      downstream_cable_code,
      downstream_cable_name,
      // New optional parameters for split location
      split_ratio,       // 0-1, e.g. 0.3 = 30% from the start
      split_distance_m,  // absolute distance in meters from the start
    } = req.body;

    const cable = await loadCableWithRoute(trx, cableId);
    if (!cable) {
      await trx.rollback();
      return res.status(404).json({ error: "Cable not found" });
    }

    if (cable.cable_type === "drop") {
      await trx.rollback();
      return res.status(400).json({
        error: "Mid-span enclosure insertion is only supported for feeder/distribution cables",
      });
    }

    const route = JSON.parse(cable.route_geojson).coordinates;
    const totalLengthM = measurePolylineMeters(route);

    // Determine split distance: prefer split_distance_m, then split_ratio, default to midpoint
    let targetMeters;
    if (split_distance_m != null && !Number.isNaN(Number(split_distance_m))) {
      targetMeters = Math.max(0, Math.min(Number(split_distance_m), totalLengthM));
    } else if (split_ratio != null && !Number.isNaN(Number(split_ratio))) {
      targetMeters = Math.max(0, Math.min(Number(split_ratio), 1)) * totalLengthM;
    } else {
      targetMeters = totalLengthM / 2;
    }

    const split = splitRouteAtDistance(route, targetMeters);

    // Load original cores with their current status
    const originalCores = await trx("fiber_cores")
      .where({ cable_id: cableId })
      .orderBy("core_number")
      .forUpdate();

    // Separate cores into "available" (will be spliced) and "non-available" (pass-through)
    const availableCores = originalCores.filter((c) => c.status === "available");
    const passThroughCores = originalCores.filter((c) => c.status !== "available");

    // Create the new pole at the split point
    const [pole] = await trx("poles")
      .insert({
        code: pole_code,
        name: pole_name ?? null,
        status: pole_status,
        pole_type,
        height_m: pole_height_m,
        notes: pole_notes,
        location: trx.raw("ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography", [
          split.split_point.lng,
          split.split_point.lat,
        ]),
      })
      .returning("*");

    // Create the new enclosure on that pole
    const [enclosure] = await trx("enclosures")
      .insert({
        code: enclosure_code,
        name: enclosure_name ?? null,
        pole_id: pole.id,
        type: enclosure_type,
        capacity: enclosure_capacity,
        status: enclosure_status,
        mounting: enclosure_mounting,
        notes: enclosure_notes,
      })
      .returning("*");

    // Update the upstream (original) cable: now ends at the new enclosure
    await trx("cables")
      .where({ id: cableId })
      .update({
        to_enclosure_id: enclosure.id,
        length_m: split.upstream_length_m,
        route: trx.raw("ST_SetSRID(ST_GeomFromText(?), 4326)::geography", [
          coordinatesToWkt(split.upstream),
        ]),
        updated_at: trx.fn.now(),
      });

    // Create the downstream cable (from new enclosure to original destination)
    const downstreamCableCode = downstream_cable_code || `${cable.code}-B`;
    const [downstreamCable] = await trx("cables")
      .insert({
        code: downstreamCableCode,
        name: downstream_cable_name ?? cable.name,
        cable_type: cable.cable_type,
        core_count: cable.core_count,
        from_enclosure_id: enclosure.id,
        to_enclosure_id: cable.to_enclosure_id,
        customer_id: cable.customer_id,
        customer_label: cable.customer_label,
        status: cable.status,
        length_m: split.downstream_length_m,
        notes: cable.notes,
        route: trx.raw("ST_SetSRID(ST_GeomFromText(?), 4326)::geography", [
          coordinatesToWkt(split.downstream),
        ]),
      })
      .returning("*");

    // Create downstream cores matching the original core count
    const downstreamCoreRows = Array.from(
      { length: cable.core_count },
      (_, index) => ({
        cable_id: downstreamCable.id,
        core_number: index + 1,
        status: "available",
      }),
    );
    await trx("fiber_cores").insert(downstreamCoreRows);

    const downstreamCores = await trx("fiber_cores")
      .where({ cable_id: downstreamCable.id })
      .orderBy("core_number")
      .forUpdate();

    // For pass-through cores: copy the original core's status to the downstream core
    // so continuity is preserved without creating a splice record for them.
    for (const ptCore of passThroughCores) {
      const matchingDownstream = downstreamCores.find(
        (dc) => dc.core_number === ptCore.core_number
      );
      if (matchingDownstream) {
        await trx("fiber_cores")
          .where({ id: matchingDownstream.id })
          .update({
            status: ptCore.status,
            notes: ptCore.notes
              ? `Pass-through from ${cable.code} core #${ptCore.core_number}: ${ptCore.notes}`
              : `Pass-through from ${cable.code} core #${ptCore.core_number}`,
            updated_at: trx.fn.now(),
          });
      }
    }
    
    // Note: We do NOT create splices for available cores here.
    // The cores in the new enclosure remain "available" for splicing to customer drops.
    // The downstream cable cores are also "available" to match.

    await trx.commit();
    res.status(201).json({
      pole,
      enclosure,
      split_info: {
        ratio: totalLengthM > 0 ? (targetMeters / totalLengthM).toFixed(4) : 0.5,
        target_meters: Math.round(targetMeters),
        total_length_m: Math.round(totalLengthM),
        upstream_length_m: Math.round(split.upstream_length_m),
        downstream_length_m: Math.round(split.downstream_length_m),
      },
      upstream_cable: {
        ...cable,
        to_enclosure_id: enclosure.id,
        route: split.upstream,
        length_m: split.upstream_length_m,
      },
      downstream_cable: downstreamCable,
      summary: {
        total_cores: originalCores.length,
        available_cores: availableCores.length,
        pass_through_cores: passThroughCores.length,
      },
    });
  } catch (err) {
    await trx.rollback();
    next(err);
  }
});

router.post("/route-preview", async (req, res, next) => {
  try {
    const result = await resolveRoute(req.body);
    res.json({
      route: result.route,
      length_m: result.length_m,
      control_points: result.control_points,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/cables
// Creates the cable, computes its route geometry from the two endpoints, and
// auto-generates `core_count` rows in fiber_cores (all starting 'available').
// This is what req #6 depends on: every main fiber is documented core-by-core
// the moment the cable is created.
// ---------------------------------------------------------------------------
router.post("/", validateCableData, async (req, res, next) => {
  const trx = await db.transaction();
  try {
    const {
      code,
      name,
      cable_type,
      core_count,
      from_enclosure_id,
      to_enclosure_id,
      customer_id,
      customer_label,
      route_points,
      route_geometry,
      status,
      length_m,
      notes,
    } = req.body;

    if (!code || !cable_type || !core_count || !from_enclosure_id) {
      await trx.rollback();
      return res.status(400).json({
        error: "code, cable_type, core_count, from_enclosure_id are required",
      });
    }
    // Customer is optional for drop cables - can be set later
    if (cable_type === "drop" && customer_id) {
      // Validate customer exists if provided
      const customer = await trx("customers").where({ id: customer_id }).first();
      if (!customer) {
        await trx.rollback();
        return res.status(404).json({ error: "Customer not found" });
      }
    }
    // For non-drop cables, to_enclosure_id is required (can be a customer enclosure)
    if (cable_type !== "drop" && !to_enclosure_id) {
      await trx.rollback();
      return res.status(400).json({
        error: "feeder/distribution cables require a to_enclosure_id",
      });
    }

    let streetRoute;
    try {
      streetRoute = route_geometry
        ? buildRouteFromGeometry(route_geometry, length_m)
        : await resolveRoute(req.body);
    } catch (routeErr) {
      await trx.rollback();
      return res
        .status(routeErr.statusCode || 502)
        .json({ error: routeErr.message });
    }

    const normalizedName = name ?? null;
    // For drop cables, to_enclosure_id can be set (for customer enclosures)
    // or customer_id can be set (for registered customers)
    const normalizedToEnclosureId =
      cable_type === "drop" ? (to_enclosure_id ?? null) : to_enclosure_id;
    const normalizedCustomerId =
      cable_type === "drop" ? (customer_id ?? null) : null;
    const normalizedCustomerLabel = customer_label ?? null;
    const normalizedStatus = status ?? "active";
    const normalizedLength = length_m ?? streetRoute.length_m;
    const normalizedNotes = notes ?? null;

    const insertResult = await trx("cables")
      .insert({
        code,
        name: normalizedName,
        cable_type,
        core_count,
        from_enclosure_id,
        to_enclosure_id: normalizedToEnclosureId,
        customer_id: normalizedCustomerId,
        customer_label: normalizedCustomerLabel,
        status: normalizedStatus,
        length_m: normalizedLength,
        notes: normalizedNotes,
        route: trx.raw("ST_SetSRID(ST_GeomFromText(?), 4326)::geography", [
          coordinatesToWkt(streetRoute.route),
        ]),
      })
      .returning("*");
    const cable = insertResult[0];

    const coreRows = Array.from({ length: core_count }, (_, i) => ({
      cable_id: cable.id,
      core_number: i + 1,
      status: "available",
    }));
    await trx("fiber_cores").insert(coreRows);

    await trx.commit();
    res.status(201).json(cable);
  } catch (err) {
    await trx.rollback();
    next(err);
  }
});

// PATCH /api/cables/:id
router.patch("/:id", async (req, res, next) => {
  try {
    const fields = ["name", "status", "length_m", "notes", "customer_label"];
    const updates = { updated_at: db.fn.now() };
    for (const f of fields)
      if (req.body[f] !== undefined) updates[f] = req.body[f];
    await db("cables").where({ id: req.params.id }).update(updates);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/cables/:id
// Guard: fiber_cores rows CASCADE away with the cable, but splices and
// splitter references on those cores are ON DELETE RESTRICT — without this
// check the delete dies as an opaque 500 FK violation (and even when it
// "succeeds" it would silently strand splice documentation). Refuse with a
// actionable 409 instead.
router.delete("/:id", async (req, res, next) => {
  try {
    const cable = await db("cables").where({ id: req.params.id }).first();
    if (!cable) return res.status(404).json({ error: "Cable not found" });

    const referencing = await db.raw(
      `
      SELECT
        (SELECT COUNT(DISTINCT s.id) FROM splices s
           JOIN fiber_cores fc ON fc.id = s.core_a_id OR fc.id = s.core_b_id
           WHERE fc.cable_id = :cableId) AS splice_refs,
        (SELECT COUNT(*) FROM splitters sp
           JOIN fiber_cores fc ON fc.id = sp.input_core_id
           WHERE fc.cable_id = :cableId) AS splitter_input_refs,
        (SELECT COUNT(*) FROM splitter_ports pp
           JOIN fiber_cores fc ON fc.id = pp.output_core_id
           WHERE fc.cable_id = :cableId) AS splitter_port_refs
      `,
      { cableId: req.params.id },
    );

    const { splice_refs, splitter_input_refs, splitter_port_refs } = referencing.rows[0];
    const total =
      parseInt(splice_refs, 10) +
      parseInt(splitter_input_refs, 10) +
      parseInt(splitter_port_refs, 10);

    if (total > 0) {
      return res.status(409).json({
        error:
          `Cable ${cable.code} still has cores referenced by ` +
          `${splice_refs} splice(s), ${splitter_input_refs} splitter input(s) and ` +
          `${splitter_port_refs} splitter port(s). Un-splice/unassign them first.`,
      });
    }

    await db("cables").where({ id: req.params.id }).del();
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
