import { getDashboardSummary } from '$lib/api/dashboard';
import { listSuggestions } from '$lib/api/suggestions';
import type { DashboardPeriod } from '$lib/types/dashboard';
import type { Suggestion } from '$lib/types/suggestions';
import type { PageServerLoad } from './$types';

function parsePeriod(v: string | null): DashboardPeriod {
  return v === '7d' || v === 'all' ? v : '30d';
}

export const load: PageServerLoad = async ({ fetch, parent, url, locals, depends }) => {
  depends('app:suggestions');
  const { activeProjectId } = await parent();
  const period = parsePeriod(url.searchParams.get('period'));

  // No project → the (app) layout shows the "No projects yet" CTA, so nothing to fetch.
  if (!activeProjectId) {
    return { activeProjectId: null, summary: null, period, suggestions: [] as Suggestion[] };
  }

  const token = locals.session?.access_token;
  const [summary, suggestions] = await Promise.all([
    getDashboardSummary(activeProjectId, period, fetch, token),
    // Best-effort: a suggestions fetch failure must not take down the dashboard.
    listSuggestions(activeProjectId, { status: 'open' }, fetch, token)
      .then((r) => r.suggestions)
      .catch(() => [] as Suggestion[]),
  ]);
  return { activeProjectId, summary, period, suggestions };
};
