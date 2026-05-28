import type { LayoutServerLoad } from './$types';

// The client `+layout.ts` rebuilds a Supabase server client during SSR using
// these cookies; browser-side they are ignored.
export const load: LayoutServerLoad = async ({ locals: { session, user }, cookies }) => {
	return {
		session,
		user,
		cookies: cookies.getAll(),
	};
};
