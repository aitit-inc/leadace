import { listDocuments } from '$lib/api/documents';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ fetch, parent, locals, depends }) => {
  depends('app:documents');
  const { activeProjectId } = await parent();
  if (!activeProjectId) return { activeProjectId: null, documents: [] };
  const res = await listDocuments(activeProjectId, fetch, locals.session?.access_token);
  return { activeProjectId, documents: res.documents };
};
