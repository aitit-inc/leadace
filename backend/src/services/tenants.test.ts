import { describe, it, expect } from 'vitest'
import {
  computeComplianceMissing,
  localizeComplianceIdentity,
  type TenantComplianceProjection,
} from './tenants'

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
})

describe('localizeComplianceIdentity', () => {
  const base: TenantComplianceProjection = {
    legalName: 'Acme Inc.',
    physicalAddress: '1 Main St, SF, CA',
    defaultSenderCountry: 'US',
    legalNameJa: 'アクメ株式会社',
    physicalAddressJa: '東京都千代田区1-1-1',
  }

  it('returns the default identity for non-JP recipients, ignoring JA variants', () => {
    expect(localizeComplianceIdentity(base, 'en')).toEqual({
      legalName: 'Acme Inc.',
      physicalAddress: '1 Main St, SF, CA',
    })
  })

  it('returns the JA variants for JP recipients when set', () => {
    expect(localizeComplianceIdentity(base, 'ja')).toEqual({
      legalName: 'アクメ株式会社',
      physicalAddress: '東京都千代田区1-1-1',
    })
  })

  it('falls back to the default per-field when a JA variant is null', () => {
    const partial: TenantComplianceProjection = {
      ...base,
      physicalAddressJa: null,
    }
    expect(localizeComplianceIdentity(partial, 'ja')).toEqual({
      legalName: 'アクメ株式会社',
      physicalAddress: '1 Main St, SF, CA',
    })
  })
})
