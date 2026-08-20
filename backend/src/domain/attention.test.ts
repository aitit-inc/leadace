import { describe, it, expect } from 'vitest'
import {
  deriveAttentionItems,
  deriveIdentityAttention,
  POLL_FAILING_ALERT_MS,
  type AttentionInput,
  type IdentityHealthInput,
} from './attention'

const NOW = new Date('2026-08-04T12:00:00.000Z')

const gmail = (over: Partial<IdentityHealthInput> = {}): IdentityHealthInput => ({
  fromEmail: 'a@example.com',
  provider: 'gmail_oauth',
  scope: 'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly',
  authRevokedAt: null,
  pollFailingSince: null,
  lastPollError: null,
  ...over,
})

describe('deriveIdentityAttention', () => {
  it('is empty for a healthy gmail identity', () => {
    expect(deriveIdentityAttention([gmail()], NOW)).toEqual([])
  })

  it('is empty for a healthy smtp_imap identity, which has no OAuth scope', () => {
    expect(deriveIdentityAttention([gmail({ provider: 'smtp_imap', scope: null })], NOW)).toEqual([])
  })

  it('flags a gmail identity missing the readonly scope', () => {
    expect(
      deriveIdentityAttention([gmail({ scope: 'https://www.googleapis.com/auth/gmail.send' })], NOW),
    ).toEqual([{ kind: 'reply_collection_scope_missing', fromEmail: 'a@example.com' }])
  })

  it('compares whole tokens, so a scope the readonly URL only prefixes does not count', () => {
    const items = deriveIdentityAttention(
      [gmail({ scope: 'https://www.googleapis.com/auth/gmail.readonly.metadata' })],
      NOW,
    )
    expect(items).toEqual([{ kind: 'reply_collection_scope_missing', fromEmail: 'a@example.com' }])
  })

  it('flags a revoked identity with the first detection time', () => {
    const at = new Date('2026-07-29T09:00:00.000Z')
    expect(deriveIdentityAttention([gmail({ authRevokedAt: at })], NOW)).toEqual([
      { kind: 'gmail_auth_revoked', fromEmail: 'a@example.com', since: at.toISOString() },
    ])
  })

  it('stays quiet while a poll-failure streak is younger than the threshold', () => {
    const since = new Date(NOW.getTime() - POLL_FAILING_ALERT_MS + 60_000)
    expect(
      deriveIdentityAttention(
        [gmail({ provider: 'smtp_imap', scope: null, pollFailingSince: since, lastPollError: 'LOGIN failed' })],
        NOW,
      ),
    ).toEqual([])
  })

  it('flags a persistent poll-failure streak with its start and last error', () => {
    const since = new Date(NOW.getTime() - POLL_FAILING_ALERT_MS)
    expect(
      deriveIdentityAttention(
        [gmail({ provider: 'smtp_imap', scope: null, pollFailingSince: since, lastPollError: 'LOGIN failed' })],
        NOW,
      ),
    ).toEqual([
      {
        kind: 'reply_collection_failing',
        fromEmail: 'a@example.com',
        since: since.toISOString(),
        detail: 'LOGIN failed',
      },
    ])
  })

  it('reports revoked only, when the scope is missing and the poll is failing too', () => {
    const items = deriveIdentityAttention(
      [
        gmail({
          scope: null,
          authRevokedAt: new Date('2026-07-29T09:00:00.000Z'),
          pollFailingSince: new Date('2026-07-29T09:00:00.000Z'),
          lastPollError: 'invalid_grant',
        }),
      ],
      NOW,
    )
    expect(items).toHaveLength(1)
    expect(items[0]?.kind).toBe('gmail_auth_revoked')
  })

  it('reports one item per affected identity', () => {
    const items = deriveIdentityAttention(
      [
        gmail(),
        gmail({ fromEmail: 'b@example.com', scope: null }),
        gmail({ fromEmail: 'c@example.com', authRevokedAt: new Date('2026-07-29T09:00:00.000Z') }),
      ],
      NOW,
    )
    expect(items.map((a) => a.fromEmail)).toEqual(['b@example.com', 'c@example.com'])
  })
})

describe('deriveAttentionItems', () => {
  const clean: AttentionInput = {
    mcpConnected: true,
    compliance: { ready: true, missing: [] },
    gmailConnected: true,
    identities: [],
    futileProjects: [],
    quota: { exhausted: false, constraint: null },
    now: NOW,
    project: { outboundChannelsConfigured: true, pendingDrafts: 0, hotLeadsRecent: 0 },
  }

  it('returns nothing when everything is healthy', () => {
    expect(deriveAttentionItems(clean)).toEqual([])
  })

  it('surfaces hot leads first (revenue opportunity), then the review queue', () => {
    const items = deriveAttentionItems({
      ...clean,
      project: { outboundChannelsConfigured: true, pendingDrafts: 4, hotLeadsRecent: 2 },
    })
    expect(items).toEqual([
      { kind: 'hot_leads', count: 2 },
      { kind: 'outreach_drafts', count: 4 },
    ])
  })

  it('orders opportunity → send blockers → degradation → review queue', () => {
    const items = deriveAttentionItems({
      ...clean,
      mcpConnected: false,
      compliance: { ready: false, missing: ['legalName'] },
      gmailConnected: false,
      identities: [
        gmail({
          fromEmail: 'dead@example.com',
          provider: 'smtp_imap',
          scope: null,
          pollFailingSince: new Date(NOW.getTime() - POLL_FAILING_ALERT_MS),
          lastPollError: 'LOGIN failed',
        }),
      ],
      quota: { exhausted: true, constraint: 'monthly' },
      futileProjects: [{ projectId: 'p-acme', projectName: 'Acme', sends: 400, replies: 0 }],
      project: { outboundChannelsConfigured: false, pendingDrafts: 3, hotLeadsRecent: 1 },
    })
    expect(items.map((i) => i.kind)).toEqual([
      'hot_leads',
      'mcp_not_connected',
      'compliance_incomplete',
      'gmail_disconnected',
      'no_outbound_channels',
      'quota_exhausted',
      'reply_collection_failing',
      'outreach_futility',
      'outreach_drafts',
    ])
  })

  it('surfaces futile projects in the tenant-wide feed, one item per project', () => {
    const items = deriveAttentionItems({
      ...clean,
      futileProjects: [
        { projectId: 'p-acme', projectName: 'Acme', sends: 400, replies: 0 },
        { projectId: 'p-globex', projectName: 'Globex', sends: 310, replies: 0 },
      ],
      project: null,
    })
    expect(items).toEqual([
      { kind: 'outreach_futility', projectId: 'p-acme', projectName: 'Acme', sends: 400, replies: 0 },
      { kind: 'outreach_futility', projectId: 'p-globex', projectName: 'Globex', sends: 310, replies: 0 },
    ])
  })

  it('places a revoked credential with the send blockers, not the degradation tail', () => {
    const items = deriveAttentionItems({
      ...clean,
      identities: [gmail({ authRevokedAt: new Date('2026-07-29T09:00:00.000Z') })],
      quota: { exhausted: true, constraint: 'daily' },
    })
    expect(items.map((i) => i.kind)).toEqual(['gmail_auth_revoked', 'quota_exhausted'])
  })

  it('omits quota_exhausted when there is no binding constraint', () => {
    const items = deriveAttentionItems({ ...clean, quota: { exhausted: true, constraint: null } })
    expect(items).toEqual([])
  })

  it('carries the compliance missing fields and quota constraint through', () => {
    const items = deriveAttentionItems({
      ...clean,
      compliance: { ready: false, missing: ['physicalAddress', 'defaultSenderCountry'] },
      quota: { exhausted: true, constraint: 'daily' },
    })
    expect(items).toContainEqual({
      kind: 'compliance_incomplete',
      missing: ['physicalAddress', 'defaultSenderCountry'],
    })
    expect(items).toContainEqual({ kind: 'quota_exhausted', constraint: 'daily' })
  })

  it('emits no project items for the tenant-wide feed (project: null)', () => {
    const items = deriveAttentionItems({
      ...clean,
      mcpConnected: false,
      project: null,
    })
    expect(items).toEqual([{ kind: 'mcp_not_connected' }])
  })
})
