/**
 * Turn "column does not exist" into "run the migration".
 *
 * Pulling new code without running `npm run migrate` is the single most common
 * self-inflicted outage in this project (a missing migration once broke cable
 * drawing, and the 500 that came back said nothing useful). Postgres is precise
 * but terse — `column c.continues_cable_id does not exist` — and the person
 * reading it is usually the person who just pulled the branch.
 *
 * `migrationHint` names the column and the migration that adds it; if the error
 * is a missing-column error for that column, the returned error explains it in
 * those terms. Otherwise the original error is returned untouched, stack and
 * all, so real SQL bugs keep their real shape.
 */
function migrationHint(err, { column, migration, feature }) {
  if (!err) return err;
  const message = String(err.message || '');

  // 42703 = undefined_column. Match on the code when the driver gives one, and
  // on the text otherwise (a stub, or an older driver).
  const missingColumn =
    err.code === '42703' ||
    (new RegExp(`${column}\\b`).test(message) && /does not exist/i.test(message));
  if (!missingColumn || !new RegExp(column).test(message)) return err;

  const hint = new Error(
    `${feature} needs the ${column} column, which this database does not have yet — ` +
      `run "npm run migrate" in the backend to apply ${migration} ` +
      '(it also links any mid-span cable splits that already exist).',
  );
  hint.cause = err;
  hint.status = 503; // the app is fine; the schema is behind
  return hint;
}

module.exports = { migrationHint };
