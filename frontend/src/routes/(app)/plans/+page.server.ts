import { ApiError } from '$lib/api';
import { getSubscription } from '$lib/api/billing';
import { EDITION } from '$lib/config';
import type { SubscriptionInfo } from '$lib/types/plan';
import type { PageServerLoad } from './$types';

type SubscriptionLoad = { subscription: SubscriptionInfo | null; subscriptionError: string | null };

// The Stripe-side subscription state (period end, scheduled change) has its
// own tag and no `parent()` call, so the plan polling after a Checkout does
// not re-read Stripe on every attempt. 404 is a tenant without a Stripe
// subscription (free, or a manually seeded paid tier) and shows nothing; any
// other failure hides the plan-change cards behind a message, not the page.
export const load: PageServerLoad = async ({ fetch, locals, depends }): Promise<SubscriptionLoad> => {
  depends('app:subscription');
  if (EDITION !== 'cloud' || !locals.session) return { subscription: null, subscriptionError: null };
  try {
    return { subscription: await getSubscription(fetch, locals.session.access_token), subscriptionError: null };
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return { subscription: null, subscriptionError: null };
    return { subscription: null, subscriptionError: e instanceof Error ? e.message : 'Failed to load subscription' };
  }
};
