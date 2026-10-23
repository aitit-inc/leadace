import { redirect } from '@sveltejs/kit';
import { ApiError } from '$lib/api';
import { registerGoogleMailbox } from '$lib/api/sending-identities';
import { GOOGLE_MAILBOX_CONNECTED_COOKIE, GOOGLE_MAILBOX_STATE_COOKIE } from '$lib/gmail-oauth';
import { takeNext } from '$lib/redirect';
import type { RequestHandler } from './$types';

const SETTINGS = '/account-settings';

// Google sends the browser here after the consent for a Gmail mailbox. The
// signed-in session does the API call; the state cookie proves the redirect
// belongs to this browser and that the same account started it (a session
// switched mid-flow would otherwise take the grant).
export const GET: RequestHandler = async ({ url, cookies, fetch, locals }) => {
	const token = locals.session?.access_token;
	const userId = locals.user?.id;
	if (!token || !userId) redirect(303, `/login?next=${encodeURIComponent(SETTINGS)}`);

	const back = takeNext(cookies) ?? SETTINGS;
	const finish: (outcome: 'mailbox_connected' | 'mailbox_error', value: string) => never = (outcome, value) => {
		const to = new URL(back, url.origin);
		to.searchParams.set(outcome, value);
		redirect(303, to.pathname + to.search);
	};
	const fail: (reason: string) => never = (reason) => finish('mailbox_error', reason);

	const stateCookie = cookies.get(GOOGLE_MAILBOX_STATE_COOKIE) ?? '';
	cookies.delete(GOOGLE_MAILBOX_STATE_COOKIE, { path: '/' });
	const dot = stateCookie.indexOf('.');
	const expectedState = dot === -1 ? '' : stateCookie.slice(0, dot);
	const startedBy = dot === -1 ? '' : stateCookie.slice(dot + 1);

	const oauthError = url.searchParams.get('error');
	if (oauthError === 'access_denied') {
		fail("Gmail wasn't connected. Allow LeadAce to send email and read replies, then try again.");
	}
	if (oauthError) fail(url.searchParams.get('error_description') ?? oauthError);

	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	if (!code || !state) fail('Google sign-in was interrupted before completing.');
	if (!expectedState || state !== expectedState || startedBy !== userId) {
		fail('The connection did not start from this browser and account. Start it again.');
	}

	try {
		const mailbox = await registerGoogleMailbox({ code }, fetch, token);
		if (new URL(back, url.origin).pathname === '/chat') cookies.set(GOOGLE_MAILBOX_CONNECTED_COOKIE, '1', { path: '/chat', maxAge: 60 });
		finish('mailbox_connected', mailbox.fromEmail);
	} catch (e) {
		if (e instanceof ApiError) fail(e.message);
		throw e;
	}
};
