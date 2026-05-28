import { request, type RequestFetch } from '../api';
import type { ResponseRecord, ResponseType, Sentiment } from '$lib/types/responses';

export type ListResponsesParams = {
  page: number;
  limit: number;
  sentiment?: Sentiment;
  responseType?: ResponseType;
};

export function listResponses(
  projectId: string,
  params: ListResponsesParams,
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<{ responses: ResponseRecord[]; total: number }> {
  const sp = new URLSearchParams({
    limit: String(params.limit),
    offset: String((params.page - 1) * params.limit),
  });
  if (params.sentiment) sp.set('sentiment', params.sentiment);
  if (params.responseType) sp.set('responseType', params.responseType);
  return request<{ responses: ResponseRecord[]; total: number }>(fetchFn, {
    method: 'GET',
    path: `/projects/${projectId}/responses?${sp}`,
    auth: 'required',
    token,
  });
}
