import { ApiError } from '$lib/api';
import { getProspect } from '$lib/api/prospects';
import { getConversation } from '$lib/api/responses';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ fetch, params, parent, locals, depends }) => {
  depends('app:responses');
  const { activeProjectId } = await parent();
  const prospectId = Number(params.id);
  if (!activeProjectId || !Number.isInteger(prospectId) || prospectId <= 0) {
    return { prospect: null, messages: [] };
  }

  const token = locals.session?.access_token;
  try {
    const [res, conversation] = await Promise.all([
      getProspect(activeProjectId, prospectId, fetch, token),
      getConversation(activeProjectId, prospectId, fetch, token),
    ]);
    return { prospect: res.prospect, messages: conversation.messages };
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 403)) {
      return { prospect: null, messages: [] };
    }
    throw e;
  }
};
