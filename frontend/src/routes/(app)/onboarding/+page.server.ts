import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// await parent() reruns this load whenever the (app) layout — which declares
// depends('app:onboarding') — is invalidated, so the "check now" button bounces
// out once the plugin connects.
export const load: PageServerLoad = async ({ parent }) => {
	const { mcpConnected } = await parent();
	if (mcpConnected) redirect(303, '/prospects');
	return {};
};
