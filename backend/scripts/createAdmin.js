require('dotenv').config();
const db = require('../src/db');
const { validateUsername, passwordPolicy, hashPassword } = require('../src/services/auth');

async function main() {
  const username = validateUsername(process.env.ADMIN_USERNAME);
  const password = process.env.ADMIN_PASSWORD;
  if (!username) throw new Error('Set ADMIN_USERNAME to 3-120 lowercase letters, numbers, dots, underscores, or hyphens');
  const policyError = passwordPolicy(password);
  if (policyError) throw new Error(`ADMIN_PASSWORD: ${policyError}`);

  const password_hash = await hashPassword(password);
  const existing = await db('users').where({ username }).first();
  if (existing) {
    await db('users').where({ id: existing.id }).update({
      password_hash,
      role: 'admin',
      active: true,
      updated_at: db.fn.now(),
    });
    console.log(`Updated active admin account: ${username}`);
  } else {
    await db('users').insert({ username, password_hash, role: 'admin', active: true });
    console.log(`Created active admin account: ${username}`);
  }
}

main()
  .catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
