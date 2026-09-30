const express = require('express');
const db = require('../db');
const {
  validateUsername,
  passwordPolicy,
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  requireAuth,
  requireAdmin,
  csrfValid,
  publicUser,
  SESSION_TTL_MS,
} = require('../services/auth');

const router = express.Router();

function invalidLogin(res) {
  return res.status(401).json({
    error: 'Invalid username or password',
    code: 'INVALID_CREDENTIALS',
  });
}

// POST /api/auth/login
router.post('/login', async (req, res, next) => {
  try {
    const username = validateUsername(req.body?.username);
    const password = req.body?.password;
    if (!username || typeof password !== 'string') return invalidLogin(res);

    const user = await db('users').where({ username, active: true }).first();
    // Run the same expensive verifier for unknown users so the response does
    // not reveal whether an account exists by timing.
    const valid = await verifyPassword(password, user?.password_hash || '$invalid$');
    if (!user || !valid) return invalidLogin(res);

    // Rotate any previous browser session before issuing a fresh one.
    await destroySession(req, res);
    const expiresAt = await createSession(user, req, res);
    await db('users').where({ id: user.id }).update({ last_login_at: db.fn.now() });
    res.json({ user: publicUser({ ...user, expiresAt }), expires_in_seconds: Math.floor(SESSION_TTL_MS / 1000) });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

// POST /api/auth/logout
router.post('/logout', requireAuth, async (req, res, next) => {
  try {
    if (!csrfValid(req)) return res.status(403).json({ error: 'CSRF validation failed', code: 'CSRF_INVALID' });
    await destroySession(req, res);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/change-password
router.post('/change-password', requireAuth, async (req, res, next) => {
  try {
    if (!csrfValid(req)) return res.status(403).json({ error: 'CSRF validation failed', code: 'CSRF_INVALID' });
    const { current_password: currentPassword, new_password: newPassword } = req.body || {};
    const policyError = passwordPolicy(newPassword);
    if (policyError) return res.status(400).json({ error: policyError });
    const user = await db('users').where({ id: req.user.id, active: true }).first();
    if (!user || !(await verifyPassword(currentPassword, user.password_hash))) return invalidLogin(res);
    const password_hash = await hashPassword(newPassword);
    await db('users').where({ id: user.id }).update({ password_hash, updated_at: db.fn.now() });
    await db('auth_sessions').where({ user_id: user.id }).whereNot({ id: req.user.sessionId }).del();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Admin account provisioning. There is intentionally no public registration
// endpoint: every technician account must be created by an authenticated admin
// or by the out-of-band create-admin command.
router.get('/users', requireAdmin, async (req, res, next) => {
  try {
    const users = await db('users')
      .select('id', 'username', 'role', 'active', 'last_login_at', 'created_at', 'updated_at')
      .orderBy('username');
    res.json(users);
  } catch (err) {
    next(err);
  }
});

router.post('/users', requireAdmin, async (req, res, next) => {
  try {
    if (!csrfValid(req)) return res.status(403).json({ error: 'CSRF validation failed', code: 'CSRF_INVALID' });
    const username = validateUsername(req.body?.username);
    const policyError = passwordPolicy(req.body?.password);
    if (!username) return res.status(400).json({ error: 'username is invalid' });
    if (policyError) return res.status(400).json({ error: policyError });
    const role = req.body?.role || 'technician';
    if (!['technician', 'admin'].includes(role)) return res.status(400).json({ error: 'role must be technician or admin' });
    const existing = await db('users').where({ username }).first();
    if (existing) return res.status(409).json({ error: 'Username is already in use' });
    const [user] = await db('users').insert({
      username,
      password_hash: await hashPassword(req.body.password),
      role,
      active: true,
    }).returning(['id', 'username', 'role', 'active', 'created_at']);
    res.status(201).json(user);
  } catch (err) {
    next(err);
  }
});

router.patch('/users/:id', requireAdmin, async (req, res, next) => {
  try {
    if (!csrfValid(req)) return res.status(403).json({ error: 'CSRF validation failed', code: 'CSRF_INVALID' });
    const updates = {};
    if (req.body?.role !== undefined) {
      if (!['technician', 'admin'].includes(req.body.role)) return res.status(400).json({ error: 'role must be technician or admin' });
      updates.role = req.body.role;
    }
    if (req.body?.active !== undefined) {
      if (typeof req.body.active !== 'boolean') return res.status(400).json({ error: 'active must be boolean' });
      if (req.body.active === false && req.params.id === req.user.id) return res.status(400).json({ error: 'You cannot deactivate your own account' });
      updates.active = req.body.active;
    }
    if (req.body?.password !== undefined) {
      const policyError = passwordPolicy(req.body.password);
      if (policyError) return res.status(400).json({ error: policyError });
      updates.password_hash = await hashPassword(req.body.password);
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No user fields to update' });
    updates.updated_at = db.fn.now();
    const [user] = await db('users').where({ id: req.params.id }).update(updates).returning(['id', 'username', 'role', 'active', 'updated_at']);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (updates.active === false || updates.password_hash) await db('auth_sessions').where({ user_id: req.params.id }).del();
    res.json(user);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
