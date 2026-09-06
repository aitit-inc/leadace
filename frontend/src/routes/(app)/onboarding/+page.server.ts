import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// Onboarding happens in the chat: paste a URL, review the proposal, go.
export const load: PageServerLoad = () => {
  redirect(303, '/chat');
};
