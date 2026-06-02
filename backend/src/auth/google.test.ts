import { describe, expect, it } from 'vitest'
import { buildComplianceAttachments } from './google'
import { asTenantId } from '../domain/ids'

// Locks the opt-out invariants of the compliance footer: the List-Unsubscribe
// header is unconditional (mailbox-provider requirement), and the visible body
// opt-out switches between the inquiry link and the standalone Unsubscribe line
// on inquiryUrl presence. signUnsubscribeToken is HMAC (deterministic), so no
// mocks are needed.
describe('buildComplianceAttachments', () => {
  const base = {
    prospectId: 1,
    tenantId: asTenantId('tenant-1'),
    appUrl: 'https://app.example',
    apiUrl: 'https://api.example',
    secret: 'test-secret',
    tenantLegalName: 'Acme Inc.',
    tenantPhysicalAddress: '1 Main St',
    tenantPrivacyPolicyUrl: null as string | null,
  }

  it('collapses to the inquiry link and drops the standalone Unsubscribe line when inquiry is enabled', async () => {
    const { footer, headers } = await buildComplianceAttachments({
      ...base,
      inquiryUrl: 'https://app.example/q/abc123',
    })
    expect(footer).toContain(
      'Learn more, ask anything, or unsubscribe: https://app.example/q/abc123',
    )
    expect(footer).not.toMatch(/^Unsubscribe: /m)
    expect(headers['List-Unsubscribe']).toContain('https://api.example/api/unsubscribe/')
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
  })

  it('keeps the standalone Unsubscribe line when inquiry is disabled', async () => {
    const { footer, headers } = await buildComplianceAttachments({ ...base, inquiryUrl: null })
    expect(footer).toMatch(/^Unsubscribe: https:\/\/app\.example\/unsubscribe\//m)
    expect(footer).not.toContain('Learn more')
    expect(headers['List-Unsubscribe']).toContain('https://api.example/api/unsubscribe/')
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
  })

  it('always emits the List-Unsubscribe header regardless of inquiry mode', async () => {
    const enabled = await buildComplianceAttachments({
      ...base,
      inquiryUrl: 'https://app.example/q/x',
    })
    const disabled = await buildComplianceAttachments({ ...base, inquiryUrl: null })
    expect(enabled.headers['List-Unsubscribe']).toBeDefined()
    expect(disabled.headers['List-Unsubscribe']).toBeDefined()
  })
})
