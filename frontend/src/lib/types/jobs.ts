// Mirrors backend domain/jobs.ts + services/jobs.ts JobView.
export type JobKind = 'daily_cycle' | 'discover' | 'enrich' | 'draft' | 'send' | 'evaluate' | 'journal';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type JobOrigin = 'cron' | 'chat' | 'ui' | 'mcp';

export type JobProgress = { step: string; done: number; total: number | null };

export type Job = {
  id: string;
  projectId: string;
  kind: JobKind;
  status: JobStatus;
  progress: JobProgress | null;
  result: { kind: JobKind; summary: string } | null;
  error: string | null;
  startedBy: JobOrigin;
  threadId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ['succeeded', 'failed', 'cancelled'];

export const JOB_KIND_LABELS: Record<JobKind, string> = {
  daily_cycle: 'Daily cycle',
  discover: 'Find prospects',
  enrich: 'Read sites',
  draft: 'Draft outreach',
  send: 'Send drafts',
  evaluate: 'Evaluate',
  journal: 'Public journal',
};
