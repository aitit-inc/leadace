import type { CreditState } from '$lib/types/plan';

// Mirrors backend/src/domain/credits.ts creditsCoverOverage / formatCents.
export function creditsCoverOverage(credits: CreditState, priceCents: number): boolean {
  return credits !== null && credits.balanceCents >= priceCents;
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}
