/**
 * Set up Stripe Products, Prices, Customer Portal, and optionally the Webhook
 * endpoint (when WEBHOOK_URL is provided).
 *
 * Idempotent: re-runs skip anything that already exists (matched by metadata).
 * Safe to use in both test and live mode — the secret key determines which.
 *
 * Usage:
 *   STRIPE_SECRET_KEY=sk_test_... \
 *   PORTAL_RETURN_URL=https://app.leadace.ai/plans \
 *   WEBHOOK_URL=https://api.leadace.ai/api/stripe/webhook \
 *   npx tsx scripts/setup-stripe.ts
 *
 * Optional env:
 *   PORTAL_RETURN_URL — default return URL for Customer Portal (defaults to prod app URL)
 *   BUSINESS_HEADLINE — shown in portal header (defaults to 'LeadAce subscription')
 *   WEBHOOK_URL       — if set, create/update a webhook endpoint at this URL.
 *                       On first creation, the signing secret (whsec_...) is printed.
 *
 * Outputs the 6 Price IDs at the end in a copy-paste-ready format.
 */

const KEY = process.env['STRIPE_SECRET_KEY']
if (!KEY) {
  console.error('STRIPE_SECRET_KEY is required (sk_test_... or sk_live_...)')
  process.exit(1)
}

const PORTAL_RETURN_URL = process.env['PORTAL_RETURN_URL'] ?? 'https://app.leadace.ai/plans'
const BUSINESS_HEADLINE = process.env['BUSINESS_HEADLINE'] ?? 'LeadAce subscription'
const WEBHOOK_URL = process.env['WEBHOOK_URL']
const MODE = KEY.startsWith('sk_test_') ? 'test' : 'live'

const WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
]

// Stripe Tax product taxonomy: SaaS, business use, no download component.
// https://docs.stripe.com/tax/tax-codes
const TAX_CODE = 'txcd_10103001'

// ---------------------------------------------------------------------------

type PlanTier = 'starter' | 'pro' | 'scale'

interface PlanDef {
  tier: PlanTier
  name: string
  description: string
  monthlyUsd: number
  yearlyUsd: number
}

const PLANS: PlanDef[] = [
  { tier: 'starter', name: 'Starter', description: '1 project, 1,500 outreach actions per month.', monthlyUsd: 29, yearlyUsd: 290 },
  { tier: 'pro', name: 'Pro', description: '5 projects, 4,000 outreach actions per month.', monthlyUsd: 79, yearlyUsd: 790 },
  { tier: 'scale', name: 'Scale', description: 'Unlimited projects and outreach actions.', monthlyUsd: 199, yearlyUsd: 1990 },
]

// ---------------------------------------------------------------------------

type StripeResponse = Record<string, unknown>

async function stripeApi(method: 'GET' | 'POST', path: string, body?: Record<string, string>): Promise<StripeResponse> {
  const url = method === 'GET' && body
    ? `https://api.stripe.com/v1${path}?${new URLSearchParams(body).toString()}`
    : `https://api.stripe.com/v1${path}`
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: method === 'POST' && body ? new URLSearchParams(body).toString() : undefined,
  })
  const data = (await res.json()) as StripeResponse
  if (!res.ok) {
    throw new Error(`Stripe ${method} ${path} -> ${res.status}: ${JSON.stringify(data)}`)
  }
  return data
}

interface StripeListItem { id: string; metadata?: Record<string, string> }

async function searchProduct(plan: PlanTier): Promise<string | null> {
  const data = await stripeApi('GET', '/products/search', {
    query: `active:"true" AND metadata["plan"]:"${plan}"`,
  })
  const list = (data['data'] as StripeListItem[]) ?? []
  return list[0]?.id ?? null
}

async function searchPrice(productId: string, plan: PlanTier, interval: 'month' | 'year'): Promise<string | null> {
  const data = await stripeApi('GET', '/prices/search', {
    query: `active:"true" AND product:"${productId}" AND metadata["plan"]:"${plan}" AND metadata["interval"]:"${interval}"`,
  })
  const list = (data['data'] as StripeListItem[]) ?? []
  return list[0]?.id ?? null
}

async function ensureProduct(plan: PlanDef): Promise<string> {
  const params: Record<string, string> = {
    name: plan.name,
    description: plan.description,
    tax_code: TAX_CODE,
    'metadata[plan]': plan.tier,
    'metadata[app]': 'lead-ace',
  }
  const existing = await searchProduct(plan.tier)
  if (existing) {
    await stripeApi('POST', `/products/${existing}`, params)
    console.log(`  [ok] Product ${plan.name}: ${existing} (updated)`)
    return existing
  }
  const p = await stripeApi('POST', '/products', params)
  console.log(`  [+]  Product ${plan.name}: ${p['id']}`)
  return p['id'] as string
}

async function ensurePrice(productId: string, plan: PlanDef, interval: 'month' | 'year'): Promise<string> {
  const existing = await searchPrice(productId, plan.tier, interval)
  if (existing) {
    console.log(`    [ok] Price ${plan.name} ${interval}ly: ${existing} (reused)`)
    return existing
  }
  const amount = interval === 'month' ? plan.monthlyUsd * 100 : plan.yearlyUsd * 100
  const p = await stripeApi('POST', '/prices', {
    product: productId,
    currency: 'usd',
    unit_amount: String(amount),
    'recurring[interval]': interval,
    nickname: `${plan.name} ${interval}ly`,
    'metadata[plan]': plan.tier,
    'metadata[interval]': interval,
  })
  console.log(`    [+]  Price ${plan.name} ${interval}ly: ${p['id']}`)
  return p['id'] as string
}

async function ensurePortalConfig(products: Array<{ productId: string; priceIds: string[] }>): Promise<string> {
  // List existing configs tagged with our app marker
  const list = await stripeApi('GET', '/billing_portal/configurations', { limit: '100' })
  const configs = (list['data'] as Array<{ id: string; metadata?: Record<string, string>; is_default?: boolean }>) ?? []
  const existing = configs.find((c) => c.metadata?.['app'] === 'lead-ace')

  const params: Record<string, string> = {
    'business_profile[headline]': BUSINESS_HEADLINE,
    default_return_url: PORTAL_RETURN_URL,
    'features[subscription_update][enabled]': 'true',
    'features[subscription_update][default_allowed_updates][0]': 'price',
    'features[subscription_update][proration_behavior]': 'create_prorations',
    'features[subscription_cancel][enabled]': 'true',
    'features[subscription_cancel][mode]': 'at_period_end',
    'features[payment_method_update][enabled]': 'true',
    'features[invoice_history][enabled]': 'true',
    'metadata[app]': 'lead-ace',
  }
  products.forEach((p, i) => {
    params[`features[subscription_update][products][${i}][product]`] = p.productId
    p.priceIds.forEach((priceId, j) => {
      params[`features[subscription_update][products][${i}][prices][${j}]`] = priceId
    })
  })

  if (existing) {
    const updated = await stripeApi('POST', `/billing_portal/configurations/${existing.id}`, params)
    console.log(`  [ok] Portal config: ${updated['id']} (updated)`)
    return updated['id'] as string
  }

  // Stripe promotes the most-recently-created active configuration to default
  // automatically when no other default exists. If an inactive or different
  // default is already set, the user must promote this one via Dashboard.
  const created = await stripeApi('POST', '/billing_portal/configurations', params)
  const isDefault = created['is_default'] === true
  console.log(`  [+]  Portal config: ${created['id']} ${isDefault ? '(default)' : '(NOT default — promote manually in Dashboard)'}`)
  return created['id'] as string
}

async function ensureWebhook(url: string): Promise<{ id: string; secret: string | null }> {
  const list = await stripeApi('GET', '/webhook_endpoints', { limit: '100' })
  const endpoints = (list['data'] as Array<{ id: string; url: string; metadata?: Record<string, string>; enabled_events?: string[] }>) ?? []
  const existing = endpoints.find((e) => e.metadata?.['app'] === 'lead-ace')

  const params: Record<string, string> = {
    url,
    'metadata[app]': 'lead-ace',
  }
  WEBHOOK_EVENTS.forEach((e, i) => { params[`enabled_events[${i}]`] = e })

  if (existing) {
    const updated = await stripeApi('POST', `/webhook_endpoints/${existing.id}`, params)
    console.log(`  [ok] Webhook endpoint: ${updated['id']} (updated; signing secret unchanged — retrieve from Dashboard if lost)`)
    return { id: updated['id'] as string, secret: null }
  }

  const created = await stripeApi('POST', '/webhook_endpoints', params)
  console.log(`  [+]  Webhook endpoint: ${created['id']}`)
  return { id: created['id'] as string, secret: (created['secret'] as string) ?? null }
}

// ---------------------------------------------------------------------------

async function main() {
  console.log(`\n=== Stripe setup (${MODE} mode) ===\n`)

  console.log('Products & Prices:')
  const results: Array<{ plan: PlanDef; productId: string; monthly: string; yearly: string }> = []
  for (const plan of PLANS) {
    const productId = await ensureProduct(plan)
    const monthly = await ensurePrice(productId, plan, 'month')
    const yearly = await ensurePrice(productId, plan, 'year')
    results.push({ plan, productId, monthly, yearly })
  }

  console.log('\nCustomer Portal:')
  await ensurePortalConfig(
    results.map((r) => ({ productId: r.productId, priceIds: [r.monthly, r.yearly] })),
  )

  let webhookSecret: string | null = null
  if (WEBHOOK_URL) {
    console.log('\nWebhook endpoint:')
    const w = await ensureWebhook(WEBHOOK_URL)
    webhookSecret = w.secret
  } else {
    console.log('\n(WEBHOOK_URL not set — skipping webhook endpoint setup)')
  }

  console.log('\n=== Price IDs (copy these to GitHub repo Variables) ===\n')
  for (const r of results) {
    const up = r.plan.tier.toUpperCase()
    console.log(`PUBLIC_STRIPE_PRICE_${up}_MONTHLY=${r.monthly}`)
    console.log(`PUBLIC_STRIPE_PRICE_${up}_YEARLY=${r.yearly}`)
  }

  if (webhookSecret) {
    console.log('\n=== Webhook signing secret (shown only on creation) ===\n')
    console.log(`STRIPE_WEBHOOK_SECRET=${webhookSecret}`)
    console.log('\nStore this immediately — Stripe will not show it again.')
    console.log('Set via: npx wrangler secret put STRIPE_WEBHOOK_SECRET --config wrangler.api.jsonc --env production')
  }

  console.log('\nDone.')
}

main().catch((e) => {
  console.error('\nFailed:', e instanceof Error ? e.message : e)
  process.exit(1)
})
