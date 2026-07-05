export type PlanTier = 'free' | 'starter' | 'pro' | 'scale' | 'unlimited';

export type OutreachWindowKind = 'daily' | 'lifetime' | 'monthly';

export interface QuotaUsage {
  used: number;
  remaining: number;
  limit: number | null;
}

export interface OutreachQuotaWindow {
  used: number;
  remaining: number;
  limit: number;
}

// kind 'unlimited' = Scale, complimentary 'unlimited', or any plan with no configured caps.
export type OutreachQuota =
  | {
      plan: PlanTier;
      kind: 'unlimited';
      used: number;
    }
  | {
      plan: PlanTier;
      kind: 'capped';
      used: number;
      limit: number;
      remaining: number;
      bindingConstraint: OutreachWindowKind;
      daily?: OutreachQuotaWindow;
      lifetime?: OutreachQuotaWindow;
      monthly?: OutreachQuotaWindow;
    };

export interface PlanInfo {
  plan: PlanTier;
  limits: {
    maxProjects: number | null;
    maxOutreachPerDay: number | null;
    maxOutreachLifetime: number | null;
    maxOutreachPerMonth: number | null;
    maxProspects: number | null;
  };
  outreach: OutreachQuota;
  prospects?: QuotaUsage;
}
