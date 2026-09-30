/**
 * Customer connection design endpoint.
 *
 * This route returns a physical installation plan, not a connection verdict
 * or a quote. Every response names the route/distance basis, the exact capacity
 * choice (or source path), and the optical budget for that proposed work.
 */
const express = require('express');
const { createConnectionPlan } = require('../services/connectionPlan');

const router = express.Router();

router.get('/plan', async (req, res, next) => {
  try {
    const result = await createConnectionPlan({
      address: req.query.address,
      lat: req.query.lat,
      lng: req.query.lng,
      radius_m: req.query.radius_m,
      limit: req.query.limit,
      route: req.query.route,
    });
    if (result.error) {
      return res.status(result.status || 400).json({
        error: result.error,
        address: result.address ?? null,
        point: result.point ?? null,
        candidates: result.candidates ?? [],
        warnings: result.warnings ?? [],
        hint: result.hint,
      });
    }
    return res.json(result);
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
module.exports.buildPlan = (params) => createConnectionPlan(params);
