// Mirrors backend domain/dashboard.ts DashboardSummary (the GET
// /projects/:id/dashboard response). Keep in sync with that file.
import type { Channel } from './outreach';

export type DashboardPeriod = '7d' | '30d' | 'all';

export interface KpiValue {
  current: number;
  previous: number;
  deltaPct: number | null;
}

export type FunnelStageKey = 'sent' | 'reached' | 'engaged' | 'won';

export interface FunnelStage {
  key: FunnelStageKey;
  count: number;
  conversionFromPrev: number | null;
}

export interface DashboardTrendPoint {
  date: string;
  sent: number;
  responses: number;
}

export interface DashboardLearning {
  bestSubject: { pattern: string; replyRate: number; mature: boolean } | null;
  channelOrder: Array<{ channel: Channel; rate: number }>;
  testing: { activeVariants: number; needsNewAngle: boolean };
  state: 'learning' | 'optimizing';
}

export type RejectionRecontactWindow = 'never' | '3_months' | '6_months' | '12_months' | 'unspecified';

export interface DashboardRejections {
  total: number;
  topReasons: Array<{ reason: string; count: number; percentage: number }>;
  productSignal: { count: number } | null;
  recontactSoon: { window: RejectionRecontactWindow; count: number } | null;
}

export type DashboardActivityKind =
  | 'sent'
  | 'failed'
  | 'skipped'
  | 'opened'
  | 'inquired'
  | 'replied'
  | 'meeting'
  | 'signup'
  | 'unsubscribed';

export interface DashboardActivityEvent {
  at: string;
  prospectName: string;
  organizationDomain: string;
  channel: Channel;
  kind: DashboardActivityKind;
  detail: string | null;
}

export type QuotaConstraint = 'daily' | 'lifetime' | 'monthly';

export type AttentionItem =
  | { kind: 'mcp_not_connected' }
  | { kind: 'compliance_incomplete'; missing: string[] }
  | { kind: 'gmail_disconnected' }
  | { kind: 'no_outbound_channels' }
  | { kind: 'email_template_missing' }
  | { kind: 'quota_exhausted'; constraint: QuotaConstraint }
  | { kind: 'hot_leads'; count: number }
  | { kind: 'outreach_drafts'; count: number };

export interface DashboardSummary {
  period: DashboardPeriod;
  kpis: {
    approached: KpiValue;
    reached: KpiValue;
    engaged: KpiValue;
    won: KpiValue;
  };
  funnel: FunnelStage[];
  trend: DashboardTrendPoint[];
  replyRateTrend: { previous: number; current: number };
  learning: DashboardLearning;
  rejections: DashboardRejections;
  recentActivity: DashboardActivityEvent[];
  attention: AttentionItem[];
}
