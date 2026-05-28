// Constant-time string equality for HMAC / signature verification, so a
// mismatch doesn't leak its first-differing-byte position via timing.
// The runtime XORs every character regardless of where the mismatch is.
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}
