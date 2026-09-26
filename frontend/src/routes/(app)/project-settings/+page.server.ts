import { isHttpError } from '@sveltejs/kit';
import { getDailyTarget, getProjectSettings } from '$lib/api/project-settings';
import { listSendingIdentities } from '$lib/api/sending-identities';
import { listSchedules } from '$lib/api/schedules';
import type { PageServerLoad } from './$types';
import type { ProjectSettingsData } from './types';

export const load: PageServerLoad = async ({ fetch, parent, depends, locals }) => {
  depends('app:project-settings');
  const { activeProjectId } = await parent();
  const token = locals.session?.access_token;

  if (!activeProjectId) {
    return { projectId: null, projectSettings: null, dailyTarget: null, sendingIdentities: [], sendingIdentitiesError: false, schedules: [] };
  }

  // The identity list is best-effort: a non-HTTP failure leaves the project on its
  // default mailbox, with sendingIdentitiesError so the UI can say so rather than
  // silently hiding the selector.
  const [projectSettings, dailyTarget, identities, schedules] = await Promise.all([
    getProjectSettings<ProjectSettingsData>(activeProjectId, fetch, token),
    getDailyTarget(activeProjectId, fetch, token),
    listSendingIdentities(fetch, token).then(
      (list) => ({ list, error: false }),
      (e: unknown) => {
        if (isHttpError(e)) throw e;
        return { list: [], error: true };
      },
    ),
    listSchedules(activeProjectId, fetch, token),
  ]);
  return {
    projectId: activeProjectId,
    projectSettings,
    dailyTarget,
    sendingIdentities: identities.list,
    sendingIdentitiesError: identities.error,
    schedules: schedules.schedules,
  };
};
