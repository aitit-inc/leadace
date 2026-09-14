export type PlanTier = 'free' | 'starter' | 'pro' | 'scale' | 'unlimited';

// Mirrors backend/src/services/plan-limits.ts `ProspectQuota`.
export type QuotaWindowKind = 'lifetime' | 'monthly';

export interface QuotaUsage {
  used: number;
  remaining: number;
  limit: number | null;
}

export interface AllowanceUsage {
  used: number;
  remaining: number;
  limit: number;
}

// kind 'unlimited' = the complimentary 'unlimited' tier or a self-hosted install.
export type ProspectQuota =
  | {
      plan: PlanTier;
      kind: 'unlimited';
    }
  | {
      plan: PlanTier;
      kind: 'capped';
      window: QuotaWindowKind;
      // Prepaid credits (backend domain/credits.ts CreditState); null = the plan
      // cannot hold them. Past an allowance the excess is debited while the
      // balance pays for the unit in full.
      credits: CreditState;
      // Distinct prospects first contacted in the window; follow-ups are free.
      contacted: AllowanceUsage;
      // Prospects the hosted discovery registered in the window.
      found: AllowanceUsage;
    };

export interface AutoTopUp {
  enabled: boolean;
  amountCents: number;
  thresholdCents: number;
  failedAt: string | null;
}

export type CreditState = { balanceCents: number; autoTopUp: AutoTopUp } | null;

// Mirrors backend/src/domain/credits.ts.
export const USAGE_PRICE_CENTS = { contacted: 40, found: 60 } as const;
export const CREDIT_PACK_CENTS = [1000, 2500, 5000] as const;
export type CreditPackCents = (typeof CREDIT_PACK_CENTS)[number];

export interface PlanInfo {
  plan: PlanTier;
  limits: {
    maxProjects: number | null;
    maxProspects: number | null;
  };
  quota: ProspectQuota;
  // Stored prospects against the storage cap; absent when uncapped.
  prospects?: QuotaUsage;
}
