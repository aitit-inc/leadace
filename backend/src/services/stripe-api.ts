// Workers runtime has no Stripe SDK; we post x-www-form-urlencoded directly.
export async function stripeApiRequest(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body: Record<string, string> | null,
  secretKey: string,
): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: body ? new URLSearchParams(body).toString() : undefined,
  })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { ok: res.ok, data }
}
