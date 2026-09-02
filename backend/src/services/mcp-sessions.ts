// MCP token-family store shared by the MCP Worker (mcp/oauth.ts) and the API
// Worker (account deletion). KV has no compare-and-swap, so a revocation is
// recorded twice: on the family object (Settings session list, back-compat)
// and as a standalone marker that a concurrent refresh's stale family write
// cannot clobber. Readers check both through isFamilyRevoked.

export function kvJson<T>(prefix: string, ttlSeconds: number) {
  const k = (id: string) => `${prefix}:${id}`
  return {
    get: (kv: KVNamespace, id: string) => kv.get<T>(k(id), 'json'),
    put: (kv: KVNamespace, id: string, value: T) =>
      kv.put(k(id), JSON.stringify(value), { expirationTtl: ttlSeconds }),
    del: (kv: KVNamespace, id: string) => kv.delete(k(id)),
  }
}

export const FAMILY_TTL_SECONDS = 60 * 60 * 24 * 30
export const USER_FAMILY_INDEX_TTL_SECONDS = 60 * 60 * 24 * 30

export type McpFamilyRevokedReason = 'reuse' | 'revoke_endpoint' | 'user_revoke' | 'account_deleted'

// Per-family metadata for revocation + the Settings page session list.
// One family is created per /authorize → /token exchange and persists
// across rotations within that session.
export interface McpFamily {
  ownerUserId: string
  clientId: string
  clientName: string | null
  createdAt: number
  lastSeenAt: number
  revokedAt?: number
  revokedReason?: McpFamilyRevokedReason
}

// Per-user index of family IDs, for the Settings page session list. KV
// doesn't support efficient list-by-user, so we maintain this manually.
export interface McpUserFamilies {
  familyIds: string[]
}

interface McpFamilyRevocation {
  revokedAt: number
  reason: McpFamilyRevokedReason
}

export const mcpFamilies = kvJson<McpFamily>('mcpfamily', FAMILY_TTL_SECONDS)
export const mcpUserFamilies = kvJson<McpUserFamilies>('mcpuserfam', USER_FAMILY_INDEX_TTL_SECONDS)
const mcpFamilyRevocations = kvJson<McpFamilyRevocation>('mcpfamilyrevoked', FAMILY_TTL_SECONDS)

export async function isFamilyRevoked(
  kv: KVNamespace,
  familyId: string,
  family: McpFamily | null,
): Promise<boolean> {
  if (family?.revokedAt) return true
  return (await mcpFamilyRevocations.get(kv, familyId)) !== null
}

export async function revokeFamily(
  kv: KVNamespace,
  familyId: string,
  reason: McpFamilyRevokedReason,
): Promise<void> {
  const family = await mcpFamilies.get(kv, familyId)
  if (!family) return
  if (await isFamilyRevoked(kv, familyId, family)) return
  const revokedAt = Date.now()
  await Promise.all([
    mcpFamilyRevocations.put(kv, familyId, { revokedAt, reason }),
    mcpFamilies.put(kv, familyId, { ...family, revokedAt, revokedReason: reason }),
  ])
  console.log('[oauth.family] revoked', { familyId, reason, ownerUserId: family.ownerUserId })
}

// Account deletion: every live family of the user is revoked so a plugin left
// configured gets invalid_grant on its next refresh instead of minting tokens
// for an auth user that no longer exists. Returns the number revoked.
export async function revokeUserFamilies(kv: KVNamespace, userId: string): Promise<number> {
  const index = await mcpUserFamilies.get(kv, userId)
  const familyIds = index?.familyIds ?? []
  let revoked = 0
  for (const familyId of familyIds) {
    const family = await mcpFamilies.get(kv, familyId)
    if (!family || family.ownerUserId !== userId) continue
    await revokeFamily(kv, familyId, 'account_deleted')
    revoked++
  }
  await mcpUserFamilies.del(kv, userId)
  return revoked
}
