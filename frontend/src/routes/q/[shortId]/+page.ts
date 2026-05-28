import { ApiError } from '$lib/api';
import { loadLanding, type InquiryLandingPayload } from '$lib/api/inquiry';
import type { PageLoad } from './$types';

type LandingResult =
  | { state: 'ready'; landing: InquiryLandingPayload }
  | { state: 'invalid'; status: number; message: string };

export const load: PageLoad = async ({ params, fetch }) => {
  const { shortId } = params;
  try {
    const landing = await loadLanding(shortId, fetch);
    const result: LandingResult = { state: 'ready', landing };
    return { result, shortId };
  } catch (e) {
    const status = e instanceof ApiError ? e.status : 0;
    const message = e instanceof Error ? e.message : 'Unable to load this page';
    const result: LandingResult = { state: 'invalid', status, message };
    return { result, shortId };
  }
};
