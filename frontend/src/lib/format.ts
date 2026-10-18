import type { QuotaWindowKind } from './types/plan';
import type { ReachDiff, ReachSettings } from './types/dashboard';

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

const sameSet = (a: string[], b: string[]) => [...a].sort().join() === [...b].sort().join();

export function reachDiff(from: ReachSettings, to: ReachSettings): ReachDiff {
  return {
    ...(sameSet(from.outboundChannels, to.outboundChannels) ? {} : { outboundChannels: { from: from.outboundChannels, to: to.outboundChannels } }),
    ...(sameSet(from.targetCountries, to.targetCountries) ? {} : { targetCountries: { from: from.targetCountries, to: to.targetCountries } }),
    ...(from.targetLanguage === to.targetLanguage ? {} : { targetLanguage: { from: from.targetLanguage, to: to.targetLanguage } }),
  };
}

// No channel is a pause; no country limit is any country.
export function reachRows(diff: ReachDiff): { label: string; from: string; to: string }[] {
  const channels = (v: string[]) => (v.length === 0 ? 'none' : v.map((c) => c.replace(/_/g, ' ')).join(', '));
  const countries = (v: string[]) => (v.length === 0 ? 'any' : v.join(', '));
  return [
    diff.outboundChannels && {
      label: 'Channels',
      from: channels(diff.outboundChannels.from),
      to: channels(diff.outboundChannels.to),
    },
    diff.targetCountries && {
      label: 'Countries',
      from: countries(diff.targetCountries.from),
      to: countries(diff.targetCountries.to),
    },
    diff.targetLanguage && { label: 'Language', from: diff.targetLanguage.from, to: diff.targetLanguage.to },
  ].filter((r) => !!r);
}
