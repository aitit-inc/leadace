import type { Breadcrumb, CloudflareOptions } from '@sentry/cloudflare'
import type { ErrorEvent } from '@sentry/cloudflare'

// Auth tokens and identifiers ride in some URL paths
// (/unsubscribe/:token — an HMAC that authorizes a DNC flip; /inquiry/:shortId;
// /sessions/:id), and OAuth artifacts (code, state, code_challenge) ride in
// query strings. Sentry attaches the request URL to events, so scrub it before
// anything leaves. sendDefaultPii is also pinned false so headers / cookies /
// body / IP are never attached in the first place.
function redactPathTokens(path: string): string {
  return path
    .replace(/(\/unsubscribe\/)[^/?]+/, '$1[redacted]')
    .replace(/(\/inquiry\/)[^/?]+/, '$1[redacted]')
    .replace(/(\/sessions\/)[^/?]+/, '$1[redacted]')
}

function scrubUrl(raw: string): string {
  try {
    const u = new URL(raw)
    u.search = ''
    u.pathname = redactPathTokens(u.pathname)
    return u.toString()
  } catch {
    // Unparseable URL: fail closed — drop the query and redact known tokens on
    // the raw string rather than emit it untouched.
    return redactPathTokens(raw.split('?')[0] ?? raw)
  }
}

// Shared Sentry config for both Workers (api + mcp). A no-op when dsn is unset
// (local dev / self-host). Errors only — no performance tracing — to stay
// within the free tier.
export function sentryOptions(
  dsn: string | undefined,
  environment: string,
): CloudflareOptions {
  return {
    dsn,
    enabled: Boolean(dsn),
    environment,
    tracesSampleRate: 0,
    sendDefaultPii: false,
    beforeSend(event: ErrorEvent): ErrorEvent {
      if (event.request?.url) event.request.url = scrubUrl(event.request.url)
      if (event.request) {
        delete event.request.query_string
        // Unpopulated by the current SDK; dropped fail-closed.
        delete event.request.data
      }
      return event
    },
    // Outgoing-fetch breadcrumbs carry the raw URL; the Reoon verifier URL's
    // query holds the recipient address and API key.
    beforeBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
      const url = breadcrumb.data?.url
      if (typeof url === 'string') {
        breadcrumb.data = { ...breadcrumb.data, url: scrubUrl(url) }
      }
      return breadcrumb
    },
  }
}
