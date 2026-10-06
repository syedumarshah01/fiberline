const db = require('../db');
const { randomUUID } = require('node:crypto');

const ACTION_TTL_MS = 5 * 60 * 1000;
const pendingActions = new Map();

const TARGETS = {
  pole: { table: 'poles', statuses: ['planned', 'active', 'inactive', 'damaged'] },
  enclosure: { table: 'enclosures', statuses: ['planned', 'active', 'inactive', 'full'] },
  cable: { table: 'cables', statuses: ['planned', 'active', 'inactive', 'damaged'] },
  customer: { table: 'customers', statuses: ['prospect', 'active', 'suspended', 'cancelled'] },
  splitter: { table: 'splitters', statuses: ['active', 'inactive', 'damaged'] },
};

function actionError(message, status = 400, code = 'AGENT_ACTION_INVALID') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function prune() {
  const now = Date.now();
  for (const [id, action] of pendingActions) if (action.expires_at <= now) pendingActions.delete(id);
}

async function resolveTarget(kind, identifier) {
  const definition = TARGETS[kind];
  if (!definition) throw actionError(`Status changes are not supported for ${kind}.`);
  const value = String(identifier ?? '').trim();
  if (!value) throw actionError('An asset identifier is required.');
  const columns = kind === 'customer' ? 'id, customer_code, name, status' : 'id, code, name, status';
  const codeColumn = kind === 'customer' ? 'customer_code' : 'code';
  const result = await db.raw(
    `SELECT ${columns} FROM ${definition.table}
     WHERE id::text = ? OR lower(${codeColumn}) = lower(?) OR lower(name) = lower(?)
     LIMIT 2`,
    [value, value, value],
  );
  if (result.rows.length !== 1) {
    if (result.rows.length > 1) throw actionError('The identifier is ambiguous; choose a specific asset.', 422, 'AGENT_ACTION_AMBIGUOUS');
    throw actionError(`No ${kind} matched “${value}”.`, 404, 'AGENT_ACTION_NOT_FOUND');
  }
  return { definition, target: result.rows[0] };
}

async function prepareStatusChange({ kind, identifier, status, reason }, { userId, userRole } = {}) {
  prune();
  const normalizedKind = String(kind ?? '').toLowerCase();
  const normalizedStatus = String(status ?? '').toLowerCase();
  const { definition, target } = await resolveTarget(normalizedKind, identifier);
  if (!definition.statuses.includes(normalizedStatus)) {
    throw actionError(`Status must be one of: ${definition.statuses.join(', ')}.`);
  }
  const id = randomUUID();
  const action = {
    id,
    user_id: String(userId || 'anonymous'),
    user_role: userRole || 'technician',
    type: 'set_asset_status',
    kind: normalizedKind,
    target_id: target.id,
    target_label: target.code || target.customer_code || target.name || target.id,
    before: target.status,
    after: normalizedStatus,
    reason: String(reason || '').slice(0, 500) || null,
    created_at: new Date().toISOString(),
    expires_at: Date.now() + ACTION_TTL_MS,
  };
  pendingActions.set(id, action);
  return { status: 'confirmation_required', pending_action: action };
}

async function executePendingAction(id, { userId, userRole } = {}) {
  prune();
  const action = pendingActions.get(id);
  if (!action) throw actionError('This confirmation has expired. Ask the assistant to prepare it again.', 410, 'AGENT_ACTION_EXPIRED');
  if (action.user_id !== String(userId || 'anonymous')) throw actionError('Only the employee who requested this action may confirm it.', 403, 'AGENT_ACTION_OWNER');
  if (action.type === 'set_asset_status') {
    const definition = TARGETS[action.kind];
    if (!definition || !definition.statuses.includes(action.after)) throw actionError('The pending action is no longer valid.');
    const current = await db(definition.table).where({ id: action.target_id }).first();
    if (!current) throw actionError('The target asset no longer exists.', 409, 'AGENT_ACTION_STALE');
    if (current.status !== action.before) throw actionError('The target changed after this action was prepared. Ask again.', 409, 'AGENT_ACTION_STALE');
    const [updated] = await db(definition.table).where({ id: action.target_id }).update({ status: action.after, updated_at: db.fn.now() }).returning('*');
    pendingActions.delete(id);
    return { status: 'executed', action: { ...action, result: updated }, message: `${action.target_label} status changed from ${action.before} to ${action.after}.` };
  }
  throw actionError('Unsupported pending action.', 400);
}

function cancelPendingAction(id, { userId } = {}) {
  prune();
  const action = pendingActions.get(id);
  if (!action) return { status: 'already_expired' };
  if (action.user_id !== String(userId || 'anonymous')) throw actionError('Only the employee who requested this action may cancel it.', 403, 'AGENT_ACTION_OWNER');
  pendingActions.delete(id);
  return { status: 'cancelled', action_id: id };
}

async function prepareAgentAction(args, context) {
  if (args?.action !== 'set_asset_status') return { error: 'Only set_asset_status is currently available for confirmation.' };
  return prepareStatusChange(args, context);
}

module.exports = {
  TARGETS,
  prepareAgentAction,
  prepareStatusChange,
  executePendingAction,
  cancelPendingAction,
};
