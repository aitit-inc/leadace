import { describe, it, expect } from 'vitest'
import { isAllowedRedirectUri, readOnlyRequested, verifyPkce } from './oauth'

// S256 challenge for the verifier below, precomputed so the expectation is a
// fixed value rather than a re-run of the implementation.
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'

describe('isAllowedRedirectUri', () => {
  it('accepts https on any host', () => {
    expect(isAllowedRedirectUri('https://claude.ai/api/mcp/auth_callback')).toBe(true)
  })

  it('accepts http only on loopback', () => {
    expect(isAllowedRedirectUri('http://127.0.0.1:8080/callback')).toBe(true)
    expect(isAllowedRedirectUri('http://localhost:8080/callback')).toBe(true)
    expect(isAllowedRedirectUri('http://[::1]:8080/callback')).toBe(true)
  })

  it('rejects http on a non-loopback host', () => {
    expect(isAllowedRedirectUri('http://evil.example/callback')).toBe(false)
    // Loopback name as a subdomain of an attacker host must not pass.
    expect(isAllowedRedirectUri('http://localhost.evil.example/callback')).toBe(false)
    // Credentials cannot smuggle a loopback host past the check either.
    expect(isAllowedRedirectUri('http://127.0.0.1@evil.example/callback')).toBe(false)
  })

  it('rejects script-execution and local-file schemes', () => {
    expect(isAllowedRedirectUri('javascript:alert(document.domain)')).toBe(false)
    expect(isAllowedRedirectUri('data:text/html,<script>1</script>')).toBe(false)
    expect(isAllowedRedirectUri('file:///etc/passwd')).toBe(false)
  })

  it('rejects values the URL parser cannot parse', () => {
    expect(isAllowedRedirectUri('')).toBe(false)
    expect(isAllowedRedirectUri('/callback')).toBe(false)
    expect(isAllowedRedirectUri('not a url')).toBe(false)
  })
})

describe('verifyPkce', () => {
  it('accepts the verifier its challenge was derived from', async () => {
    expect(await verifyPkce(VERIFIER, CHALLENGE)).toBe(true)
  })

  it('rejects a different verifier', async () => {
    expect(await verifyPkce('wrong-verifier', CHALLENGE)).toBe(false)
    expect(await verifyPkce(`${VERIFIER}x`, CHALLENGE)).toBe(false)
  })

  it('rejects a plain challenge, so a code_challenge_method downgrade cannot pass', async () => {
    expect(await verifyPkce(VERIFIER, VERIFIER)).toBe(false)
  })

  it('rejects an empty challenge', async () => {
    expect(await verifyPkce(VERIFIER, '')).toBe(false)
  })
})

describe('readOnlyRequested', () => {
  const BASE = 'https://mcp.example.com'

  it('is read-only when the resource is the read endpoint', () => {
    expect(readOnlyRequested(null, `${BASE}/mcp/read`, BASE)).toBe(true)
    expect(readOnlyRequested(null, `${BASE}/mcp/read/`, BASE)).toBe(true)
    expect(readOnlyRequested('read write', `${BASE}/mcp/read`, BASE)).toBe(true)
  })

  it('is read-only when the scope asks for read without write', () => {
    expect(readOnlyRequested('read', null, BASE)).toBe(true)
    expect(readOnlyRequested('read offline_access', `${BASE}/mcp`, BASE)).toBe(true)
  })

  it('may write when nothing asks for less', () => {
    expect(readOnlyRequested(null, null, BASE)).toBe(false)
    expect(readOnlyRequested('read write', BASE, BASE)).toBe(false)
    expect(readOnlyRequested('write', `${BASE}/mcp`, BASE)).toBe(false)
    expect(readOnlyRequested('', '', BASE)).toBe(false)
  })

  it('does not take a look-alike resource for the read endpoint', () => {
    expect(readOnlyRequested(null, 'https://evil.example/mcp/read', BASE)).toBe(false)
    expect(readOnlyRequested(null, `${BASE}/mcp/readonly`, BASE)).toBe(false)
    // A scope that merely contains the word is not the read scope.
    expect(readOnlyRequested('readwrite', null, BASE)).toBe(false)
  })
})
