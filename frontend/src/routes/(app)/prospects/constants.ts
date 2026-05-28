import type { ProspectStatus } from '$lib/types/prospects';

export const STATUSES: ProspectStatus[] = [
  'new',
  'contacted',
  'responded',
  'converted',
  'rejected',
  'inactive',
  'deferred',
];
