import { describe, it, expect } from 'vitest'
import {
  isEmailSyntaxValid,
  domainOf,
  domainCanReceiveMail,
  dnsDeliverabilityVerdict,
  isReservedDomain,
  RESERVED_NAME_SQL_PATTERN,
} from './email-deliverability'

describe('isEmailSyntaxValid', () => {
  it('accepts a well-formed address', () => {
    expect(isEmailSyntaxValid('jane@example.com')).toBe(true)
    expect(isEmailSyntaxValid('  jane@example.com  ')).toBe(true)
  })
  it('rejects malformed addresses', () => {
    expect(isEmailSyntaxValid('no-at-sign')).toBe(false)
    expect(isEmailSyntaxValid('no-domain@')).toBe(false)
    expect(isEmailSyntaxValid('no-tld@example')).toBe(false)
    expect(isEmailSyntaxValid('two spaces@exa mple.com')).toBe(false)
  })
})

describe('domainOf', () => {
  it('extracts and lowercases the domain', () => {
    expect(domainOf('Jane@Example.COM')).toBe('example.com')
  })
})

describe('isReservedDomain', () => {
  it('flags RFC 2606/6761 reserved TLDs and example.* domains', () => {
    expect(isReservedDomain('acme-run-123.example')).toBe(true)
    expect(isReservedDomain('foo.test')).toBe(true)
    expect(isReservedDomain('foo.invalid')).toBe(true)
    expect(isReservedDomain('localhost')).toBe(true)
    expect(isReservedDomain('EXAMPLE.COM')).toBe(true)
  })
  it('flags subdomains of a reserved name', () => {
    expect(isReservedDomain('test004.example.com')).toBe(true)
    expect(isReservedDomain('acme.example.org')).toBe(true)
  })
  it('does not flag real domains', () => {
    expect(isReservedDomain('surpassone.com')).toBe(false)
    expect(isReservedDomain('example.io')).toBe(false)
    expect(isReservedDomain('notexample.com')).toBe(false)
    expect(isReservedDomain('')).toBe(false)
  })
})

describe('RESERVED_NAME_SQL_PATTERN', () => {
  it('classifies the same names as isReservedDomain', () => {
    const re = new RegExp(RESERVED_NAME_SQL_PATTERN)
    for (const d of [
      'example.com',
      'test004.example.com',
      'acme.example.org',
      'foo.test',
      'acme-run-123.example',
      'localhost',
      'surpassone.com',
      'example.io',
      'notexample.com',
      'spotter',
    ]) {
      expect([d, re.test(d)]).toEqual([d, isReservedDomain(d)])
    }
  })
})

describe('domainCanReceiveMail', () => {
  it('is true when the domain has MX hosts', () => {
    expect(domainCanReceiveMail({ mx: ['10 aspmx.l.google.com.'], a: [], aaaa: [] })).toBe(true)
  })
  it('is false for an RFC 7505 null-MX record', () => {
    expect(domainCanReceiveMail({ mx: ['0 .'], a: [], aaaa: [] })).toBe(false)
  })
  it('falls back to implicit MX (A / AAAA) when there is no MX', () => {
    expect(domainCanReceiveMail({ mx: [], a: ['93.184.216.34'], aaaa: [] })).toBe(true)
    expect(domainCanReceiveMail({ mx: [], a: [], aaaa: ['2606:2800:220:1:248:1893:25c8:1946'] })).toBe(true)
  })
  it('is false when the domain has no MX and no A/AAAA', () => {
    expect(domainCanReceiveMail({ mx: [], a: [], aaaa: [] })).toBe(false)
  })
  it('treats multiple MX records as deliverable (null-MX must be the sole record)', () => {
    expect(domainCanReceiveMail({ mx: ['0 .', '10 mail.example.com.'], a: [], aaaa: [] })).toBe(true)
  })
})

describe('dnsDeliverabilityVerdict', () => {
  it('drops invalid syntax regardless of DNS', () => {
    expect(dnsDeliverabilityVerdict({ syntaxValid: false, dnsResolved: false, canReceiveMail: false }))
      .toBe('undeliverable')
  })
  it('fails open to unknown when DNS could not be resolved', () => {
    expect(dnsDeliverabilityVerdict({ syntaxValid: true, dnsResolved: false, canReceiveMail: false }))
      .toBe('unknown')
  })
  it('accepts (unknown) a resolvable domain that can receive mail', () => {
    expect(dnsDeliverabilityVerdict({ syntaxValid: true, dnsResolved: true, canReceiveMail: true }))
      .toBe('unknown')
  })
  it('drops a resolvable domain that provably cannot receive mail', () => {
    expect(dnsDeliverabilityVerdict({ syntaxValid: true, dnsResolved: true, canReceiveMail: false }))
      .toBe('undeliverable')
  })
})
