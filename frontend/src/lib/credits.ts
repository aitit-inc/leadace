import type { CreditState } from '$lib/types/plan';

// Mirrors backend/src/domain/credits.ts creditsCoverOverage / formatCents.
export function creditsCoverOverage(credits: CreditState, priceCents: number): boolean {
  return credits !== null && credits.balanceCents >= priceCents;
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

export type DollarField = { cents: number; error: null } | { cents: null; error: string };

// `step` is the smallest unit the field accepts, in cents: 100 for whole
// dollars, 1 for cents.
export function parseDollars(text: string, range: { min: number; max: number }, step: 100 | 1): DollarField {
  const trimmed = text.trim();
  if (trimmed === '') return { cents: null, error: 'Enter an amount.' };
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!match) return { cents: null, error: 'Enter an amount like 12 or 12.50.' };
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  if (cents < range.min || cents > range.max) {
    return { cents: null, error: `Must be between ${formatDollars(range.min)} and ${formatDollars(range.max)}.` };
  }
  if (cents % step !== 0) return { cents: null, error: 'Whole dollars only.' };
  return { cents, error: null };
}

export function formatDollars(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : formatCents(cents);
}
