import { getDashboardSummary } from '$lib/api/dashboard';
import { listProposals } from '$lib/api/proposals';
import type { DashboardPeriod } from '$lib/types/dashboard';
import type { Proposal } from '$lib/types/proposals';
import type { PageServerLoad } from './$types';

function parsePeriod(v: string | null): DashboardPeriod {
  return v === '7d' || v === 'all' ? v : '30d';
}

export const load: PageServerLoad = async ({ fetch, parent, url, locals, depends }) => {
  depends('app:proposals');
  const { activeProjectId } = await parent();
  const period = parsePeriod(url.searchParams.get('period'));

  // No project → the (app) layout shows the "No projects yet" CTA, so nothing to fetch.
  if (!activeProjectId) {
    return { activeProjectId: null, summary: null, period, proposals: [] as Proposal[] };
  }

  const token = locals.session?.access_token;
  const [summary, proposals] = await Promise.all([
    getDashboardSummary(activeProjectId, period, fetch, token),
    // Best-effort: a proposals fetch failure must not take down the dashboard.
    listProposals(activeProjectId, { status: 'pending' }, fetch, token)
      .then((r) => r.proposals)
      .catch(() => [] as Proposal[]),
  ]);
  return { activeProjectId, summary, period, proposals };
};
