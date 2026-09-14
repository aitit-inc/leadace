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
      // Past an allowance the excess is billed instead of refused.
      overageEnabled: boolean;
      // Distinct prospects first contacted in the window; follow-ups are free.
      contacted: AllowanceUsage;
      // Prospects the hosted discovery registered in the window.
      found: AllowanceUsage;
    };

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
