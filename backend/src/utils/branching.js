/**
 * Whether a core may be selected as the IN side of a new branch.
 *
 * A free/reserved core is eligible. A spliced core is eligible only when it is
 * the incoming core at this enclosure and has not already been used as a branch
 * point in this same enclosure. This lets an already-spliced upstream fibre
 * branch once here without allowing a second branch from the same joint.
 */
const BRANCHABLE_CORE_STATUSES = new Set(['available', 'reserved']);

function canBranchFromCore(
  core,
  { cable = null, enclosureId = null, alreadyBranched = false } = {},
) {
  if (!core || alreadyBranched) return false;
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
