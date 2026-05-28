import type { InquiryOutcome } from './inquiry';

export interface EvaluationMetrics {
  totalOutreach: number;
  channelCounts: Array<{ channel: string; count: number }>;
  responseCounts: { totalResponses: number; uniqueResponders: number };
  sentimentBreakdown: Array<{ sentiment: string; responseType: string; count: number }>;
  priorityResponseRate: Array<{ priority: number; total: number; responses: number; rate: number }>;
  statusCounts: Array<{ status: string; count: number }>;
  channelResponseRate: Array<{ channel: string; total: number; responses: number; rate: number }>;
  inquiryOutcomeCounts: Record<InquiryOutcome, number>;
}

export interface Evaluation {
  id: number;
  evaluationDate: string;
  findings: string;
  improvements: string;
}

export interface ProjectStats {
  metrics: EvaluationMetrics;
  respondedMessages: Array<Record<string, unknown>>;
  noResponseSample: Array<Record<string, unknown>>;
  dataSufficiency: { sufficient: boolean; totalSent: number; daysSinceLastSend: number | null };
}
