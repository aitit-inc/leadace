import { getProjectSettings } from '$lib/api/project-settings';
import type { PageServerLoad } from './$types';
import type { InquirySettings } from './types';

export const load: PageServerLoad = async ({ fetch, parent, depends, locals }) => {
  // Save handler invalidates this tag to refresh after a PUT. Active project
  // changes already rerun the parent layout and cascade to us via parent().
  depends('app:project-settings');
  const { activeProjectId } = await parent();
  if (!activeProjectId) return { projectId: null, settings: null };
  const settings = await getProjectSettings<InquirySettings>(
    activeProjectId,
    fetch,
    locals.session?.access_token,
  );
  return { projectId: activeProjectId, settings };
};
