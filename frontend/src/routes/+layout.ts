import { createBrowserClient, createServerClient, isBrowser } from '@supabase/ssr';
import { isAuthApiError } from '@supabase/supabase-js';
import {
	PUBLIC_SUPABASE_URL,
	PUBLIC_SUPABASE_ANON_KEY,
} from '$env/static/public';
import type { LayoutLoad } from './$types';

export const load: LayoutLoad = async ({ data, depends, fetch }) => {
	// Tag the loader so +layout.svelte's auth listener can rerun it via
	// invalidate('supabase:auth') when the session changes.
	depends('supabase:auth');

	const supabase = isBrowser()
		? createBrowserClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
				global: { fetch },
			})
		: createServerClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
				global: { fetch },
				cookies: {
					getAll: () => data.cookies,
				},
			});

	// getSession() reads the unverified cookie payload; getUser() round-trips
	// to Supabase Auth and verifies the JWT. Only hard auth failures
	// (AuthApiError = the server rejected the token) should null out the
	// session — a transient fetch failure (offline blip, AuthRetryableFetchError)
	// must not invalidate the cookie session, or flaky network surfaces as
	// "auth=required but no token was provided" on every API call until reload.
	const {
		data: { session },
	} = await supabase.auth.getSession();
	const {
		data: { user },
		error: userErr,
	} = await supabase.auth.getUser();
	if (userErr && isAuthApiError(userErr)) {
		return { supabase, session: null, user: null };
	}

	return { supabase, session, user: user ?? data.user };
};
