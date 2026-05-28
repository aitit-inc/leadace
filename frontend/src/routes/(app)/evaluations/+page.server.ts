import { getProjectStats, listEvaluations } from '$lib/api/evaluations';
import { PAGE_SIZE, parsePageNumber } from '$lib/pagination';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ fetch, parent, url, locals }) => {
  const { activeProjectId } = await parent();
  const page = parsePageNumber(url.searchParams.get('page'));

  if (!activeProjectId) {
    return {
      activeProjectId: null,
      stats: null,
      evaluations: [],
      total: 0,
      page,
    };
  }

  const token = locals.session?.access_token;
  const [stats, evaluationsRes] = await Promise.all([
    getProjectStats(activeProjectId, fetch, token),
    listEvaluations(activeProjectId, { page, limit: PAGE_SIZE }, fetch, token),
  ]);

  return {
    activeProjectId,
    stats,
    evaluations: evaluationsRes.evaluations,
    total: evaluationsRes.total,
    page,
  };
};
