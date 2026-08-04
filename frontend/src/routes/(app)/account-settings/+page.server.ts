import { isHttpError } from '@sveltejs/kit';
import { getGmailStatus } from '$lib/api/auth-google';
import { listMcpSessions } from '$lib/api/mcp';
import { listSendingIdentities } from '$lib/api/sending-identities';
import type { GmailStatus } from '$lib/types/auth-google';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ fetch, depends, locals }) => {
  depends('app:mcp-sessions');
  depends('app:sending-identities');
  const token = locals.session?.access_token;

  const gmailStatus = await getGmailStatus(fetch, token).then<GmailStatus, GmailStatus>(
    (res) => {
      if (!res.connected) return { state: 'disconnected' };
      if (res.revokedSince) {
        return { state: 'revoked', email: res.email ?? '', since: res.revokedSince };
      }
      return { state: 'connected', email: res.email ?? '', updatedAt: res.updatedAt ?? '' };
    },
    (e: unknown) => ({
      state: 'error',
      message: e instanceof Error ? e.message : 'Failed to load Gmail status',
    }),
  );

  const mcpSessions = await listMcpSessions(fetch, token).then(
    (sessions) => ({ sessions, error: null as string | null }),
    (e: unknown) => ({
      sessions: [],
      error: e instanceof Error ? e.message : 'Failed to load MCP sessions',
    }),
  );

  // Let an auth failure (kitError(401)) reach +error.svelte rather than hide the section.
  const sendingIdentities = await listSendingIdentities(fetch, token).then(
    (list) => ({ list, error: false }),
    (e: unknown) => {
      if (isHttpError(e)) throw e;
      return { list: [], error: true };
    },
  );

  return {
    gmailStatus,
    mcpSessions,
    sendingIdentities: sendingIdentities.list,
    sendingIdentitiesError: sendingIdentities.error,
  };
};
