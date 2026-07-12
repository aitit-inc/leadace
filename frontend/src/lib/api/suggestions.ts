import { request, type RequestFetch } from '../api';
import type { Suggestion, SuggestionStatus } from '$lib/types/suggestions';

export type ListSuggestionsParams = {
  status?: SuggestionStatus;
};

export function listSuggestions(
  projectId: string,
  params: ListSuggestionsParams,
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<{ suggestions: Suggestion[] }> {
  const sp = new URLSearchParams();
  if (params.status) sp.set('status', params.status);
  const qs = sp.toString();
  return request<{ suggestions: Suggestion[] }>(fetchFn, {
    method: 'GET',
    path: `/projects/${projectId}/suggestions${qs ? `?${qs}` : ''}`,
    auth: 'required',
    token,
  });
}

export function dismissSuggestion(
  id: number,
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<{ id: number; status: SuggestionStatus }> {
  return request<{ id: number; status: SuggestionStatus }>(fetchFn, {
    method: 'PATCH',
    path: `/suggestions/${id}`,
    body: { status: 'dismissed' },
    auth: 'required',
    token,
  });
}
