import { isHttpError } from '@sveltejs/kit';
import { listMcpSessions } from '$lib/api/mcp';
import { listSendingIdentities } from '$lib/api/sending-identities';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ fetch, depends, locals }) => {
  depends('app:mcp-sessions');
  depends('app:sending-identities');
  const token = locals.session?.access_token;

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
    mcpSessions,
    sendingIdentities: sendingIdentities.list,
    sendingIdentitiesError: sendingIdentities.error,
  };
};
