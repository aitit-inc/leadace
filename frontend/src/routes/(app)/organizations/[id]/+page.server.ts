import { ApiError } from '$lib/api';
import { getOrganization } from '$lib/api/organizations';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ fetch, params, depends, locals }) => {
  depends('app:organization-detail');
  try {
    const res = await getOrganization(
      Number(params.id),
      fetch,
      locals.session?.access_token,
    );
    return { organization: res.organization, prospects: res.prospects };
  } catch (e) {
    // 404 / 403 surface as the in-app "Organization not found" empty state.
    // Other errors bubble up to (app)/+error.svelte so the user can retry.
    if (e instanceof ApiError && (e.status === 404 || e.status === 403)) {
      return { organization: null, prospects: [] };
    }
    throw e;
  }
};
