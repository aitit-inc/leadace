import { ApiError } from '$lib/api';
import { getProspect } from '$lib/api/prospects';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ fetch, params, parent, locals }) => {
  const { activeProjectId } = await parent();
  const prospectId = Number(params.id);
  if (!activeProjectId || !Number.isInteger(prospectId) || prospectId <= 0) {
    return { prospect: null };
  }

  try {
    const res = await getProspect(
      activeProjectId,
      prospectId,
      fetch,
      locals.session?.access_token,
    );
    return { prospect: res.prospect };
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 403)) {
      return { prospect: null };
    }
    throw e;
  }
};
