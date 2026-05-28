// Inquiry-landing short_ids are DB-backed (`inquiry_tokens` rows), not
// HMAC-signed like unsubscribe tokens — keeps URLs short and makes
// revocation a single column flip.

import { randomFromAlphabet } from './random-id'

// 64^8 ≈ 2.8e14 keyspace. Cheap shape-check via INQUIRY_SHORT_ID_PATTERN
// rejects scanner traffic before the DB lookup.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

export const INQUIRY_SHORT_ID_LENGTH = 8

export const INQUIRY_SHORT_ID_PATTERN = /^[A-Za-z0-9_-]{8}$/

export function isInquiryShortIdShape(value: string): boolean {
  return INQUIRY_SHORT_ID_PATTERN.test(value)
}

export function generateInquiryShortId(length = INQUIRY_SHORT_ID_LENGTH): string {
  return randomFromAlphabet(ALPHABET, length)
}
