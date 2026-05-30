import { redirect } from '@sveltejs/kit';
import { ApiError } from '$lib/api';
import { loadInquiryPreview, type InquiryLandingPayload } from '$lib/api/inquiry';
import { listProspects } from '$lib/api/prospects';
import type { PageServerLoad } from './$types';

type PreviewResult =
  | { state: 'ready'; landing: InquiryLandingPayload }
  | { state: 'invalid'; status: number; message: string };

export type PreviewProspect = {
  prospectId: number;
  contactName: string | null;
  organizationName: string;
};

// /q/preview is outside the (app) group, so hooks.server.ts doesn't gate it.
// Gate here: bounce unauthenticated visitors to /login with a `next`.
export const load: PageServerLoad = async ({ url, fetch, locals }) => {
  const projectId = url.searchParams.get('project');
  if (!projectId) {
    const result: PreviewResult = {
      state: 'invalid',
      status: 400,
      message: 'Missing project parameter — open Preview from the AI Inquiry settings page.',
    };
    return { result, projectId: null, prospects: [], selectedProspectId: null, q: '' };
  }

  if (!locals.session) {
    const next = url.pathname + url.search;
    redirect(303, `/login?next=${encodeURIComponent(next)}`);
  }

  const prospectParam = url.searchParams.get('prospect');
  const selectedProspectId =
    prospectParam && /^\d+$/.test(prospectParam) ? Number(prospectParam) : null;
  const q = url.searchParams.get('q')?.trim() ?? '';

  let prospects: PreviewProspect[] = [];
  try {
    const res = await listProspects(
      projectId,
      { page: 1, limit: 50, q: q || undefined },
      fetch,
      locals.session.access_token,
    );
    prospects = res.prospects.map((p) => ({
      prospectId: p.prospectId,
      contactName: p.contactName,
      organizationName: p.organizationName,
    }));
  } catch {
    prospects = [];
  }

  try {
    const landing = await loadInquiryPreview(
      projectId,
      selectedProspectId,
      fetch,
      locals.session.access_token,
    );
    // Keep the selected prospect listed even when search filters it out of the
    // 50, so the picker doesn't snap to "Generic" mid-chat. recipientOrg is
    // non-null only for an in-project prospect.
    if (
      selectedProspectId !== null &&
      landing.recipientOrganization !== null &&
      !prospects.some((p) => p.prospectId === selectedProspectId)
    ) {
      prospects = [
        {
          prospectId: selectedProspectId,
          contactName: landing.recipientName,
          organizationName: landing.recipientOrganization,
        },
        ...prospects,
      ];
    }
    const result: PreviewResult = { state: 'ready', landing };
    return { result, projectId, prospects, selectedProspectId, q };
  } catch (e) {
    // 401 throws a SvelteKit error(401) inside the transport on the server,
    // so it surfaces through +error.svelte rather than this catch. Other
    // ApiErrors (404 unknown project, 403 etc.) render as the invalid view.
    const status = e instanceof ApiError ? e.status : 0;
    const message = e instanceof Error ? e.message : 'Unable to load preview';
    const result: PreviewResult = { state: 'invalid', status, message };
    return { result, projectId, prospects, selectedProspectId, q };
  }
};
