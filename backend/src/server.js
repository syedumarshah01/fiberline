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
const qrRouter = require('./routes/qr');
const workOrdersRouter = require('./routes/workOrders');
const connectionPlansRouter = require('./routes/connectionPlans');
const telemetryRouter = require('./routes/telemetry');
const approvalsRouter = require('./routes/approvals');
const authRouter = require('./routes/auth');
const { attachUser, requireAuth, requireCsrf, allowTelemetryIngest } = require('./services/auth');
const { bootstrapSchemaNow } = require('./utils/schemaBootstrap');
const app = express();
app.set('trust proxy', 1);
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || true, credentials: true }));
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Authentication is public only for login. Every other API route requires a
// live HttpOnly session and state-changing requests also require the CSRF token
// paired with that session.
app.use('/api', attachUser);
app.use('/api/auth', authRouter);
// OLT/ONT systems are services, not browser users. They may post telemetry
// with the dedicated token while all other API routes still require a session.
app.use('/api/telemetry/events', allowTelemetryIngest);
app.use('/api/telemetry/ingest', allowTelemetryIngest);
app.use('/api', requireAuth);
app.use('/api', requireCsrf);

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
// Field work: QR tags that open a box's documentation, and the worksheet a
// technician works through inside it.
app.use('/api/qr', qrRouter);
app.use('/api/work-orders', workOrdersRouter);
app.use('/api/customer-plans', connectionPlansRouter);
// OLT/ONT status feed: POST current events, then consume /status or /stream.
app.use('/api/telemetry', telemetryRouter);
// As-built field changes are visible immediately but remain pending until an
// administrator approves them; rejection restores the pre-change snapshot.
app.use('/api/approvals', approvalsRouter);
// Centralized error handler
app.use((err, req, res, next) => {
  console.error(err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: err.message || 'Internal server error',
    ...(err.code ? { code: err.code } : {}),
    ...(err.conflict ? { conflict: err.conflict } : {}),
    ...(err.approval ? { approval: err.approval } : {}),
  });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, async () => {
  console.log(`Fiber network API listening on port ${PORT}`);
  // Before reporting what the database is missing, try to make it not missing:
  // apply the migrations this build has that the database does not (see
  // utils/schemaBootstrap.js). Then report whatever is genuinely left.
  await bootstrapSchemaNow();
  await reportSchema();
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
    // refresh: true — the bootstrap a moment ago may have added exactly the
    // column this would otherwise report as missing for the next 30 seconds.
    const capabilities = await schemaCapabilities({ refresh: true });
    if (!capabilities.gaps.length) return;
    console.warn('---');
    console.warn(`Schema check — database "${capabilities.database}" on ${capabilities.target}`);
    for (const gap of capabilities.gaps) {
      // ! for something broken, · for something the app is working around.
      console.warn(`  ${gap.severity === 'notice' ? '·' : '!'} ${gap.message}`);
    }
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
