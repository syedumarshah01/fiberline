const express = require("express");
const db = require("../db");
const { validateCustomerData } = require("../middleware/validation");
const router = express.Router();

router.get("/", async (req, res, next) => {
  try {
    const rows = await db.raw(`
      SELECT id, customer_code, name, phone, email, address, status,
             ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng
      FROM customers ORDER BY created_at DESC
    `);
    res.json(rows.rows);
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const rows = await db.raw(
      `SELECT id, customer_code, name, phone, email, address, status,
              ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng
       FROM customers WHERE id = ?`,
      [req.params.id],
    );
    if (!rows.rows.length)
      return res.status(404).json({ error: "Customer not found" });

    const dropCable = await db("cables")
      .where({ customer_id: req.params.id, cable_type: "drop" })
      .first();

    res.json({ ...rows.rows[0], drop_cable: dropCable || null });
  } catch (err) {
    next(err);
  }
});

router.post("/", validateCustomerData, async (req, res, next) => {
  try {
    const { customer_code, name, phone, email, address, status, lat, lng } =
      req.body;
    if (!customer_code || !name || lat == null || lng == null) {
      return res
        .status(400)
        .json({ error: "customer_code, name, lat, lng are required" });
    }

    const normalizedPhone = phone ?? null;
    const normalizedEmail = email ?? null;
    const normalizedAddress = address ?? null;
    const normalizedStatus = status ?? "prospect";

    const result = await db.raw(
      `INSERT INTO customers (customer_code, name, phone, email, address, status, location)
       VALUES (?, ?, ?, ?, ?, COALESCE(?, 'prospect'), ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography)
       RETURNING id, customer_code, name, status`,
      [
        customer_code,
        name,
        normalizedPhone,
        normalizedEmail,
        normalizedAddress,
        normalizedStatus,
        lng,
        lat,
      ],
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", async (req, res, next) => {
  try {
    const fields = ["name", "phone", "email", "address", "status"];
    const updates = { updated_at: db.fn.now() };
    for (const f of fields)
      if (req.body[f] !== undefined) updates[f] = req.body[f];
    await db("customers").where({ id: req.params.id }).update(updates);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    await db("customers").where({ id: req.params.id }).del();
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
