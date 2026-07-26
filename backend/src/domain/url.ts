// URL scheme guards. `z.url()` alone accepts any scheme — including
// `javascript:`, `data:`, `file:`, `about:` — which becomes a stored-XSS sink
// the moment a stored value is rendered as `<a href>` or `<img src>`.
//
// Two surfaces, two policies:
//   - `isHttpsUrl`: inquiry-landing assets (video/pdf/logo/cta) rendered to
//     recipients. HTTPS only — mixed-content blocks http: passively, but the
//     write path must refuse it explicitly so legacy rows are the only edge.
//   - `isHttpOrHttpsUrl`: prospect / organization links shown in our internal
//     admin UI. Many real-world business sites are still http://, so we accept
//     both, but `javascript:` etc. are still rejected.
//
// Case-insensitive: `URL.protocol` lowercases per WHATWG, so a frontend
// `URL(value).protocol === 'https:'` check passes `HTTPS://...`. The write
// path must accept the same set of strings or the contract diverges.

const HTTPS_RE = /^https:\/\//i
const HTTP_OR_HTTPS_RE = /^https?:\/\//i

export const isHttpsUrl = (u: string): boolean => HTTPS_RE.test(u)
export const isHttpOrHttpsUrl = (u: string): boolean => HTTP_OR_HTTPS_RE.test(u)

export const HTTPS_ONLY_MSG = { message: 'must use https://' } as const
export const HTTP_OR_HTTPS_ONLY_MSG = {
  message: 'must use http:// or https://',
} as const

const PRIVATE_IPV4_RE =
  /^(?:127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/

const IPV4_LITERAL_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/

// Stored org domains and sitemap-declared URLs are attacker-controlled (any
// signup can register one), so the server-side reader must not be steerable at
// hosts that only resolve inside a network. A company site is always a DNS name,
// so IP literals are refused outright rather than range-matched.
export const isPublicWebUrl = (u: string): boolean => {
  let url: URL
  try {
    url = new URL(u)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
  const host = url.hostname.toLowerCase()
  if (host.startsWith('[') || IPV4_LITERAL_RE.test(host)) return false
  if (!host.includes('.')) return false
  return !['.local', '.localhost', '.internal', '.home.arpa'].some((s) => host.endsWith(s))
}

// A mail footer / List-Unsubscribe link on a non-public host is both a spam
// signal and a broken (RFC 8058 / CAN-SPAM) opt-out, so the send path refuses one.
export const isPublicHttpsUrl = (u: string): boolean => {
  let url: URL
  try {
    url = new URL(u)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    return false
  }
  if (PRIVATE_IPV4_RE.test(host)) return false
  return host.includes('.')
}
