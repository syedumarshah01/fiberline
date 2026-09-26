/**
 * Whether a core may be selected as the IN side of a new branch.
 *
 * A free/reserved core is always eligible. A spliced core is eligible only
 * when it is the incoming core at this enclosure: an upstream fibre may already
 * be spliced here and can legitimately fan out to another splice or splitter.
 * A spliced OUT core, or a spliced core from another enclosure, is not an IN
 * branch point for this operation.
 */
const BRANCHABLE_CORE_STATUSES = new Set(['available', 'reserved']);

function canBranchFromCore(core, { cable = null, enclosureId = null } = {}) {
  if (!core) return false;
  if (BRANCHABLE_CORE_STATUSES.has(core.status)) return true;
  return Boolean(
    core.status === 'spliced' &&
      cable &&
      enclosureId &&
      cable.to_enclosure_id === enclosureId,
  );
}

module.exports = {
  BRANCHABLE_CORE_STATUSES,
  canBranchFromCore,
};
