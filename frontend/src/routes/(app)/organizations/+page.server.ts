import { listOrganizations } from '$lib/api/organizations';
import { PAGE_SIZE, parsePageNumber } from '$lib/pagination';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ fetch, url, locals }) => {
  const q = (url.searchParams.get('q') ?? '').trim();
  const page = parsePageNumber(url.searchParams.get('page'));

  const res = await listOrganizations(
    { page, limit: PAGE_SIZE, q: q || undefined },
    fetch,
    locals.session?.access_token,
  );

  return { organizations: res.organizations, total: res.total, page, q };
};
