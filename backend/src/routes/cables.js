const express = require("express");
const db = require("../db");
const { coordinatesToWkt } = require("../services/streetRoute");
const router = express.Router();

// GET /api/cables — includes route as [ [lng,lat], [lng,lat] ] for map drawing
router.get("/", async (req, res, next) => {
  try {
    const rows = await db.raw(`
      SELECT c.id, c.code, c.name, c.cable_type, c.core_count, c.status,
             c.from_enclosure_id, c.to_enclosure_id, c.customer_id, c.customer_label,
             c.length_m,
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

// Helper: fetch lat/lng for an enclosure (via its pole) or a customer
async function getPointFor({ enclosure_id, customer_id }) {
  if (enclosure_id) {
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
  const toPoint =
    cable_type === "drop"
      ? await getPointFor({ customer_id })
      : await getPointFor({ enclosure_id: to_enclosure_id });

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
router.post("/", async (req, res, next) => {
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
    if (cable_type === "drop" && !customer_id) {
      await trx.rollback();
      return res
        .status(400)
        .json({ error: "drop cables require a customer_id" });
    }
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
    const normalizedToEnclosureId =
      cable_type === "drop" ? null : to_enclosure_id;
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
router.delete("/:id", async (req, res, next) => {
  try {
    await db("cables").where({ id: req.params.id }).del();
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
