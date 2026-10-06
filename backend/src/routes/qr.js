/**
 * QR tags for field work.
 *
 *   GET /api/qr/svg?data=<text>&ec=M&scale=6        any text → an SVG QR code
 *   GET /api/qr/:kind/:id.svg                       a pole/box/cable/customer → its QR
 *   GET /api/qr/:kind/:id                           the same, as JSON (link + svg)
 *
 * The sticker on a pole has to point at *this* deployment, so the link is built
 * from, in order:
 *
 *   1. `?base=` — what the caller asked for (the browser passes its own origin,
 *      which is the only answer that is always right, since dev serves the app on
 *      :5173 and the API on :4000);
 *   2. `APP_BASE_URL` — for a deployment that prints labels from a script;
 *   3. the request's own origin — right when the API serves the app too,
 *      wrong exactly when it does not, hence the two options above.
 *
 * The link shape is the frontend's deep link (`?box=<uuid>`), which the app reads
 * on load and opens the documentation panel for — that is what makes a scan
 * "pull up the documentation" rather than drop the tech on a map to search.
 */
const express = require('express');
const { toSvg, fits, MAX_BYTES, QrCapacityError } = require('../utils/qr');

const router = express.Router();

const KIND_PATHS = {
  pole: 'poles',
  box: 'enclosures',
  enclosure: 'enclosures',
  cable: 'cables',
  customer: 'customers',
};
// What the frontend's deep link calls each kind.
const LINK_PARAM = { pole: 'pole', box: 'box', enclosure: 'box', cable: 'cable', customer: 'customer' };

/** Sensible defaults for a label: big enough for a phone at arm's length. */
const DEFAULTS = { scale: 6, quiet: 4, ec: 'M' };

function resolveBase(req) {
  const asked = typeof req.query.base === 'string' ? req.query.base.trim() : '';
  if (asked) return asked.replace(/\/+$/, '');
  const configured = (process.env.APP_BASE_URL || '').trim();
  if (configured) return configured.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

/** The deep link a scanned tag opens. */
function linkFor(req, kind, id) {
  const param = LINK_PARAM[String(kind).toLowerCase()];
  if (!param) return null;
  return `${resolveBase(req)}/?${param}=${encodeURIComponent(id)}`;
}

function numberIn(value, fallback, { min, max }) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.round(parsed), min), max);
}

function qrOptions(req) {
  const ec = typeof req.query.ec === 'string' ? req.query.ec.toUpperCase() : DEFAULTS.ec;
  return {
    ec,
    scale: numberIn(req.query.scale, DEFAULTS.scale, { min: 1, max: 40 }),
    quiet: numberIn(req.query.quiet, DEFAULTS.quiet, { min: 0, max: 16 }),
  };
}

function sendSvg(res, svg, { filename = null, download = false } = {}) {
  res.type('image/svg+xml');
  res.set('Cache-Control', 'public, max-age=3600');
  if (filename) {
    res.set('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${filename}"`);
  }
  return res.send(svg);
}

const slug = (value) => String(value).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60) || 'qr';

/**
 * A QR code for arbitrary text — what the browser calls, since it knows its own
 * origin and therefore the only base URL that is certainly correct.
 */
router.get('/svg', (req, res, next) => {
  try {
    const data = typeof req.query.data === 'string' ? req.query.data : '';
    if (!data.trim()) return res.status(400).json({ error: 'data is required' });
    const options = qrOptions(req);
    if (!fits(data, options)) {
      return res.status(413).json({
        error:
          `That text is too long for a QR code (${Buffer.byteLength(data)} bytes; up to ` +
          `${MAX_BYTES[options.ec] ?? MAX_BYTES.M} at level ${options.ec}). Shorten the link.`,
      });
    }
    return sendSvg(res, toSvg(data, { ...options, title: data }), {
      filename: `${slug(req.query.filename || 'qr')}.svg`,
      download: req.query.download === '1',
    });
  } catch (err) {
    if (err instanceof QrCapacityError) return res.status(413).json({ error: err.message });
    return next(err);
  }
});

/**
 * A QR tag for one thing in the network. The entity is looked up so a tag cannot
 * be printed for a box that does not exist — a sticker that scans to "not found"
 * is worse than no sticker.
 */
router.get('/:kind/:id', async (req, res, next) => {
  try {
    const kind = String(req.params.kind).toLowerCase();
    // `/box/<uuid>.svg` is the same request with a file extension on it — Express
    // hands the extension to us as part of the id, so strip it before looking the
    // entity up (otherwise every .svg tag 404s, which is exactly how a sticker
    // download breaks in the field).
    const wanted = String(req.params.id).replace(/\.svg$/i, '');
    const table = KIND_PATHS[kind];
    if (!table) {
      return res.status(400).json({
        error: `kind must be one of ${[...new Set(Object.keys(KIND_PATHS))].join(', ')}`,
      });
    }
    const link = linkFor(req, kind, wanted);
    const db = require('../db');
    const row = await db(table)
      .where({ id: wanted })
      .first(...(table === 'cables' ? ['id', 'code'] : table === 'poles' ? ['id', 'code'] : ['id', 'code', 'name']));
    if (!row) return res.status(404).json({ error: `${kind} not found` });

    const label = row.code || row.name || wanted;
    const options = qrOptions(req);
    const svg = toSvg(link, { ...options, title: `${label} — ${link}` });

    if (req.path.endsWith('.svg') || req.query.format === 'svg') {
      return sendSvg(res, svg, {
        filename: `${slug(`${kind}-${label}`)}.svg`,
        download: req.query.download === '1',
      });
    }
    return res.json({
      kind,
      id: row.id,
      code: row.code ?? null,
      name: row.name ?? null,
      link,
      svg,
      ec: options.ec,
      base_url: resolveBase(req),
    });
  } catch (err) {
    if (err instanceof QrCapacityError) return res.status(413).json({ error: err.message });
    return next(err);
  }
});

/**
 * The whole label as plain text: handy for a script that prints a sheet, and for
 * checking what a tag would say before printing fifty of them.
 */
router.get('/:kind/:id/link', async (req, res, next) => {
  try {
    const kind = String(req.params.kind).toLowerCase();
    if (!KIND_PATHS[kind]) return res.status(400).json({ error: 'unknown kind' });
    const db = require('../db');
    const table = KIND_PATHS[kind];
    const row = await db(table)
      .where({ id: String(req.params.id).replace(/\.svg$/i, '') })
      .first(...(table === 'poles' ? ['id', 'code', 'name'] : ['id', 'code', 'name']));
    if (!row) return res.status(404).json({ error: `${kind} not found` });
    res.json({
      kind,
      id: row.id,
      label: row.code || row.name || row.id,
      link: linkFor(req, kind, row.id),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.linkFor = linkFor;
module.exports.resolveBase = resolveBase;
module.exports.qrOptions = qrOptions;
