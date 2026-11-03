// Mirrors backend domain/dashboard.ts DashboardSummary (the GET
// /projects/:id/dashboard response).
import type { Channel } from './outreach';
import type { AttentionItem } from './attention';

export type { AttentionItem, QuotaConstraint } from './attention';

export type DashboardPeriod = '7d' | '30d' | 'all';

export interface KpiValue {
  current: number;
  previous: number;
  deltaPct: number | null;
}

export type FunnelStageKey = 'sent' | 'delivered' | 'reached' | 'engaged' | 'won';

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

// Percentages of the sends or prospects counted: positive, and positive or interest.
export interface ReactionRates {
  positiveRate: number;
  interestedRate: number;
}

// Mirrors backend domain/history.ts HistoryRow. The backend words it, so every surface reads the same.
export interface HistoryRow {
  date: string;
  // null on a day's work: nobody decided it.
  who: 'You' | 'Ace' | 'Rule' | null;
  text: string;
  notes: string[];
  result: string | null;
}

export type ReachSettings = { outboundChannels: string[]; targetCountries: string[]; targetLanguage: string };

export type ReachDiff = {
  outboundChannels?: { from: string[]; to: string[] };
  targetCountries?: { from: string[]; to: string[] };
  targetLanguage?: { from: string; to: string };
};

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

export type SegmentAxis = 'industry' | 'employeeBand' | 'country' | 'discoveryStrategy';

export interface SegmentRow extends ReactionRates {
  value: string;
  sent: number;
}

export interface DashboardSegment {
  axis: SegmentAxis;
  rows: SegmentRow[];
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

export interface RateChange {
  previous: number;
  current: number;
}

export interface DashboardResearch {
  researched: number;
  notFit: number;
  notFitPercent: number;
  noContact: number;
  notFitExamples: Array<{ organizationName: string; reason: string }>;
}

export interface DashboardResponder {
  prospectName: string;
  organizationName: string;
  level: 'positive' | 'interest';
}

export interface DashboardSummary {
  period: DashboardPeriod;
  kpis: {
    approached: KpiValue;
    delivered: KpiValue;
    reached: KpiValue;
    engaged: KpiValue;
    won: KpiValue;
  };
  funnel: FunnelStage[];
  trend: DashboardTrendPoint[];
  reactionRates: { positive: RateChange; interested: RateChange };
  history: HistoryRow[];
  lastCycleDate: string | null;
  rejections: DashboardRejections;
  segments: DashboardSegment[];
  research: DashboardResearch;
  responders: DashboardResponder[];
  recentActivity: DashboardActivityEvent[];
  attention: AttentionItem[];
}
