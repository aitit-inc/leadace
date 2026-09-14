// Workers runtime has no Stripe SDK; we post x-www-form-urlencoded directly.
// The LeadAce account's default version when this was written, pinned so a
// self-host account on an older default answers with the same shapes the
// code reads (billing periods on subscription items, invoice `payments`,
// schedule phase `duration`).
const STRIPE_API_VERSION = '2026-03-25.dahlia'

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
      'Stripe-Version': STRIPE_API_VERSION,
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: body ? new URLSearchParams(body).toString() : undefined,
  })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { ok: res.ok, data }
}
