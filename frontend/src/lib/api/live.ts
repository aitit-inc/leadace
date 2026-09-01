import { request, type RequestFetch } from '../api';
import type { LiveScoreboard } from '$lib/types/live';

export function getLiveScoreboard(
  ref: string | null,
  fetchFn: RequestFetch = fetch,
): Promise<LiveScoreboard> {
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  return request<LiveScoreboard>(fetchFn, {
    method: 'GET',
    path: `/live${query}`,
    auth: 'none',
  });
}
