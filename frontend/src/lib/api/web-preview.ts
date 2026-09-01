import { request, type RequestFetch } from '../api';
import type { WebPreview } from '$lib/types/web-preview';

export function getLatestWebPreview(
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<{ preview: WebPreview | null }> {
  return request<{ preview: WebPreview | null }>(fetchFn, {
    method: 'GET',
    path: '/me/web-preview',
    auth: 'required',
    token,
  });
}

// Server-side generation takes tens of seconds — callers own the busy state.
export function generateWebPreview(
  url: string,
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<WebPreview> {
  return request<WebPreview>(fetchFn, {
    method: 'POST',
    path: '/me/web-preview',
    body: { url },
    auth: 'required',
    token,
  });
}
