import { goto } from '$app/navigation';
import { browser } from '$app/environment';
import { error as kitError } from '@sveltejs/kit';
import { PUBLIC_API_URL, PUBLIC_MCP_URL } from '$env/static/public';

export const API_BASE = PUBLIC_API_URL;
export const MCP_BASE = PUBLIC_MCP_URL;

export class ApiError extends Error {
  // `message` is the displayable string (detail when present, falling back
  // to the short error label) so call sites can render `e.message` directly
  // without re-implementing the detail-vs-label fallback. `error` keeps the
  // raw short label, `detail` keeps the raw long form — both are still
  // available for any consumer that needs the structural breakdown.
  constructor(
    public status: number,
    public error: string,
    public detail?: string,
  ) {
    super(detail ?? error);
  }
}

// Backend sends `detail` as either a plain string (service errors) or a
// `z.flattenError` object (zValidator failures: `{ formErrors, fieldErrors }`).
// Plain `String(obj)` would render the latter as `[object Object]`, so flatten
// it into a "field: message; …" string here before it reaches `ApiError`.
// Anything else falls back to JSON.stringify so dev-time anomalies stay
// visible instead of crashing.
function formatDetail(detail: unknown): string | undefined {
  if (detail === undefined || detail === null) return undefined;
  if (typeof detail === 'string') return detail;
  if (typeof detail === 'object') {
    const d = detail as { formErrors?: unknown; fieldErrors?: unknown };
    const formErrors = Array.isArray(d.formErrors)
      ? (d.formErrors.filter((m) => typeof m === 'string') as string[])
      : [];
    const fieldErrors =
      d.fieldErrors && typeof d.fieldErrors === 'object'
        ? (d.fieldErrors as Record<string, unknown>)
        : null;
    if (formErrors.length > 0 || fieldErrors) {
      const parts: string[] = [...formErrors];
      if (fieldErrors) {
        for (const [field, msgs] of Object.entries(fieldErrors)) {
          if (Array.isArray(msgs)) {
            for (const msg of msgs) {
              if (typeof msg === 'string') parts.push(`${field}: ${msg}`);
            }
          }
        }
      }
      if (parts.length > 0) return parts.join('; ');
    }
    try {
      return JSON.stringify(detail);
    } catch {
      return undefined;
    }
  }
  return String(detail);
}

// 'required' attaches a Supabase JWT and routes 401s to /login (unauthenticated
// session means there's nothing else useful to render). 'none' is for the
// public token-authenticated routes (inquiry landing, unsubscribe) where the
// URL itself carries the auth and a 401 would be a real error to surface.
export type RequestAuth = 'required' | 'none';
export type RequestFetch = typeof fetch;

export type RequestOptions = {
  method: string;
  path: string;
  body?: unknown;
  auth: RequestAuth;
  /**
   * Explicit access token. Required when `auth: 'required'`. Server-side
   * loaders pass `event.locals.session.access_token`; client-side callers
   * pass `data.session.access_token` (data inherits the root layout's
   * session, so every page has it).
   */
  token?: string;
};

let redirecting = false;

async function handleUnauthorizedClient(): Promise<void> {
  if (redirecting) return;
  redirecting = true;
  // Don't proactively call supabase.auth.signOut() here. signOut() destroys
  // the session and fires a SIGNED_OUT event that other parts of the app
  // react to, which can cascade into mid-render redirects. A 401 from the
  // API doesn't necessarily mean the session is invalid — it can mean the
  // tenant was newly provisioned, the token is briefly stale, or the
  // backend rejected for an unrelated reason. Just route the user to
  // /login?reauth=1; the /login page handles the stale-session case.
  const here = window.location.pathname + window.location.search;
  const onLogin = window.location.pathname === '/login';
  const params = new URLSearchParams({ reauth: '1' });
  if (!onLogin) params.set('next', here);
  await goto(`/login?${params.toString()}`, { replaceState: true });
}

export async function request<T>(
  fetchFn: RequestFetch,
  opts: RequestOptions,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (opts.auth === 'required') {
    if (!opts.token) {
      // Misuse: caller failed to thread the token through. Surface loudly.
      // Server-side this becomes a 500 via SvelteKit's error path; client-
      // side it crashes the originating handler — both correct outcomes.
      throw new Error('request: auth=required but no token was provided');
    }
    headers['Authorization'] = `Bearer ${opts.token}`;
  }

  const res = await fetchFn(`${API_BASE}/api${opts.path}`, {
    method: opts.method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string; detail?: unknown };
    if (res.status === 401 && opts.auth === 'required') {
      // Client: navigate to /login. Server: throw a SvelteKit redirect via
      // error(401) so the load fails fast and surfaces through +error.svelte.
      // The route group already gates on session, so a 401 here means the
      // backend rejected an otherwise-valid Supabase session.
      if (browser) {
        void handleUnauthorizedClient();
      } else {
        throw kitError(401, err.error ?? 'Unauthorized');
      }
    }
    const label = err.error ?? `Request failed (${res.status})`;
    throw new ApiError(res.status, label, formatDetail(err.detail));
  }
  // 204 No Content — the caller is typed as Promise<void> and won't read
  // the body. Avoid res.json() on an empty body (it would reject).
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
