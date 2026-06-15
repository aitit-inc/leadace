import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	redirect(303, locals.session ? '/dashboard' : '/login');
};
