import { getHistory } from '$lib/api/history';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ fetch, parent, locals }) => {
  const { activeProjectId } = await parent();
  if (!activeProjectId) return { rows: [] };

  return { rows: await getHistory(activeProjectId, fetch, locals.session?.access_token) };
};
