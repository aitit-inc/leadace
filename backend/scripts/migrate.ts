/**
 * Apply pending Drizzle migrations, each in its own transaction.
 *
 * drizzle-orm's built-in pg migrator wraps every pending migration into one
 * transaction. Postgres requires `ALTER TYPE ... ADD VALUE` and any usage of
 * the new value to live in separate transactions, so the bundled migrator
 * fails when both ship in a single push. This script runs each migration in
 * its own transaction and reuses drizzle's bookkeeping table layout
 * (`drizzle.__drizzle_migrations` with columns `id`, `hash`, `created_at`)
 * so it is interchangeable with `drizzle-kit migrate`.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... npx tsx scripts/migrate.ts
 *   (also wired into `npm run db:migrate`)
 *
 * Auto-loads DATABASE_URL from .dev.vars when not set in env, mirroring
 * drizzle.config.ts.
 */

import { existsSync, readFileSync } from 'node:fs'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import postgres from 'postgres'

if (!process.env['DATABASE_URL'] && existsSync('.dev.vars')) {
  for (const line of readFileSync('.dev.vars', 'utf-8').split('\n')) {
    const m = line.match(/^DATABASE_URL\s*=\s*"?([^"\n]+?)"?\s*$/)
    if (m) {
      process.env['DATABASE_URL'] = m[1]
      break
    }
  }
}

const DATABASE_URL = process.env['DATABASE_URL']
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required')
  process.exit(1)
}

async function main() {
  const migrations = readMigrationFiles({ migrationsFolder: './drizzle' })
  const sql = postgres(DATABASE_URL!, { max: 1, prepare: false })

  try {
    await sql.unsafe('CREATE SCHEMA IF NOT EXISTS drizzle')
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )
    `)

    // Match drizzle-kit's idempotency check: only the highest applied
    // `created_at` is compared. Hashes are stored but not used to gate re-runs,
    // so historical SQL edits (after a migration has already been applied) do
    // not retrigger the migration on later CI runs.
    const recordedRows = await sql<{ hash: string; created_at: string | number | null }[]>`
      SELECT hash, created_at FROM drizzle.__drizzle_migrations
      ORDER BY created_at ASC
    `
    const recordedByMillis = new Map<number, string>()
    let lastAppliedMillis: number | null = null
    for (const row of recordedRows) {
      if (row.created_at == null) continue
      const millis = Number(row.created_at)
      recordedByMillis.set(millis, row.hash)
      if (lastAppliedMillis === null || millis > lastAppliedMillis) {
        lastAppliedMillis = millis
      }
    }

    // Drift detection. CLAUDE.md "DB Schema Changes" forbids editing a
    // migration SQL file after it has been applied — if the recorded hash
    // does not match the file's current content hash, the .sql in the repo
    // does not match what was actually run against the DB and the DB state
    // is no longer fully described by the repo. Default: fail. Set
    // `LEADACE_MIGRATE_ALLOW_DRIFT=1` to downgrade to a warning (escape
    // hatch for "I know about the drift and accept it for this run"
    // scenarios, e.g. retrofitting hashes after a known legacy manual
    // patch).
    const allowDrift = process.env['LEADACE_MIGRATE_ALLOW_DRIFT'] === '1'
    const driftFixSql: string[] = []
    for (const migration of migrations) {
      const recordedHash = recordedByMillis.get(migration.folderMillis)
      if (recordedHash && recordedHash !== migration.hash) {
        console.error(
          `${allowDrift ? '⚠' : '✗'} drift: folderMillis=${migration.folderMillis} recorded=${recordedHash.slice(0, 12)}… file=${migration.hash.slice(0, 12)}…`,
        )
        driftFixSql.push(
          `UPDATE drizzle.__drizzle_migrations SET hash = '${migration.hash}' WHERE created_at = ${migration.folderMillis};`,
        )
      }
    }
    if (driftFixSql.length > 0) {
      console.error(
        `${allowDrift ? '⚠' : '✗'} ${driftFixSql.length} migration(s) drifted between repo and DB. Run the following in Supabase SQL Editor (or against the same DB) once you have confirmed the .sql files are authoritative:`,
      )
      for (const stmt of driftFixSql) console.error(`    ${stmt}`)
      if (!allowDrift) {
        console.error(
          'Drift detected — failing. Set LEADACE_MIGRATE_ALLOW_DRIFT=1 to override after auditing the diff.',
        )
        process.exit(1)
      }
    }

    let appliedCount = 0
    for (const migration of migrations) {
      if (lastAppliedMillis !== null && lastAppliedMillis >= migration.folderMillis) {
        continue
      }

      console.log(
        `Applying ${migration.hash.slice(0, 12)}… (folderMillis=${migration.folderMillis})`,
      )
      await sql.begin(async (tx) => {
        for (const stmt of migration.sql) {
          await tx.unsafe(stmt)
        }
        await tx`
          INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
          VALUES (${migration.hash}, ${migration.folderMillis})
        `
      })
      appliedCount++
    }

    console.log(
      appliedCount === 0
        ? 'No pending migrations.'
        : `Applied ${appliedCount} migration(s).`,
    )
  } finally {
    await sql.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
