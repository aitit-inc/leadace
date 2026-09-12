import { describe, expect, it } from 'vitest';
import { mailboxState, orderMailboxes, warmupLabel } from './mailbox-status';
import type { SendingIdentity } from './types/sending-identity';

function identity(over: Partial<SendingIdentity>): SendingIdentity {
  return {
    identityId: 'id',
    provider: 'gmail_oauth',
    kind: 'gmail',
    parentIdentityId: null,
    signInAccount: false,
    fromEmail: 'a@example.com',
    warmupStartedAt: null,
    dailyCapOverride: null,
    sendRefusal: null,
    grantedAt: '2026-01-01T00:00:00Z',
    smtp: null,
    pausedUntil: null,
    heldUntil: null,
    cap: 10,
    used: 0,
    remaining: 10,
    rampWeek: 1,
    rampWeeks: 4,
    steadyStatePerDay: 25,
    bounceWindowDays: 30,
    sentInWindow: 0,
    bounced: 0,
    bounceRate: 0,
    ...over,
  };
}

const NOW = Date.parse('2026-09-13T00:00:00Z');

describe('mailboxState', () => {
  it('ranks revoked over refusal over pause', () => {
    const i = identity({
      sendRefusal: { since: '', lastAt: '', detail: '', sentThatDay: 0 },
      pausedUntil: '2026-09-20T00:00:00Z',
    });
    expect(mailboxState(i, true, NOW).label).toBe('Reconnect needed');
    expect(mailboxState(i, false, NOW).label).toBe('Refused by provider');
    expect(mailboxState(identity({ pausedUntil: '2026-09-20T00:00:00Z' }), false, NOW).tone).toBe(
      'warning',
    );
  });

  it('ignores a pause already in the past', () => {
    expect(mailboxState(identity({ pausedUntil: '2026-09-01T00:00:00Z' }), false, NOW).label).toBe(
      'Active',
    );
  });

  it('flags a zero cap override', () => {
    expect(mailboxState(identity({ dailyCapOverride: 0 }), false, NOW).label).toBe('Cap set to 0');
  });
});

describe('warmupLabel', () => {
  it('describes each ramp stage', () => {
    expect(warmupLabel(identity({}))).toBe('Warmup starts with the first send');
    expect(warmupLabel(identity({ warmupStartedAt: 'x', rampWeek: 2 }))).toBe('Warmup week 2 of 4');
    expect(warmupLabel(identity({ warmupStartedAt: 'x', rampWeek: 4 }))).toBe('Warmup complete');
    expect(warmupLabel(identity({ dailyCapOverride: 7 }))).toBe('Fixed 7/day');
  });
});

describe('orderMailboxes', () => {
  it('puts the sign-in Google first, each alias under its parent, SMTP last', () => {
    const rows = orderMailboxes([
      identity({ identityId: 'smtp', kind: 'smtp', provider: 'smtp_imap' }),
      identity({
        identityId: 'alias2',
        kind: 'gmail_alias',
        parentIdentityId: 'g2',
      }),
      identity({ identityId: 'g2' }),
      identity({
        identityId: 'alias1',
        kind: 'gmail_alias',
        parentIdentityId: 'g1',
      }),
      identity({ identityId: 'g1', signInAccount: true }),
    ]);
    expect(rows.map((r) => r.identityId)).toEqual(['g1', 'alias1', 'g2', 'alias2', 'smtp']);
  });

  it('keeps an alias whose parent is missing', () => {
    const rows = orderMailboxes([
      identity({
        identityId: 'orphan',
        kind: 'gmail_alias',
        parentIdentityId: 'gone',
      }),
    ]);
    expect(rows.map((r) => r.identityId)).toEqual(['orphan']);
  });
});
