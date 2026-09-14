import { STRIPE_PRICES } from '$lib/config';
import type { PaidPlanTier, PlanTier } from '$lib/types/plan';

export interface PaidTier {
  tier: PaidPlanTier;
  name: string;
  monthlyPrice: number;
  projects: string;
  outreach: string;
  priceId: string | undefined;
}

// Ordered lowest to highest; mirrors PLAN_LIMITS in backend/src/services/plan-limits.ts.
export const PAID_TIERS: PaidTier[] = [
  {
    tier: 'starter',
    name: 'Starter',
    monthlyPrice: 49,
    projects: '1 project · 1 mailbox',
    outreach: '100 prospects / month',
    priceId: STRIPE_PRICES.starter,
  },
  {
    tier: 'pro',
    name: 'Pro',
    monthlyPrice: 99,
    projects: '5 projects · 3 mailboxes',
    outreach: '300 prospects / month',
    priceId: STRIPE_PRICES.pro,
  },
  {
    tier: 'scale',
    name: 'Scale',
    monthlyPrice: 199,
    projects: 'Unlimited projects · 10 mailboxes',
    outreach: '800 prospects / month',
    priceId: STRIPE_PRICES.scale,
  },
];

export function tierRank(tier: PaidPlanTier): number {
  return PAID_TIERS.findIndex((t) => t.tier === tier);
}

export function tierName(tier: PaidPlanTier): string {
  return PAID_TIERS.find((t) => t.tier === tier)?.name ?? tier;
}

export function isPaidPlan(plan: PlanTier): plan is PaidPlanTier {
  return PAID_TIERS.some((t) => t.tier === plan);
}
