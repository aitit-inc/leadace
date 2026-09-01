import { getLiveScoreboard } from '$lib/api/live';
import type { PageServerLoad } from './$types';

// Public route (outside (app)); SSR so share previews and crawlers see the
// numbers. `ref` is forwarded so the backend funnel log counts each post's reach.
const REF_RE = /^[A-Za-z0-9_-]{1,32}$/;

export const load: PageServerLoad = async ({ url, fetch }) => {
  const rawRef = url.searchParams.get('ref');
  const ref = rawRef && REF_RE.test(rawRef) ? rawRef : null;
  try {
    return { scoreboard: await getLiveScoreboard(ref, fetch) };
  } catch {
    return { scoreboard: null };
  }
};
