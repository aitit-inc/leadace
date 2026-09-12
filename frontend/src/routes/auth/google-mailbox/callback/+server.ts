import { redirect } from '@sveltejs/kit';
import { ApiError } from '$lib/api';
import { registerGoogleMailbox } from '$lib/api/sending-identities';
import { GOOGLE_MAILBOX_STATE_COOKIE } from '$lib/gmail-oauth';
import type { RequestHandler } from './$types';

const SETTINGS = '/account-settings';

function settingsRedirect(reason: string): never {
	redirect(303, `${SETTINGS}?mailbox_error=${encodeURIComponent(reason)}`);
}

// Google sends the browser here after the consent for a mailbox connected from
// Account settings. The signed-in session does the API call; the state cookie
// proves the redirect belongs to this browser and that the same account
// started it (a session switched mid-flow would otherwise take the grant).
export const GET: RequestHandler = async ({ url, cookies, fetch, locals }) => {
	const token = locals.session?.access_token;
	const userId = locals.user?.id;
	if (!token || !userId) redirect(303, `/login?next=${encodeURIComponent(SETTINGS)}`);

	const stateCookie = cookies.get(GOOGLE_MAILBOX_STATE_COOKIE) ?? '';
	cookies.delete(GOOGLE_MAILBOX_STATE_COOKIE, { path: '/' });
	const dot = stateCookie.indexOf('.');
	const expectedState = dot === -1 ? '' : stateCookie.slice(0, dot);
	const startedBy = dot === -1 ? '' : stateCookie.slice(dot + 1);

	const oauthError = url.searchParams.get('error');
	if (oauthError) settingsRedirect(url.searchParams.get('error_description') ?? oauthError);

	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	if (!code || !state) settingsRedirect('Google sign-in was interrupted before completing.');
	if (!expectedState || state !== expectedState || startedBy !== userId) {
		settingsRedirect('The connection did not start from this browser and account. Start it again.');
	}

	try {
		const mailbox = await registerGoogleMailbox({ code }, fetch, token);
		redirect(303, `${SETTINGS}?mailbox_connected=${encodeURIComponent(mailbox.fromEmail)}`);
	} catch (e) {
		if (e instanceof ApiError) settingsRedirect(e.message);
		throw e;
	}
};
