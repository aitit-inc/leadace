import type { QuotaWindowKind } from './types/plan';

export function formatQuota(used: number, limit: number | null): string {
  if (limit === null) return `${used.toLocaleString()} used`;
  return `${used.toLocaleString()} / ${limit.toLocaleString()}`;
}

export function formatQuotaCompact(used: number, limit: number | null): string {
  if (limit === null) return used.toLocaleString();
  return `${used.toLocaleString()}/${limit.toLocaleString()}`;
}

export const QUOTA_WINDOW_LABEL: Record<QuotaWindowKind, string> = {
  lifetime: 'in total',
  monthly: 'this period',
};
