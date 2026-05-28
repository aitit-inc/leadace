import { MCP_BASE, type RequestFetch } from '../api';

// MCP worker (mcp.leadace.ai) lives on a separate origin from /api. It has its
// own URL space and its own CORS surface, so we don't route through
// $lib/api's request() — that helper prefixes ${API_BASE}/api.

export interface McpSession {
  familyId: string;
  clientId: string;
  clientName: string | null;
  createdAt: number;
  lastSeenAt: number;
}

export class McpRequestError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = 'McpRequestError';
  }
}

async function mcpFetch<T>(
  fetchFn: RequestFetch,
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<T | null> {
  const headers: Record<string, string> = {};
  if (options.token) headers['Authorization'] = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetchFn(`${MCP_BASE}${path}`, {
    method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 204) return null;
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      error_description?: string;
    };
    throw new McpRequestError(
      res.status,
      body.error_description ?? body.error ?? `MCP request failed (${res.status})`,
      body.error,
    );
  }
  return (await res.json()) as T;
}

export async function listMcpSessions(
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<McpSession[]> {
  if (!token) throw new Error('listMcpSessions: a Supabase access token is required');
  const res = await mcpFetch<{ sessions: McpSession[] }>(fetchFn, 'GET', '/sessions', { token });
  return res?.sessions ?? [];
}

export async function revokeMcpSession(
  familyId: string,
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<void> {
  if (!token) throw new Error('revokeMcpSession: a Supabase access token is required');
  await mcpFetch<null>(
    fetchFn,
    'DELETE',
    `/sessions/${encodeURIComponent(familyId)}`,
    { token },
  );
}

// The /authorize/* endpoints are part of the MCP OAuth dance, not the
// authenticated /sessions API. They take their auth via session state +
// access_token in the body, not a Bearer header.

export type McpAuthorizeSession = {
  clientId: string;
  clientName: string | null;
  redirectUri: string;
  state: string;
};

export async function getMcpAuthorizeSession(
  sessionId: string,
  fetchFn: RequestFetch = fetch,
): Promise<McpAuthorizeSession> {
  let res: McpAuthorizeSession | null;
  try {
    res = await mcpFetch<McpAuthorizeSession>(
      fetchFn,
      'GET',
      `/authorize/session?session=${encodeURIComponent(sessionId)}`,
    );
  } catch (e) {
    // 404 = the OAuth session row is gone (TTL expired, never existed, or
    // already finalized). Translate to an actionable message before the
    // raw 'invalid_session' string reaches the page.
    if (e instanceof McpRequestError && e.status === 404) {
      throw new Error('Authorization request expired. Run /setup again to start a fresh one.');
    }
    throw e;
  }
  if (!res) throw new Error('Authorization request returned no body.');
  return res;
}

export async function finalizeMcpAuthorize(
  sessionId: string,
  accessToken: string,
  fetchFn: RequestFetch = fetch,
): Promise<{ redirect: string }> {
  const res = await mcpFetch<{ redirect: string }>(fetchFn, 'POST', '/authorize/finalize', {
    body: { session: sessionId, access_token: accessToken },
  });
  if (!res?.redirect) throw new Error('Authorization server returned no redirect.');
  return res;
}
