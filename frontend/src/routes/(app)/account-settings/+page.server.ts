import { listMcpSessions } from '$lib/api/mcp';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ fetch, depends, locals }) => {
  depends('app:mcp-sessions');
  const token = locals.session?.access_token;

  const mcpSessions = await listMcpSessions(fetch, token).then(
    (sessions) => ({ sessions, error: null as string | null }),
    (e: unknown) => ({
      sessions: [],
      error: e instanceof Error ? e.message : 'Failed to load MCP sessions',
    }),
  );

  return { mcpSessions };
};
