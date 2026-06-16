import { getProjectStats } from '$lib/api/evaluations';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ fetch, parent, locals }) => {
  const { activeProjectId } = await parent();

  if (!activeProjectId) {
    return { activeProjectId: null, stats: null };
  }

  const stats = await getProjectStats(activeProjectId, fetch, locals.session?.access_token);

  return { activeProjectId, stats };
};
