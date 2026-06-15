import { getDashboardSummary } from '$lib/api/dashboard';
import type { DashboardPeriod } from '$lib/types/dashboard';
import type { PageServerLoad } from './$types';

function parsePeriod(v: string | null): DashboardPeriod {
  return v === '7d' || v === 'all' ? v : '30d';
}

export const load: PageServerLoad = async ({ fetch, parent, url, locals }) => {
  const { activeProjectId } = await parent();
  const period = parsePeriod(url.searchParams.get('period'));

  // No project → the (app) layout shows the "No projects yet" CTA, so nothing to fetch.
  if (!activeProjectId) {
    return { activeProjectId: null, summary: null, period };
  }

  const summary = await getDashboardSummary(activeProjectId, period, fetch, locals.session?.access_token);
  return { activeProjectId, summary, period };
};
