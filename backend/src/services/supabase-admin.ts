// GoTrue Admin API lookup. 'deleted' only on a definitive 404
// (user_not_found); any other failure is 'unavailable' so the caller can
// decide between failing closed and open.
export type AuthUserLookup = 'exists' | 'deleted' | 'unavailable'

export async function lookupAuthUser(
  supabaseUrl: string,
  serviceRoleKey: string,
  userId: string,
): Promise<AuthUserLookup> {
  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${serviceRoleKey}`, apikey: serviceRoleKey },
    })
    if (res.ok) return 'exists'
    if (res.status === 404) return 'deleted'
    console.error('supabase-admin: user lookup failed', { userId, status: res.status })
    return 'unavailable'
  } catch (e) {
    console.error('supabase-admin: user lookup failed', { userId, e })
    return 'unavailable'
  }
}
