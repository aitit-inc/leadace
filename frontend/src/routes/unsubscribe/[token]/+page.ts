import { ApiError } from '$lib/api';
import { loadUnsubscribeInfo, type UnsubscribeInfo } from '$lib/api/unsubscribe';
import type { PageLoad } from './$types';

export type UnsubscribeLoadResult =
  | { kind: 'ready'; info: UnsubscribeInfo }
  | { kind: 'invalid'; message: string };

// Public route — no session, no SSR data fetch (the backend route is open).
// Using +page.ts (instead of +page.server.ts) keeps the call client-side so
// the SvelteKit Pages Function isn't hit for a route that is otherwise
// purely static + a single XHR.
export const load: PageLoad = async ({ params, fetch }) => {
  try {
    const info = await loadUnsubscribeInfo(params.token, fetch);
    const result: UnsubscribeLoadResult = { kind: 'ready', info };
    return { result };
  } catch (e) {
    const message =
      e instanceof ApiError
        ? e.detail || e.message
        : e instanceof Error
          ? e.message
          : 'Unable to load unsubscribe link';
    const result: UnsubscribeLoadResult = { kind: 'invalid', message };
    return { result };
  }
};
