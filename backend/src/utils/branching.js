/**
 * A core can be used as the IN side of one new branch only while it is still
 * unassigned (or explicitly reserved). Once it has been spliced to an OUT
 * core, its `spliced` status records that the branch has already been made;
 * allowing it back into the IN picker creates a second branch from the same
 * physical IN fibre.
 */
const BRANCHABLE_CORE_STATUSES = new Set(['available', 'reserved']);

function canBranchFromCore(core) {
  return Boolean(core) && BRANCHABLE_CORE_STATUSES.has(core.status);
}

module.exports = {
  BRANCHABLE_CORE_STATUSES,
  canBranchFromCore,
};
