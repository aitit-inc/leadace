import type { SendingIdentity } from '$lib/types/sending-identity';

export type MailboxState = { tone: 'ok' | 'warning' | 'danger'; label: string };

export function mailboxState(i: SendingIdentity, revoked: boolean, now = Date.now()): MailboxState {
  if (revoked) return { tone: 'danger', label: 'Reconnect needed' };
  if (i.sendRefusal) return { tone: 'danger', label: 'Refused by provider' };
  if (i.pausedUntil && new Date(i.pausedUntil).getTime() > now) {
    return {
      tone: 'warning',
      label: `Paused until ${new Date(i.pausedUntil).toLocaleDateString()}`,
    };
  }
  if (i.dailyCapOverride === 0) return { tone: 'warning', label: 'Cap set to 0' };
  return { tone: 'ok', label: 'Active' };
}

export function warmupLabel(i: SendingIdentity): string {
  if (i.dailyCapOverride !== null) return `Fixed ${i.dailyCapOverride}/day`;
  if (!i.warmupStartedAt) return 'Warmup starts with the first send';
  if (i.rampWeek >= i.rampWeeks) return 'Warmup complete';
  return `Warmup week ${i.rampWeek} of ${i.rampWeeks}`;
}

export function kindLabel(i: SendingIdentity, parent: SendingIdentity | undefined): string {
  switch (i.kind) {
    case 'gmail':
      return i.signInAccount ? 'Sign-in Google' : 'Google';
    case 'gmail_alias':
      return parent ? `Alias of ${parent.fromEmail}` : 'Alias';
    case 'smtp':
      return i.smtp ? `SMTP · ${i.smtp.smtpHost}` : 'SMTP';
  }
}

// Sign-in Google first, every Google account followed by its aliases, SMTP last.
export function orderMailboxes(identities: SendingIdentity[]): SendingIdentity[] {
  const gmails = identities
    .filter((i) => i.kind === 'gmail')
    .sort((a, b) => Number(b.signInAccount) - Number(a.signInAccount));
  const withAliases = gmails.flatMap((g) => [
    g,
    ...identities.filter((i) => i.parentIdentityId === g.identityId),
  ]);
  const orphanAliases = identities.filter(
    (i) => i.kind === 'gmail_alias' && !gmails.some((g) => g.identityId === i.parentIdentityId),
  );
  const smtp = identities.filter((i) => i.kind === 'smtp');
  return [...withAliases, ...orphanAliases, ...smtp];
}
