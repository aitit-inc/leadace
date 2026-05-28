// Allow only same-origin paths in `?next=...` query parameters to prevent
// open-redirect abuse. Reject protocol-relative `//evil.com`, backslash
// variants, and any absolute URLs.
export function isSafeRelativePath(p: string): boolean {
  // The WHATWG URL parser strips ASCII tab/LF/CR before parsing, so a value
  // like `/\t/evil.com` would pass a naive prefix check yet resolve to
  // `//evil.com` (protocol-relative) once the browser follows the redirect.
  if (/[\t\r\n]/.test(p)) return false;
  if (!p.startsWith('/')) return false;
  if (p.startsWith('//')) return false;
  if (p.startsWith('/\\')) return false;
  return true;
}

// Defense-in-depth for absolute URLs rendered as <a href={...}>. The backend
// write path now refuses javascript: / data: / file: etc. for prospect /
// organization URLs, but legacy rows persisted before that constraint may
// still hold them. Return the original URL when the scheme is http: or
// https:, null otherwise — callers gate the anchor with
// `{#if safeHttpUrl(url)}` or fall back to `href={safeHttpUrl(url) ?? '#'}`.
export function safeHttpUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol === 'http:' || u.protocol === 'https:') return raw;
  } catch {
    // URL parser threw — treat as unsafe.
  }
  return null;
}
