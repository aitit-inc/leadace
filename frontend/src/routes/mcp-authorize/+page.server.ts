import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// Outside the (app) group, so hooks.server.ts does not gate this; redirect
// server-side rather than from a $effect (load → mount race).
export const load: PageServerLoad = async ({ locals, url }) => {
  if (!locals.session) {
    const sessionId = url.searchParams.get('session') ?? '';
    const next = `/mcp-authorize?session=${encodeURIComponent(sessionId)}`;
    redirect(303, `/login?next=${encodeURIComponent(next)}`);
  }
  return {};
};
