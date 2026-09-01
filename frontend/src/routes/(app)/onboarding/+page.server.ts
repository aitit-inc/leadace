import { isHttpError, redirect } from '@sveltejs/kit';
import { ApiError } from '$lib/api';
import { getLatestWebPreview } from '$lib/api/web-preview';
import type { WebPreview } from '$lib/types/web-preview';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, fetch, locals, depends }) => {
	depends('app:web-preview');
	const { mcpConnected } = await parent();
	// Fully connected users have outgrown this page.
	if (mcpConnected) redirect(303, '/dashboard');
	const token = locals.session?.access_token;
	let preview: WebPreview | null = null;
	// A failed load must read as a failure, not as "no preview yet".
	let previewError: string | null = null;
	if (token) {
		try {
			preview = (await getLatestWebPreview(fetch, token)).preview;
		} catch (e) {
			if (isHttpError(e)) throw e;
			previewError =
				e instanceof ApiError ? e.detail || e.message : 'Could not load your last preview.';
		}
	}
	return { preview, previewError };
};
