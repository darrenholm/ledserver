import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { pool, query } from './index';
import { config } from '../config';

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');

async function ensureMigrationsTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function appliedVersions(): Promise<Set<string>> {
  const { rows } = await query<{ version: string }>(`SELECT version FROM schema_migrations`);
  return new Set(rows.map((r) => r.version));
}

async function applyMigration(version: string, sql: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [version]);
    await client.query('COMMIT');
    console.log(`migrated ${version}`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function seedAdmin() {
  const { rows } = await query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM users`);
  if (parseInt(rows[0].count, 10) > 0) return;
  const hash = await bcrypt.hash(config.admin.password, 10);
  await query(`INSERT INTO users (username, password_hash, role) VALUES ($1, $2, 'admin')`, [
    config.admin.username,
    hash,
  ]);
  console.log(`seeded admin user "${config.admin.username}"`);
}

async function main() {
  await ensureMigrationsTable();
  const done = await appliedVersions();
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (done.has(version)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    await applyMigration(version, sql);
  }

  await seedAdmin();
  await pool.end();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('migration failed:', err);
    process.exit(1);
  });
