import { isHttpError, redirect, type Cookies } from '@sveltejs/kit';
import { ApiError } from '$lib/api';
import { saveGoogleCredentials } from '$lib/api/auth-google';
import { getOnboardingStatus } from '$lib/api/onboarding';
import { GOOGLE_OAUTH_SCOPES } from '$lib/gmail-oauth';
import { isSafeRelativePath } from '$lib/redirect';
import type { RequestHandler } from './$types';

const NEXT_COOKIE = 'lp-next';
const SIGNUP_COOKIE = 'lp-signup';
const DEFAULT_DEST = '/dashboard';
const ONBOARDING_DEST = '/chat';

// `signup=1` rides along so a retry after a failed attempt keeps the landing
// attribution (the login page re-sets the cookie from the query param).
function loginRedirector(fromSignupCta: boolean): (reason: string) => never {
	const signup = fromSignupCta ? '&signup=1' : '';
	return (reason) => redirect(303, `/login?error=${encodeURIComponent(reason)}${signup}`);
}

// signOut() already expires the sb- cookies via hooks.server.ts's setAll
// callback; the explicit delete here is belt-and-braces against a
// @supabase/ssr refactor that changes how clear-cookie writes are dispatched.
async function signOutAndClearCookies(
	supabase: App.Locals['supabase'],
	cookies: Cookies,
): Promise<void> {
	await supabase.auth.signOut();
	for (const { name } of cookies.getAll()) {
		if (name.startsWith('sb-') && name.includes('-auth-token')) {
			cookies.delete(name, { path: '/' });
		}
	}
}

// exchangeCodeForSession sets auth cookies via the request's cookie jar
// (wired by hooks.server.ts), so the 303 below lands on a signed-in session.
export const GET: RequestHandler = async ({ url, cookies, fetch, locals }) => {
	const fromSignupCta = cookies.get(SIGNUP_COOKIE) === '1';
	if (fromSignupCta) cookies.delete(SIGNUP_COOKIE, { path: '/' });
	const loginRedirect: (reason: string) => never = loginRedirector(fromSignupCta);

	const oauthError = url.searchParams.get('error');
	if (oauthError) {
		loginRedirect(url.searchParams.get('error_description') ?? oauthError);
	}

	const code = url.searchParams.get('code');
	if (!code) loginRedirect('missing_code');

	const { data, error } = await locals.supabase.auth.exchangeCodeForSession(code);
	if (error || !data.session) {
		loginRedirect(error?.message ?? 'oauth_failed');
	}

	const rawNextCookie = cookies.get(NEXT_COOKIE);
	if (rawNextCookie) cookies.delete(NEXT_COOKIE, { path: '/' });
	let decodedNext: string | null = null;
	if (rawNextCookie) {
		try {
			decodedNext = decodeURIComponent(rawNextCookie);
		} catch {
			decodedNext = null;
		}
	}
	const next = decodedNext && isSafeRelativePath(decodedNext) ? decodedNext : DEFAULT_DEST;

	// provider_refresh_token is only present on the immediate sign-in event;
	// the backend needs it to mint Gmail access tokens later. On restored
	// sessions (no token) the previous callback already saved it.
	const session = data.session;
	const refreshToken = session.provider_refresh_token ?? null;
	const providerScope =
		(session as { provider_token_scope?: string }).provider_token_scope ?? null;
	const email = session.user.email ?? null;

	if (refreshToken && email) {
		try {
			await saveGoogleCredentials(
				{
					refreshToken,
					scope: providerScope ?? GOOGLE_OAUTH_SCOPES,
					email,
					fromSignupCta,
				},
				fetch,
				session.access_token,
			);
		} catch (e) {
			// 400 = gmail.send scope wasn't granted; sign the user out and surface
			// the consent message on the login page so a retry forces re-consent.
			// Without a persisted refresh token, outbound email won't work later, so
			// a silent pass-through would just defer the failure to first send.
			await signOutAndClearCookies(locals.supabase, cookies);
			if (e instanceof ApiError) {
				if (e.status === 400) loginRedirect('gmail_scope_required');
				loginRedirect(e.detail ?? e.error ?? `credentials_save_failed_${e.status}`);
			}
			// request() throws a SvelteKit HttpError (not ApiError) for server-side
			// 401s — keep the status code visible in the URL so support / Sentry
			// can still distinguish auth rejection from generic failures.
			if (isHttpError(e)) {
				loginRedirect(`credentials_save_failed_${e.status}`);
			}
			loginRedirect('credentials_save_failed');
		}
	}

	// redirect() throws, so pick dest inside the try but redirect outside it —
	// calling redirect() inside would let the catch swallow its control signal.
	let dest = next;
	if (next === DEFAULT_DEST) {
		try {
			const { hasProject } = await getOnboardingStatus(fetch, session.access_token);
			if (!hasProject) dest = ONBOARDING_DEST;
		} catch {
			// keep the default dashboard
		}
	}

	redirect(303, dest);
};
