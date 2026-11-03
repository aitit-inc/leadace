import { request, type RequestFetch } from '../api';
import type { ResponseAnswer, ResponseRecord, ResponseType, Sentiment } from '$lib/types/responses';

export type ListResponsesParams = {
  page: number;
  limit: number;
  sentiment?: Sentiment;
  responseType?: ResponseType;
  answer?: Exclude<ResponseAnswer, 'none'>;
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
  if (params.answer) sp.set('answer', params.answer);
  return request<{ responses: ResponseRecord[]; total: number }>(fetchFn, {
    method: 'GET',
    path: `/projects/${projectId}/responses?${sp}`,
    auth: 'required',
    token,
  });
}

export function markResponseAnswered(responseId: number, fetchFn: RequestFetch = fetch, token?: string): Promise<void> {
  return request<void>(fetchFn, {
    method: 'POST',
    path: `/responses/${responseId}/mark-answered`,
    auth: 'required',
    token,
  });
}

export function saveAnswer(
  responseId: number,
  input: { body: string },
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<void> {
  return request<void>(fetchFn, {
    method: 'PUT',
    path: `/responses/${responseId}/answer`,
    body: input,
    auth: 'required',
    token,
  });
}

// Sends the text given, as given.
export function sendAnswer(
  responseId: number,
  body: string,
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<{ to: string; from: string }> {
  return request<{ to: string; from: string }>(fetchFn, {
    method: 'POST',
    path: `/responses/${responseId}/answer/send`,
    body: { body },
    auth: 'required',
    token,
  });
}
