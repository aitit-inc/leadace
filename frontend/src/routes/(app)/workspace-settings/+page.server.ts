import { getWorkspaceSettings } from '$lib/api/workspace-settings';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ fetch, depends, locals }) => {
  depends('app:workspace-settings');
  const settings = await getWorkspaceSettings(fetch, locals.session?.access_token);
  return { settings };
};
