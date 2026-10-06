const crypto = require('crypto');
const { promisify } = require('util');
const db = require('../db');

const scrypt = promisify(crypto.scrypt);
const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME || 'fiberline_session';
const CSRF_COOKIE = process.env.CSRF_COOKIE_NAME || 'fiberline_csrf';
const PASSWORD_FORMAT = 'scrypt';
const PASSWORD_COST = 16384;
const PASSWORD_BLOCK_SIZE = 8;
const PASSWORD_PARALLELISM = 1;
const PASSWORD_KEY_LENGTH = 64;
const SESSION_TTL_MS = Math.max(15 * 60 * 1000, Number(process.env.SESSION_TTL_HOURS || 8) * 60 * 60 * 1000);

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function validateUsername(value) {
  const username = normalizeUsername(value);
  return /^[a-z0-9][a-z0-9._-]{2,119}$/.test(username) ? username : null;
}

function passwordPolicy(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) {
    return 'Password must be between 12 and 256 characters';
  }
  return null;
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, PASSWORD_KEY_LENGTH, {
    N: PASSWORD_COST,
    r: PASSWORD_BLOCK_SIZE,
    p: PASSWORD_PARALLELISM,
    maxmem: 128 * PASSWORD_COST * PASSWORD_BLOCK_SIZE + 1024 * 1024,
  });
  return [
    PASSWORD_FORMAT,
    PASSWORD_COST,
    PASSWORD_BLOCK_SIZE,
    PASSWORD_PARALLELISM,
    salt.toString('base64url'),
    Buffer.from(derived).toString('base64url'),
  ].join('$');
}

async function verifyPassword(password, encoded) {
  try {
    const [format, cost, blockSize, parallelism, saltText, hashText] = String(encoded || '').split('$');
    if (format !== PASSWORD_FORMAT || !saltText || !hashText) return false;
    const salt = Buffer.from(saltText, 'base64url');
    const expected = Buffer.from(hashText, 'base64url');
    const derived = await scrypt(password, salt, expected.length, {
      N: Number(cost),
      r: Number(blockSize),
      p: Number(parallelism),
      maxmem: 128 * Number(cost) * Number(blockSize) + 1024 * 1024,
    });
    return expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
  } catch (_) {
    return false;
  }
}

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function parseCookies(header) {
  return String(header || '').split(';').reduce((cookies, part) => {
    const index = part.indexOf('=');
    if (index < 0) return cookies;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
    return cookies;
  }, {});
}

function cookieOptions(maxAge) {
  const secure = String(process.env.COOKIE_SECURE || '').toLowerCase() === 'true' ||
    (process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE !== 'false');
  return `Path=/; Max-Age=${Math.max(0, Math.floor(maxAge / 1000))}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

function setCookie(res, name, value, maxAge, httpOnly = true) {
  const flags = cookieOptions(maxAge).replace(httpOnly ? '' : ' HttpOnly', '');
  res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; ${flags}`);
}

function clearCookie(res, name, httpOnly = true) {
  setCookie(res, name, '', 0, httpOnly);
}

function csrfToken(req) {
  return parseCookies(req.headers.cookie)[CSRF_COOKIE];
}

function csrfValid(req) {
  const cookie = csrfToken(req);
  const header = req.get?.('x-csrf-token');
  return Boolean(cookie && header && cookie.length === header.length && crypto.timingSafeEqual(Buffer.from(cookie), Buffer.from(header)));
}

async function createSession(user, req, res) {
  const token = randomToken();
  const csrf = randomToken();
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_TTL_MS);
  await db('auth_sessions').insert({
    user_id: user.id,
    token_hash: hashSessionToken(token),
    expires_at: expires,
    last_seen_at: now,
    ip_address: req.ip,
    user_agent: String(req.get?.('user-agent') || '').slice(0, 1000),
  });
  setCookie(res, SESSION_COOKIE, token, SESSION_TTL_MS, true);
  // Double-submit token: readable by this app, but useless without the
  // HttpOnly session cookie that authenticates the request.
  setCookie(res, CSRF_COOKIE, csrf, SESSION_TTL_MS, false);
  return expires;
}

async function destroySession(req, res) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) await db('auth_sessions').where({ token_hash: hashSessionToken(token) }).del();
  clearCookie(res, SESSION_COOKIE, true);
  clearCookie(res, CSRF_COOKIE, false);
}

async function attachUser(req, res, next) {
  try {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) return next();
    const session = await db('auth_sessions')
      .join('users', 'users.id', 'auth_sessions.user_id')
      .where({ 'auth_sessions.token_hash': hashSessionToken(token), 'users.active': true })
      .where('auth_sessions.expires_at', '>', db.fn.now())
      .select(
        'users.id', 'users.username', 'users.role', 'users.active',
        'auth_sessions.id as session_id', 'auth_sessions.expires_at', 'auth_sessions.last_seen_at',
      )
      .first();
    if (!session) {
      clearCookie(res, SESSION_COOKIE, true);
      clearCookie(res, CSRF_COOKIE, false);
      return next();
    }
    req.user = {
      id: session.id,
      username: session.username,
      role: session.role,
      active: session.active,
      sessionId: session.session_id,
      expiresAt: session.expires_at,
    };
    // Avoid a write on every request while still recording active sessions.
    if (!session.last_seen_at || Date.now() - new Date(session.last_seen_at).getTime() > 5 * 60 * 1000) {
      await db('auth_sessions').where({ id: session.session_id }).update({ last_seen_at: db.fn.now() });
    }
    next();
  } catch (err) {
    next(err);
  }
}

function requireAuth(req, res, next) {
  if (req.user || req.serviceAuth) return next();
  return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Administrator role required', code: 'ADMIN_REQUIRED' });
  }
  return next();
}

function requireCsrf(req, res, next) {
  if (req.serviceAuth || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (csrfValid(req)) return next();
  return res.status(403).json({ error: 'CSRF validation failed', code: 'CSRF_INVALID' });
}

function publicUser(user) {
  return user ? {
    id: user.id,
    username: user.username,
    role: user.role,
    expires_at: user.expiresAt,
  } : null;
}

module.exports = {
  SESSION_COOKIE,
  CSRF_COOKIE,
  SESSION_TTL_MS,
  normalizeUsername,
  validateUsername,
  passwordPolicy,
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  attachUser,
  requireAuth,
  requireAdmin,
  requireCsrf,
  csrfValid,
  publicUser,
};
