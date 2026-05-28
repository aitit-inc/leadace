import type { SnsAccounts } from './types/prospects';

interface ContactSource {
  email: string | null;
  contactFormUrl: string | null;
  snsAccounts: SnsAccounts | null;
}

export function channelLabel(p: ContactSource): string {
  const parts: string[] = [];
  if (p.email) parts.push('Email');
  if (p.contactFormUrl) parts.push('Form');
  if (p.snsAccounts?.x) parts.push('X');
  if (p.snsAccounts?.linkedin) parts.push('LI');
  return parts.join(', ') || '-';
}
