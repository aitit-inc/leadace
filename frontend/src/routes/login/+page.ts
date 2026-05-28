import { invalidate } from '$app/navigation';
import type { PageLoad } from './$types';

// hooks.server.ts already redirects signed-in users to `?next` (or
// `/prospects`). The only path that reaches here is `?reauth=1`: the api
// transport sends users here after a 401 even though their local cookie
// session may still parse. Force a sign-out so the page renders the
// sign-in UI rather than bouncing into the same protected page that just
// 401'd.
export const load: PageLoad = async ({ url, parent }) => {
	if (url.searchParams.get('reauth') === '1') {
		const { supabase } = await parent();
		await supabase.auth.signOut();
		// Drop any in-memory session/user cached by the root layout so back-
		// nav / parallel tabs don't keep treating the just-killed session as
		// live until the next hard reload.
		await invalidate('supabase:auth');
	}
	return {};
};
