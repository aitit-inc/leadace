import { getProjectSettings } from '$lib/api/project-settings';
import type { PageServerLoad } from './$types';
import type { ProjectSettingsData } from './types';

export const load: PageServerLoad = async ({ fetch, parent, depends, locals }) => {
  depends('app:project-settings');
  const { activeProjectId } = await parent();
  const token = locals.session?.access_token;

  if (!activeProjectId) {
    return { projectId: null, projectSettings: null };
  }

  // The backend returns the full project_settings row; this page only consumes
  // the outbound-mode + sender-identity subset. Generic narrowing keeps the
  // page-local type without an extra structural assignment.
  const projectSettings = await getProjectSettings<ProjectSettingsData>(
    activeProjectId,
    fetch,
    token,
  );
  return { projectId: activeProjectId, projectSettings };
};
