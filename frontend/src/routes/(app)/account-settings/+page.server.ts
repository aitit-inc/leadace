import { isHttpError } from '@sveltejs/kit';
import { listMcpSessions } from '$lib/api/mcp';
import { getMailboxHealth } from '$lib/api/mailbox';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ fetch, depends, locals }) => {
  depends('app:mcp-sessions');
  depends('app:mailbox-health');
  const token = locals.session?.access_token;

  const mcpSessions = await listMcpSessions(fetch, token).then(
    (sessions) => ({ sessions, error: null as string | null }),
    (e: unknown) => ({
      sessions: [],
      error: e instanceof Error ? e.message : 'Failed to load MCP sessions',
    }),
  );

  // Best-effort, but let an auth failure (kitError(401)) reach +error.svelte
  // rather than silently hide the section.
  const mailboxHealth = await getMailboxHealth(fetch, token).then(
    (health) => health,
    (e: unknown) => {
      if (isHttpError(e)) throw e;
      return null;
    },
  );

  return { mcpSessions, mailboxHealth };
};
