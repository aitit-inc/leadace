import { redirect } from '@sveltejs/kit';
import { getOnboardingStatus } from '$lib/api/onboarding';
import { takeNext } from '$lib/redirect';
import { PERSONA_WINDOW_MS, takeSignupPersona, type SignupPersona } from '$lib/signup-persona';
import type { RequestHandler } from './$types';

const SIGNUP_COOKIE = 'lp-signup';
const DEFAULT_DEST = '/dashboard';
const ONBOARDING_DEST = '/chat';

// `signup=1`, `src` and `next` ride along so a retry after a failed attempt keeps
// the landing attribution and the destination (the login page re-sets the cookies).
function loginRedirector(
	fromSignupCta: boolean,
	persona: SignupPersona | null,
	next: string | null,
): (reason: string) => never {
	const signup = fromSignupCta ? '&signup=1' : '';
	const src = persona ? `&src=${persona}` : '';
	const back = next ? `&next=${encodeURIComponent(next)}` : '';
	return (reason) => redirect(303, `/login?error=${encodeURIComponent(reason)}${signup}${src}${back}`);
}

// exchangeCodeForSession sets auth cookies via the request's cookie jar
// (wired by hooks.server.ts), so the 303 below lands on a signed-in session.
export const GET: RequestHandler = async ({ url, cookies, fetch, locals }) => {
	const fromSignupCta = cookies.get(SIGNUP_COOKIE) === '1';
	if (fromSignupCta) cookies.delete(SIGNUP_COOKIE, { path: '/' });
	const persona = takeSignupPersona(cookies);
	const next = takeNext(cookies);
	const loginRedirect: (reason: string) => never = loginRedirector(fromSignupCta, persona, next);

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

	// The landing persona a new account came from, kept once on the auth user.
	// Attribution never blocks or holds up sign-in.
	const isNew = Date.now() - Date.parse(data.user.created_at) < PERSONA_WINDOW_MS;
	if (persona && isNew && data.user.user_metadata?.signup_persona === undefined) {
		const giveUp = new Promise((resolve) => setTimeout(resolve, 2000));
		await Promise.race([locals.supabase.auth.updateUser({ data: { signup_persona: persona } }), giveUp]).catch(
			() => undefined,
		);
	}

	// redirect() throws, so pick dest inside the try but redirect outside it —
	// calling redirect() inside would let the catch swallow its control signal.
	let dest = next ?? DEFAULT_DEST;
	if (dest === DEFAULT_DEST) {
		try {
			const { hasProject, complianceReady } = await getOnboardingStatus(fetch, data.session.access_token);
			if (!hasProject || !complianceReady) dest = ONBOARDING_DEST;
		} catch {
			// keep the default dashboard
		}
	}

	redirect(303, dest);
};
