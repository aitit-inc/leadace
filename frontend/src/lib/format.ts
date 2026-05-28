import type { OutreachWindowKind } from './types/plan';

export function formatQuota(used: number, limit: number | null): string {
  if (limit === null) return `${used.toLocaleString()} used`;
  return `${used.toLocaleString()} / ${limit.toLocaleString()}`;
}

export function formatQuotaCompact(used: number, limit: number | null): string {
  if (limit === null) return used.toLocaleString();
  return `${used.toLocaleString()}/${limit.toLocaleString()}`;
}

export const OUTREACH_WINDOW_LABEL: Record<OutreachWindowKind, string> = {
  daily: 'daily',
  lifetime: 'trial',
  monthly: 'monthly',
};
