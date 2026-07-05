import { listDrafts } from '$lib/api/drafts';
import { PAGE_SIZE, parsePageNumber } from '$lib/pagination';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ fetch, parent, url, depends, locals }) => {
  depends('app:drafts');
  const { activeProjectId } = await parent();
  const page = parsePageNumber(url.searchParams.get('page'));

  if (!activeProjectId) {
    return { activeProjectId: null, drafts: [], total: 0, page };
  }

  const res = await listDrafts(
    activeProjectId,
    { page, limit: PAGE_SIZE },
    fetch,
    locals.session?.access_token,
  );

  return { activeProjectId, drafts: res.drafts, total: res.total, page };
};
