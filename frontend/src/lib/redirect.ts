import type { Cookies } from '@sveltejs/kit';

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

// The page to return to after a round trip to Google, set before leaving.
export const NEXT_COOKIE = 'lp-next';

// cookies.get() has already decoded it: decoding again would split a nested
// ?site= URL at its own `&`.
export function takeNext(cookies: Cookies): string | null {
  const next = cookies.get(NEXT_COOKIE);
  if (!next) return null;
  cookies.delete(NEXT_COOKIE, { path: '/' });
  return isSafeRelativePath(next) ? next : null;
}

// Defense-in-depth for absolute URLs rendered as <a href={...}>. The backend
// write path now refuses javascript: / data: / file: etc. for prospect /
// organization URLs, but legacy rows persisted before that constraint may
// still hold them.
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
