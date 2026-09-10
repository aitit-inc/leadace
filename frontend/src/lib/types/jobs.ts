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
  logEntries: number;
};

type ProspectOutcome =
  | { outcome: 'sent' | 'drafted'; subject: string }
  | { outcome: 'skipped' | 'failed'; reason: string }
  | { outcome: 'needs_hands' };

// Mirrors backend domain/jobs.ts JobLogLine, less `step` (the writer's dedupe key).
export type JobLogLine = { at: string } & (
  | { kind: 'stage'; stage: JobKind; summary: string }
  | { kind: 'decision'; text: string }
  | ({ kind: 'prospect'; name: string } & ProspectOutcome)
);

// Mirrors backend services/jobs.ts JobDetail.
export type JobDetail = Job & { log: JobLogLine[] };

export const JOB_ORIGIN_LABELS: Record<JobOrigin, string> = {
  cron: 'Scheduled run',
  chat: 'Chat',
  ui: 'Web UI',
  mcp: 'External agent',
};

export const PROSPECT_OUTCOME_LABELS: Record<ProspectOutcome['outcome'], string> = {
  sent: 'sent',
  drafted: 'drafted for review',
  skipped: 'skipped',
  needs_hands: 'needs a browser (form / SNS)',
  failed: 'failed',
};

export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ['succeeded', 'failed', 'cancelled'];

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  queued: 'waiting',
  running: 'running',
  succeeded: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
};

export const JOB_KIND_LABELS: Record<JobKind, string> = {
  daily_cycle: 'Daily cycle',
  discover: 'Find prospects',
  enrich: 'Read sites',
  draft: 'Draft outreach',
  send: 'Send drafts',
  evaluate: 'Evaluate',
  journal: 'Public journal',
};
