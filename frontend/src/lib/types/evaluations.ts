import type { InquiryOutcome } from './inquiry';
import type { EmployeeBand } from './organizations';

// Sends whose strongest reaction was positive, and positive or interest
// (backend domain/loop/reaction). Rates are percentages of the bucket's total.
export interface Reactions {
  positive: number;
  positiveRate: number;
  interested: number;
  interestedRate: number;
}

export interface EvaluationMetrics {
  totalOutreach: number;
  // Mature sends (older than the reward window) and their reactions.
  kpi: { matureSent: number } & Reactions;
  channelCounts: Array<{ channel: string; count: number }>;
  responseCounts: { totalResponses: number; uniqueResponders: number };
  sentimentBreakdown: Array<{ sentiment: string; responseType: string; count: number }>;
  priorityResponseRate: Array<{ priority: number; total: number; responses: number; rate: number } & Reactions>;
  statusCounts: Array<{ status: string; count: number }>;
  channelResponseRate: Array<{ channel: string; total: number; responses: number; rate: number } & Reactions>;
  channelByIndustry: Array<{ channel: string; industry: string | null; total: number; responses: number; rate: number } & Reactions>;
  variantResponseRate: Array<{ variantId: string; label: string | null; active: boolean; total: number; responses: number; rate: number; meanReward: number } & Reactions>;
  discoveryStrategyResponseRate: Array<{ strategy: string | null; total: number; responses: number; rate: number; bounces: number; bounceRate: number } & Reactions>;
  // Targeting observation axes (backend EvaluationMetrics): mature sends only.
  industryResponseRate: Array<{ industry: string; total: number; responses: number; rate: number; bounces: number; bounceRate: number } & Reactions>;
  sizeResponseRate: Array<{ employeeBand: EmployeeBand; total: number; responses: number; rate: number; bounces: number; bounceRate: number } & Reactions>;
  countryResponseRate: Array<{ country: string | null; total: number; responses: number; rate: number; bounces: number; bounceRate: number } & Reactions>;
  inquiryOutcomeCounts: Record<InquiryOutcome, number>;
}

/** Mirrors backend `services/loop/observe.ts` DailyActivity. */
export interface DailyActivity {
  date: string;
  sent: number;
  responses: number;
}

export interface ProjectStats {
  metrics: EvaluationMetrics;
  respondedMessages: Array<Record<string, unknown>>;
  noResponseSample: Array<Record<string, unknown>>;
  dataSufficiency: { sufficient: boolean; totalSent: number; settledSent: number };
  dailyActivity: DailyActivity[];
}
