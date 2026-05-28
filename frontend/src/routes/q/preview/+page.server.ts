import { redirect } from '@sveltejs/kit';
import { ApiError } from '$lib/api';
import { loadInquiryPreview, type InquiryLandingPayload } from '$lib/api/inquiry';
import type { PageServerLoad } from './$types';

type PreviewResult =
  | { state: 'ready'; landing: InquiryLandingPayload }
  | { state: 'invalid'; status: number; message: string };

// /q/preview is sender-side (the project owner previews the receiver
// landing) and lives outside the (app) group, so hooks.server.ts does not
// gate it. Gate here: unauthenticated visitors get bounced to /login with a
// `next` so a fresh sign-in returns them to the preview.
export const load: PageServerLoad = async ({ url, fetch, locals }) => {
  const projectId = url.searchParams.get('project');
  if (!projectId) {
    const result: PreviewResult = {
      state: 'invalid',
      status: 400,
      message: 'Missing project parameter — open Preview from the AI Inquiry settings page.',
    };
    return { result };
  }

  if (!locals.session) {
    const next = url.pathname + url.search;
    redirect(303, `/login?next=${encodeURIComponent(next)}`);
  }

  try {
    const landing = await loadInquiryPreview(projectId, fetch, locals.session.access_token);
    const result: PreviewResult = { state: 'ready', landing };
    return { result };
  } catch (e) {
    // 401 throws a SvelteKit error(401) inside the transport on the server,
    // so it surfaces through +error.svelte rather than this catch. Other
    // ApiErrors (404 unknown project, 403 etc.) render as the invalid view.
    const status = e instanceof ApiError ? e.status : 0;
    const message = e instanceof Error ? e.message : 'Unable to load preview';
    const result: PreviewResult = { state: 'invalid', status, message };
    return { result };
  }
};
