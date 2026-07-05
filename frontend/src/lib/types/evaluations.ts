import type { InquiryOutcome } from './inquiry';

export interface EvaluationMetrics {
  totalOutreach: number;
  channelCounts: Array<{ channel: string; count: number }>;
  responseCounts: { totalResponses: number; uniqueResponders: number };
  sentimentBreakdown: Array<{ sentiment: string; responseType: string; count: number }>;
  priorityResponseRate: Array<{ priority: number; total: number; responses: number; rate: number }>;
  statusCounts: Array<{ status: string; count: number }>;
  channelResponseRate: Array<{ channel: string; total: number; responses: number; rate: number }>;
  channelByIndustry: Array<{ channel: string; industry: string | null; total: number; responses: number; rate: number }>;
  variantResponseRate: Array<{ variantId: string; total: number; responses: number; rate: number; meanReward: number }>;
  discoveryStrategyResponseRate: Array<{ strategy: string | null; total: number; responses: number; rate: number }>;
  freshSignalResponseRate: {
    withSignal: { total: number; responses: number; rate: number };
    withoutSignal: { total: number; responses: number; rate: number };
  };
  inquiryOutcomeCounts: Record<InquiryOutcome, number>;
}

/** Mirrors backend `services/evaluations.ts` DailyActivity. */
export interface DailyActivity {
  date: string;
  sent: number;
  responses: number;
}

export interface ProjectStats {
  metrics: EvaluationMetrics;
  respondedMessages: Array<Record<string, unknown>>;
  noResponseSample: Array<Record<string, unknown>>;
  dataSufficiency: { sufficient: boolean; totalSent: number; daysSinceLastSend: number | null };
  dailyActivity: DailyActivity[];
}
