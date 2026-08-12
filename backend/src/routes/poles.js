const express = require("express");
const db = require("../db");
const { validatePoleData } = require("../middleware/validation");
const { nextCode } = require("../utils/codegen");
const router = express.Router();

// GET /api/poles  — all poles, as GeoJSON-friendly plain objects
router.get("/", async (req, res, next) => {
  try {
    const poles = await db.raw(`
      SELECT id, code, name, status, pole_type, height_m, notes,
             ST_Y(location::geometry) AS lat,
             ST_X(location::geometry) AS lng,
             created_at, updated_at
      FROM poles
      ORDER BY created_at DESC
    `);
    res.json(poles.rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/poles/:id
router.get("/:id", async (req, res, next) => {
  try {
    const result = await db.raw(
      `SELECT id, code, name, status, pole_type, height_m, notes,
              ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng,
              created_at, updated_at
       FROM poles WHERE id = ?`,
      [req.params.id],
    );
    if (!result.rows.length)
      return res.status(404).json({ error: "Pole not found" });

    const enclosures = await db("enclosures").where({ pole_id: req.params.id });
    res.json({ ...result.rows[0], enclosures });
  } catch (err) {
    next(err);
  }
});

// POST /api/poles
router.post("/", validatePoleData, async (req, res, next) => {
  try {
    const { code, name, status, pole_type, height_m, notes, lat, lng } =
      req.body;
    if (lat == null || lng == null) {
      return res.status(400).json({ error: "lat and lng are required" });
    }

    // Poles are anonymous mounting points for boxes — callers no longer
    // supply a code; auto-generate the next internal POLE-XXXX code.
    let finalCode = code;
    if (!finalCode || !String(finalCode).trim()) {
      const existing = await db("poles").select("code");
      finalCode = nextCode(existing.map((r) => r.code), "POLE-");
    }

    const normalizedName = name ?? null;
    const normalizedStatus = status ?? "active";
    const normalizedPoleType = pole_type ?? null;
    const normalizedHeight = height_m ?? null;
    const normalizedNotes = notes ?? null;

    const result = await db.raw(
      `INSERT INTO poles (code, name, status, pole_type, height_m, notes, location)
       VALUES (?, ?, COALESCE(?, 'active'), ?, ?, ?, ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography)
       RETURNING id, code, name, status`,
      [
        finalCode,
        normalizedName,
        normalizedStatus,
        normalizedPoleType,
        normalizedHeight,
        normalizedNotes,
        lng,
        lat,
      ],
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/poles/:id
router.patch("/:id", async (req, res, next) => {
  try {
    const { name, status, pole_type, height_m, notes, lat, lng } = req.body;
    const updates = { updated_at: db.fn.now() };
    if (name !== undefined) updates.name = name;
    if (status !== undefined) updates.status = status;
    if (pole_type !== undefined) updates.pole_type = pole_type;
    if (height_m !== undefined) updates.height_m = height_m;
    if (notes !== undefined) updates.notes = notes;

    await db("poles").where({ id: req.params.id }).update(updates);

    if (lat != null && lng != null) {
      await db.raw(
        `UPDATE poles SET location = ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography WHERE id = ?`,
        [lng, lat, req.params.id],
      );
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/poles/:id
// Deleting a pole CASCADEs its enclosures, but any cable attached to those
// enclosures is ON DELETE RESTRICT — without this guard the delete dies as an
// opaque 500. Fail fast with a clear 409 instead.
router.delete("/:id", async (req, res, next) => {
  try {
    const pole = await db("poles").where({ id: req.params.id }).first();
    if (!pole) return res.status(404).json({ error: "Pole not found" });

    const [cableUse] = await db("cables")
      .join("enclosures", function () {
        this.on("cables.from_enclosure_id", "=", "enclosures.id").orOn(
          "cables.to_enclosure_id",
          "=",
          "enclosures.id",
        );
      })
      .where("enclosures.pole_id", req.params.id)
      .countDistinct("cables.id as count");

    if (parseInt(cableUse.count, 10) > 0) {
      return res.status(409).json({
        error: `Pole ${pole.code} has ${cableUse.count} cable(s) attached via its enclosures. Remove the cables first.`,
      });
    }

    await db("poles").where({ id: req.params.id }).del();
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
