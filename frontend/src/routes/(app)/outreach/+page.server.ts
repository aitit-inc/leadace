import { listOutreach } from '$lib/api/outreach';
import { PAGE_SIZE, parsePageNumber } from '$lib/pagination';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ fetch, parent, url, locals }) => {
  const { activeProjectId } = await parent();
  const page = parsePageNumber(url.searchParams.get('page'));

  if (!activeProjectId) {
    return { activeProjectId: null, logs: [], total: 0, page };
  }

  const res = await listOutreach(
    activeProjectId,
    { page, limit: PAGE_SIZE },
    fetch,
    locals.session?.access_token,
  );

  return { activeProjectId, logs: res.logs, total: res.total, page };
};
