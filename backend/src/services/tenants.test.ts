import { describe, it, expect } from 'vitest'
import { computeComplianceMissing, COMPLIANCE_FIELDS } from './tenants'

const ready = {
  legalName: 'Acme Inc.',
  physicalAddress: '1 Main St',
  defaultSenderCountry: 'US',
}

describe('computeComplianceMissing', () => {
  it('returns [] when all three send-gating fields are present', () => {
    expect(computeComplianceMissing(ready)).toEqual([])
  })

  it('reports each individually-missing field', () => {
    expect(computeComplianceMissing({ ...ready, legalName: null })).toEqual(['legalName'])
    expect(computeComplianceMissing({ ...ready, physicalAddress: null })).toEqual(['physicalAddress'])
    expect(computeComplianceMissing({ ...ready, defaultSenderCountry: null })).toEqual([
      'defaultSenderCountry',
    ])
  })

  it('treats an empty string as missing (not just null)', () => {
    expect(computeComplianceMissing({ ...ready, legalName: '' })).toEqual(['legalName'])
  })

  it('lists all three when none are set', () => {
    expect(
      computeComplianceMissing({ legalName: null, physicalAddress: null, defaultSenderCountry: null }),
    ).toEqual(['legalName', 'physicalAddress', 'defaultSenderCountry'])
  })

  it('never gates on privacyPolicyUrl (not a compliance field)', () => {
    expect(COMPLIANCE_FIELDS).not.toContain('privacyPolicyUrl')
    expect(computeComplianceMissing(ready)).toEqual([])
  })
})
