require('dotenv').config();
const express = require('express');
const cors = require('cors');

const polesRouter = require('./routes/poles');
const enclosuresRouter = require('./routes/enclosures');
const cablesRouter = require('./routes/cables');
const customersRouter = require('./routes/customers');
const splicesRouter = require('./routes/splices');
const fiberCoresRouter = require('./routes/fiberCores');
const splittersRouter = require('./routes/splitters');
const capacityRouter = require('./routes/capacity');
const settingsRouter = require('./routes/settings');
const impactRouter = require('./routes/impact');
const headendsRouter = require('./routes/headends');
const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api/poles', polesRouter);
app.use('/api/enclosures', enclosuresRouter);
app.use('/api/cables', cablesRouter);
app.use('/api/customers', customersRouter);
app.use('/api/splices', splicesRouter);
app.use('/api/fiber-cores', fiberCoresRouter);
app.use('/api/splitters', splittersRouter);
app.use('/api/capacity', capacityRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/impact', impactRouter);
app.use('/api/headends', headendsRouter);
// Centralized error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Fiber network API listening on port ${PORT}`);
  reportSchema();
});

/**
 * Say up front when this database is behind the code, instead of letting the
 * first click on *Simulate failure* discover it. Not fatal — the features that
 * need the missing column turn themselves off and say so in their own
 * warnings (see utils/schemaCapabilities.js).
 */
async function reportSchema() {
  try {
    const { schemaCapabilities } = require('./utils/schemaCapabilities');
    const capabilities = await schemaCapabilities({ refresh: true });
    if (!capabilities.gaps.length) return;
    console.warn('---');
    console.warn(`Schema check — database "${capabilities.database}" on ${capabilities.target}`);
    for (const gap of capabilities.gaps) console.warn(`  ! ${gap.message}`);
    console.warn('---');
  } catch (err) {
    // The database may simply not be up yet; the API is still listening and the
    // usual connection error will surface on the first real request. A knex
    // connection failure is an AggregateError, which often carries no message
    // text at all — name it rather than logging a blank line.
    const reason = err.message?.trim() || err.code || err.name || 'unknown error';
    console.warn(`Schema check skipped: ${reason}`);
  }
}
