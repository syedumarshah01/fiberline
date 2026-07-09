require('dotenv').config();
const express = require('express');
const cors = require('cors');

const polesRouter = require('./routes/poles');
const enclosuresRouter = require('./routes/enclosures');
const cablesRouter = require('./routes/cables');
const customersRouter = require('./routes/customers');
const splicesRouter = require('./routes/splices');
const fiberCoresRouter = require('./routes/fiberCores');
const capacityRouter = require('./routes/capacity');

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
app.use('/api/capacity', capacityRouter);

// Centralized error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Fiber network API listening on port ${PORT}`);
});
