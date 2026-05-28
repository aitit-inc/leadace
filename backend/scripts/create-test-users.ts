/**
 * Create two test users in Supabase Auth for manual runtime tests.
 *
 * Produces a JSON object with each user's access token (JWT). Pipe through jq
 * to extract tokens for use with curl / MCP.
 *
 * Usage:
 *   SUPABASE_URL="http://127.0.0.1:54321" \
 *   SUPABASE_SERVICE_ROLE_KEY="sb_secret_..." \
 *   SUPABASE_ANON_KEY="sb_publishable_..." \
 *   npx tsx scripts/create-test-users.ts
 *
 * Output (stdout):
 *   {
 *     "a": { "id": "...", "email": "tenant-a@test.local", "token": "eyJ..." },
 *     "b": { "id": "...", "email": "tenant-b@test.local", "token": "eyJ..." }
 *   }
 */

const SUPABASE_URL = process.env['SUPABASE_URL'] ?? 'http://127.0.0.1:54321'
const SERVICE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY']
const ANON_KEY = process.env['SUPABASE_ANON_KEY']

if (!SERVICE_KEY || !ANON_KEY) {
  console.error('SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY are required')
  console.error('Get them from: npx supabase status')
  process.exit(1)
}

const USERS = [
  { key: 'a', email: 'tenant-a@test.local', password: 'TestPass123!aaaa' },
  { key: 'b', email: 'tenant-b@test.local', password: 'TestPass123!bbbb' },
] as const

async function ensureUser(email: string, password: string): Promise<string> {
  // Try to create; if user exists, that's fine.
  const createRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY!,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  })

  if (createRes.ok) {
    const data = (await createRes.json()) as { id: string }
    return data.id
  }

  const err = (await createRes.json().catch(() => ({}))) as Record<string, unknown>
  // If already exists, fetch id by listing
  if (createRes.status === 422 || String(err['msg'] ?? '').includes('already')) {
    const listRes = await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users?filter=${encodeURIComponent(email)}`,
      { headers: { apikey: SERVICE_KEY!, Authorization: `Bearer ${SERVICE_KEY}` } },
    )
    const listData = (await listRes.json()) as { users: Array<{ id: string; email: string }> }
    const found = listData.users.find((u) => u.email === email)
    if (found) return found.id
  }

  throw new Error(`Failed to create user ${email}: ${createRes.status} ${JSON.stringify(err)}`)
}

async function signIn(email: string, password: string): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      apikey: ANON_KEY!,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`Sign-in failed for ${email}: ${res.status} ${JSON.stringify(err)}`)
  }
  const data = (await res.json()) as { access_token: string }
  return data.access_token
}

async function main() {
  const result: Record<string, { id: string; email: string; token: string }> = {}
  for (const u of USERS) {
    const id = await ensureUser(u.email, u.password)
    const token = await signIn(u.email, u.password)
    result[u.key] = { id, email: u.email, token }
  }
  console.log(JSON.stringify(result, null, 2))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
