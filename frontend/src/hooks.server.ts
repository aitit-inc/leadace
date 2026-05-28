import { createServerClient } from '@supabase/ssr';
import { isAuthApiError } from '@supabase/supabase-js';
import { redirect, type Handle } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import {
	PUBLIC_SUPABASE_URL,
	PUBLIC_SUPABASE_ANON_KEY,
} from '$env/static/public';
import { isSafeRelativePath } from '$lib/redirect';

const supabase: Handle = async ({ event, resolve }) => {
	event.locals.supabase = createServerClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
		cookies: {
			getAll: () => event.cookies.getAll(),
			setAll: (cookiesToSet) => {
				for (const { name, value, options } of cookiesToSet) {
					event.cookies.set(name, value, { ...options, path: '/' });
				}
			},
		},
	});

	// getSession() returns the unverified cookie payload — the JWT is not
	// validated. Pair it with getUser(), which round-trips to Supabase Auth
	// and verifies the token, before treating the session as trustworthy.
	// Only AuthApiError (the auth server rejected the token) nulls the
	// session — transient fetch failures (AuthRetryableFetchError, offline
	// blip) keep the cookie session as-is so a flaky network doesn't kick
	// signed-in users to /login on every SSR. If the JWT really is dead,
	// the next API call surfaces a 401 and api/client.ts triggers reauth.
	event.locals.safeGetSession = async () => {
		const {
			data: { session },
		} = await event.locals.supabase.auth.getSession();
		if (!session) return { session: null, user: null };
		const {
			data: { user },
			error,
		} = await event.locals.supabase.auth.getUser();
		if (error && isAuthApiError(error)) return { session: null, user: null };
		return { session, user: user ?? session.user };
	};

	return resolve(event, {
		filterSerializedResponseHeaders: (name) =>
			name === 'content-range' || name === 'x-supabase-api-version',
	});
};

const authGuard: Handle = async ({ event, resolve }) => {
	const { session, user } = await event.locals.safeGetSession();
	event.locals.session = session;
	event.locals.user = user;

	// Route id reflects group folders ((app), (auth), …) where pathname does
	// not, so it's the right key for group-level gates.
	const inAppGroup = event.route.id?.startsWith('/(app)') ?? false;
	if (inAppGroup && !session) {
		const next = event.url.pathname + event.url.search;
		redirect(303, `/login?next=${encodeURIComponent(next)}`);
	}
	if (event.route.id === '/login' && session) {
		// `?reauth=1` is set by api/client.ts when a 401 forces a redirect
		// here. The local cookie session is still present, so the default
		// bounce-to-next would loop straight back to the protected page that
		// just 401'd. Let the /login page render so its load handler can sign
		// the stale session out.
		if (event.url.searchParams.get('reauth') !== '1') {
			// `?next` is user-controlled, so reject anything that isn't a
			// same-origin path. Without this guard, /login?next=https://evil
			// would emit an external Location and become an open redirect.
			const nextRaw = event.url.searchParams.get('next');
			const next = nextRaw && isSafeRelativePath(nextRaw) ? nextRaw : '/prospects';
			redirect(303, next);
		}
	}

	return resolve(event);
};

export const handle = sequence(supabase, authGuard);
