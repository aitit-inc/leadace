import { getGmailStatus } from '$lib/api/auth-google';
import { getWorkspaceSettings } from '$lib/api/workspace-settings';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ fetch, depends, locals }) => {
  depends('app:workspace-settings');
  const token = locals.session?.access_token;
  const [settings, gmail] = await Promise.all([
    getWorkspaceSettings(fetch, token),
    getGmailStatus(fetch, token).catch(() => null),
  ]);
  // The notification default: the mailbox notifications are sent from.
  const connectedGmail = gmail?.connected ? (gmail.email ?? null) : null;
  return { settings, connectedGmail };
};
