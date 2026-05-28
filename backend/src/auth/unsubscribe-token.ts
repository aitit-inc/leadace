// HMAC-SHA256-signed unsubscribe tokens embedded in outbound email links
// (e.g. https://app.leadace.ai/unsubscribe/:token). Long-lived: a recipient
// who unsubscribes a year later still expects their old link to work.
// The token IS the auth — no DB lookup, no logged-in user.
//
// Token format: `${prospectId}.${tenantId}.${sig}`
//   sig = base64url(HMAC-SHA256(secret, `${prospectId}:${tenantId}`))
// `tenantId` is a nanoid (no dots), `prospectId` is an integer, so splitting
// by "." is unambiguous.

import type { TenantId } from '../domain/ids'
import { timingSafeEqual } from '../domain/timing-safe'

export class InvalidUnsubscribeTokenError extends Error {
  constructor(reason: string) {
    super(`Invalid unsubscribe token: ${reason}`)
    this.name = 'InvalidUnsubscribeTokenError'
  }
}

export type UnsubscribeTokenPayload = {
  prospectId: number
  tenantId: TenantId
}

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const keyData = new TextEncoder().encode(secret)
  const msgData = new TextEncoder().encode(message)
  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, msgData)
  return new Uint8Array(sig)
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function signUnsubscribeToken(
  payload: UnsubscribeTokenPayload,
  secret: string,
): Promise<string> {
  const message = `${payload.prospectId}:${payload.tenantId}`
  const sigBytes = await hmacSha256(secret, message)
  const sig = base64UrlEncode(sigBytes)
  return `${payload.prospectId}.${payload.tenantId}.${sig}`
}

// Valid tokens are ~80 bytes (`<int>.<nanoid>.<43-char-sig>`). Cap input at
// 256 to avoid spending CPU on pathological strings on the unauthenticated
// /api/unsubscribe/:token endpoint.
const MAX_TOKEN_LENGTH = 256

export async function verifyUnsubscribeToken(
  token: string,
  secret: string,
): Promise<UnsubscribeTokenPayload> {
  if (token.length > MAX_TOKEN_LENGTH) throw new InvalidUnsubscribeTokenError('length')
  const parts = token.split('.')
  if (parts.length !== 3) throw new InvalidUnsubscribeTokenError('format')
  const [prospectIdStr, tenantId, sig] = parts
  if (!prospectIdStr || !tenantId || !sig) {
    throw new InvalidUnsubscribeTokenError('format')
  }
  const prospectId = Number(prospectIdStr)
  if (!Number.isInteger(prospectId) || prospectId <= 0) {
    throw new InvalidUnsubscribeTokenError('prospectId')
  }

  const expectedBytes = await hmacSha256(secret, `${prospectId}:${tenantId}`)
  const expected = base64UrlEncode(expectedBytes)
  if (!timingSafeEqual(sig, expected)) {
    throw new InvalidUnsubscribeTokenError('signature')
  }

  return { prospectId, tenantId: tenantId as TenantId }
}
