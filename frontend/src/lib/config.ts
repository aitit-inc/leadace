// dynamic/public reads Cloudflare Pages runtime env and silently misses
// build-time values set in deploy.yml — use static. Wildcard cast lets
// optional PUBLIC_* (Stripe Price IDs on self-host) be undefined without
// TS-erroring on named imports.
import * as publicEnv from '$env/static/public';

const env = publicEnv as Record<string, string | undefined>;

export type Edition = 'cloud' | 'self-hosted';

// Asymmetric default — a misconfigured cloud build loses billing UI
// (visible to the operator), a misconfigured self-host stays safe.
function parseEdition(raw: unknown): Edition {
  return raw === 'cloud' ? 'cloud' : 'self-hosted';
}

export const EDITION: Edition = parseEdition(env.PUBLIC_LEADACE_EDITION);

// Gate Stripe routes on EDITION === 'cloud', not on individual price IDs
// (self-host has them all undefined).
export const STRIPE_PRICES = {
  starter: {
    monthly: env.PUBLIC_STRIPE_PRICE_STARTER_MONTHLY,
    yearly: env.PUBLIC_STRIPE_PRICE_STARTER_YEARLY,
  },
  pro: {
    monthly: env.PUBLIC_STRIPE_PRICE_PRO_MONTHLY,
    yearly: env.PUBLIC_STRIPE_PRICE_PRO_YEARLY,
  },
  scale: {
    monthly: env.PUBLIC_STRIPE_PRICE_SCALE_MONTHLY,
    yearly: env.PUBLIC_STRIPE_PRICE_SCALE_YEARLY,
  },
} as const;
