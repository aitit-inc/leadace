/**
 * Delete Supabase Auth users together with the tenant they own — cleanup for
 * accounts created by signup tests. Procedure and approval flow:
 * .claude/skills/delete-test-accounts/SKILL.md
 *
 * Usage:
 *   npx tsx scripts/delete-accounts.ts --env-file=.env.production <uuid|email>...           # inventory only
 *   npx tsx scripts/delete-accounts.ts --env-file=.env.production <uuid|email>... --apply   # delete
 *
 * DATABASE_URL resolution mirrors scripts/seed-master-documents.ts (env var →
 * --env-file → backend/.dev.vars). STRIPE_SECRET_KEY from the same sources
 * lets a recorded Stripe subscription be canceled before the delete (same call
 * and tolerance as the in-app DELETE /me/account). Without the key a tenant
 * that still records a subscription id is refused: the webhook keeps the id
 * for statuses that can still bill (incomplete, past_due), so a free plan does
 * not prove the subscription is dead.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { isStripeCancelTolerable } from '../src/services/account-deletion'
import { stripeApiRequest } from '../src/services/stripe-api'

const __dirname = typeof import.meta.dirname === 'string'
  ? import.meta.dirname
  : dirname(fileURLToPath(import.meta.url))

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const envFileArg = args.find((a) => a.startsWith('--env-file='))
const targetArgs = args.filter((a) => !a.startsWith('--'))

if (envFileArg) {
  const envPath = resolve(__dirname, '..', envFileArg.slice('--env-file='.length))
  if (!existsSync(envPath)) {
    console.error(`env file not found: ${envPath}`)
    process.exit(1)
  }
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i)
    if (!m) continue
    let value = m[2]!
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[m[1]!] === undefined) process.env[m[1]!] = value
  }
}

if (!process.env['DATABASE_URL']) {
  const devVarsPath = resolve(__dirname, '..', '.dev.vars')
  if (existsSync(devVarsPath)) {
    for (const line of readFileSync(devVarsPath, 'utf-8').split('\n')) {
      const m = line.match(/^DATABASE_URL\s*=\s*"?([^"\n]+?)"?\s*$/)
      if (m) {
        process.env['DATABASE_URL'] = m[1]
        break
      }
    }
  }
}

const DATABASE_URL = process.env['DATABASE_URL']
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required (set in env, via --env-file=<path>, or in backend/.dev.vars)')
  process.exit(1)
}
const STRIPE_SECRET_KEY = process.env['STRIPE_SECRET_KEY'] ?? null

if (targetArgs.length === 0) {
  console.error('Usage: npx tsx scripts/delete-accounts.ts [--env-file=<path>] <uuid|email>... [--apply]')
  process.exit(1)
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Target = { input: string; kind: 'uid' | 'email' }

function parseTarget(input: string): Target {
  if (input.includes('@')) return { input: input.toLowerCase(), kind: 'email' }
  if (UUID_RE.test(input)) return { input: input.toLowerCase(), kind: 'uid' }
  console.error(`target must be an auth user UUID or an email: ${input}`)
  process.exit(1)
}

const targets = targetArgs.map(parseTarget)

type AuthUser = {
  id: string
  email: string | null
  created_at: Date
  last_sign_in_at: Date | null
}

type TenantRow = {
  id: string
  name: string
  created_at: Date
  first_mcp_connected_at: Date | null
  role: string
  member_count: number
  plan: string | null
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
}

type Tenant = TenantRow & { rowCounts: Array<{ table: string; count: number }> }

type Inventory =
  | { status: 'not_found'; target: Target }
  | { status: 'blocked'; target: Target; reason: string; user: AuthUser | null; userId: string; tenant: Tenant }
  | { status: 'deletable'; target: Target; user: AuthUser | null; userId: string; tenant: Tenant | null }

function blockReason(tenant: Tenant, stripeKey: string | null): string | null {
  if (tenant.role !== 'owner') return `membership role is ${tenant.role}, not owner`
  if (tenant.member_count > 1) return `tenant has ${tenant.member_count} members — shared workspace`
  if (tenant.stripe_subscription_id && !stripeKey) {
    return `Stripe subscription ${tenant.stripe_subscription_id} still recorded — provide STRIPE_SECRET_KEY so it is canceled first`
  }
  return null
}

function describeDb(url: string): string {
  const u = new URL(url)
  return `${u.username}@${u.hostname}:${u.port || '5432'}${u.pathname}`
}

function fmtDate(d: Date | null): string {
  return d ? d.toISOString().slice(0, 16).replace('T', ' ') : '-'
}

async function main() {
  const sql = postgres(DATABASE_URL!, { prepare: false })
  try {
    console.log(`DB: ${describeDb(DATABASE_URL!)}`)
    console.log(`Stripe: ${STRIPE_SECRET_KEY ? 'STRIPE_SECRET_KEY present — recorded subscriptions are canceled before delete' : 'no STRIPE_SECRET_KEY — tenants with a recorded subscription are refused'}`)
    console.log(`Mode: ${apply ? 'APPLY (rows will be deleted)' : 'dry-run (inventory only)'}\n`)

    const tenantScopedTables = (
      await sql<Array<{ table_name: string }>>`
        SELECT table_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'tenant_id'
        ORDER BY table_name
      `
    ).map((r) => r.table_name)

    async function loadTenant(userId: string): Promise<Tenant | null> {
      const [row] = await sql<TenantRow[]>`
        SELECT t.id, t.name, t.created_at, t.first_mcp_connected_at,
               tm.role::text AS role,
               (SELECT count(*)::int FROM tenant_members m WHERE m.tenant_id = t.id) AS member_count,
               p.plan::text AS plan, p.stripe_customer_id, p.stripe_subscription_id
        FROM tenant_members tm
        JOIN tenants t ON t.id = tm.tenant_id
        LEFT JOIN tenant_plans p ON p.tenant_id = t.id
        WHERE tm.user_id = ${userId}
        LIMIT 1
      `
      if (!row) return null
      const rowCounts: Tenant['rowCounts'] = []
      for (const table of tenantScopedTables) {
        const [c] = await sql<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM ${sql(table)} WHERE tenant_id = ${row.id}
        `
        if (c && c.n > 0) rowCounts.push({ table, count: c.n })
      }
      return { ...row, rowCounts }
    }

    async function inspect(target: Target): Promise<Inventory> {
      const [user] = target.kind === 'email'
        ? await sql<AuthUser[]>`
            SELECT id::text AS id, email, created_at, last_sign_in_at
            FROM auth.users WHERE lower(email) = ${target.input} LIMIT 1
          `
        : await sql<AuthUser[]>`
            SELECT id::text AS id, email, created_at, last_sign_in_at
            FROM auth.users WHERE id = ${target.input}::uuid LIMIT 1
          `
      const userId = user?.id ?? (target.kind === 'uid' ? target.input : null)
      if (!userId) return { status: 'not_found', target }

      const tenant = await loadTenant(userId)
      if (!user && !tenant) return { status: 'not_found', target }
      const reason = tenant ? blockReason(tenant, STRIPE_SECRET_KEY) : null
      if (tenant && reason) {
        return { status: 'blocked', target, reason, user: user ?? null, userId, tenant }
      }
      return { status: 'deletable', target, user: user ?? null, userId, tenant }
    }

    const inventories: Inventory[] = []
    for (const target of targets) {
      inventories.push(await inspect(target))
    }

    for (const inv of inventories) {
      console.log(`== ${inv.target.input}`)
      if (inv.status === 'not_found') {
        console.log('   not found (no auth user, no tenant membership)\n')
        continue
      }
      const user = inv.user
      console.log(
        user
          ? `   auth.users: ${user.id}  ${user.email ?? '(no email)'}  created ${fmtDate(user.created_at)}  last sign-in ${fmtDate(user.last_sign_in_at)}`
          : `   auth.users: (missing — orphan tenant for user_id ${inv.userId})`,
      )
      const tenant = inv.tenant
      if (tenant) {
        console.log(
          `   tenant: ${tenant.id}  "${tenant.name}"  plan ${tenant.plan ?? '(no tenant_plans row)'}  role ${tenant.role}  members ${tenant.member_count}  created ${fmtDate(tenant.created_at)}  first MCP ${fmtDate(tenant.first_mcp_connected_at)}`,
        )
        if (tenant.stripe_customer_id) console.log(`   stripe customer: ${tenant.stripe_customer_id}`)
        if (tenant.stripe_subscription_id) {
          console.log(
            `   stripe subscription: ${tenant.stripe_subscription_id}${inv.status === 'deletable' ? '  (canceled before delete)' : ''}`,
          )
        }
        console.log(
          tenant.rowCounts.length > 0
            ? `   rows: ${tenant.rowCounts.map((r) => `${r.table}=${r.count}`).join(', ')}`
            : '   rows: (no tenant-scoped rows)',
        )
      } else {
        console.log('   tenant: (none — auth user never provisioned a tenant)')
      }
      if (inv.status === 'blocked') console.log(`   BLOCKED: ${inv.reason}`)
      console.log()
    }

    const deletable = inventories.filter((i): i is Extract<Inventory, { status: 'deletable' }> => i.status === 'deletable')
    const blocked = inventories.filter((i) => i.status === 'blocked').length
    const notFound = inventories.filter((i) => i.status === 'not_found').length
    console.log(`Summary: deletable=${deletable.length}, blocked=${blocked}, not_found=${notFound}`)

    if (!apply) {
      console.log('\nDry run — nothing deleted. Re-run with --apply to delete.')
      return
    }
    if (deletable.length !== inventories.length) {
      console.error('\nNothing deleted: every target must be deletable before --apply runs. Fix the target list and re-run.')
      process.exitCode = 1
      return
    }

    let done = 0
    for (const inv of deletable) {
      const subscriptionId = inv.tenant?.stripe_subscription_id
      if (subscriptionId && STRIPE_SECRET_KEY) {
        const cancel = await stripeApiRequest('DELETE', `/subscriptions/${subscriptionId}`, null, STRIPE_SECRET_KEY)
        if (!isStripeCancelTolerable(cancel)) {
          console.error(`\nStopped at ${inv.target.input}: Stripe cancel of ${subscriptionId} failed (${done} account(s) already deleted)`)
          console.error(JSON.stringify(cancel.data))
          process.exitCode = 1
          return
        }
        console.log(`canceled Stripe subscription ${subscriptionId}`)
      }
      const result = await sql.begin(async (tx) => {
        const tenants = inv.tenant
          ? await tx<Array<{ id: string }>>`DELETE FROM tenants WHERE id = ${inv.tenant.id} RETURNING id`
          : []
        const users = inv.user
          ? await tx<Array<{ id: string }>>`DELETE FROM auth.users WHERE id = ${inv.user.id}::uuid RETURNING id::text AS id`
          : []
        return { tenants: tenants.length, users: users.length }
      })
      done++
      console.log(`deleted ${inv.target.input}: tenants=${result.tenants}, auth.users=${result.users}`)
    }
    console.log(`\nDone: ${done} account(s) deleted.`)
  } finally {
    await sql.end()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
