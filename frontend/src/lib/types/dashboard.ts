// Mirrors backend domain/dashboard.ts DashboardSummary (the GET
// /projects/:id/dashboard response).
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

export type LearningStage = 'targeting' | 'body' | 'timing' | 'channel' | 'discovery';

export interface LearningEntry {
  stage: LearningStage;
  date: string;
  claim: string;
  evidence: string | null;
}

export interface LearningAngle {
  variantId: string;
  label: string | null;
  total: number;
  responses: number;
  replyRate: number;
  mature: boolean;
  leader: boolean;
}

export interface DashboardLearning {
  bestSubject: { pattern: string; replyRate: number; mature: boolean; n: number } | null;
  angles: LearningAngle[];
  needsNewAngle: boolean;
  state: 'learning' | 'optimizing';
  log: LearningEntry[];
}

export type JournalEvent =
  | {
      date: string;
      kind: 'variant_archived';
      variantId: string;
      label: string | null;
      reason: 'stagnation' | 'dominated';
      pBest: number | null;
      n: number | null;
    }
  | { date: string; kind: 'variant_added'; variantId: string; label: string | null }
  | { date: string; kind: 'strategy_escalated'; title: string };

export type RejectionRecontactWindow = 'never' | '3_months' | '6_months' | '12_months' | 'unspecified';

export interface RejectionQuote {
  freeText: string;
  prospectName: string;
  organizationName: string;
}

export interface DecisionMakerReferral {
  prospectName: string;
  organizationName: string;
  name: string | null;
  email: string | null;
  role: string | null;
}

export interface NotRelevantNote {
  freeText: string;
  industry: string | null;
  prospectName: string;
  organizationName: string;
}

export interface DashboardRejections {
  total: number;
  topReasons: Array<{ reason: string; count: number; percentage: number }>;
  productSignal: { count: number; quotes: RejectionQuote[] } | null;
  budgetSignal: { count: number; quotes: RejectionQuote[] } | null;
  decisionMakers: DecisionMakerReferral[];
  notRelevant: NotRelevantNote[];
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
  journal: JournalEvent[];
  lastCycleDate: string | null;
  rejections: DashboardRejections;
  recentActivity: DashboardActivityEvent[];
  attention: AttentionItem[];
}
