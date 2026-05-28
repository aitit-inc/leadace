import { request, type RequestFetch } from '../api';
import type { OutreachDraft } from '$lib/types/outreach';

export type ListDraftsParams = {
  page: number;
  limit: number;
};

export function listDrafts(
  projectId: string,
  params: ListDraftsParams,
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<{ drafts: OutreachDraft[]; total: number }> {
  const sp = new URLSearchParams({
    limit: String(params.limit),
    offset: String((params.page - 1) * params.limit),
  });
  return request<{ drafts: OutreachDraft[]; total: number }>(fetchFn, {
    method: 'GET',
    path: `/projects/${projectId}/drafts?${sp}`,
    auth: 'required',
    token,
  });
}

export type UpdateDraftPatch = {
  body: string;
  subject?: string | null;
};

export function updateDraft(
  draftId: number,
  patch: UpdateDraftPatch,
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<void> {
  return request<void>(fetchFn, {
    method: 'PUT',
    path: `/outreach/drafts/${draftId}`,
    body: patch,
    auth: 'required',
    token,
  });
}

export function sendDraft(
  draftId: number,
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<void> {
  return request<void>(fetchFn, {
    method: 'POST',
    path: `/outreach/drafts/${draftId}/send`,
    body: {},
    auth: 'required',
    token,
  });
}

export function markDraftSent(
  draftId: number,
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<void> {
  return request<void>(fetchFn, {
    method: 'POST',
    path: `/outreach/drafts/${draftId}/mark-sent`,
    body: {},
    auth: 'required',
    token,
  });
}

export function discardDraft(
  draftId: number,
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<void> {
  return request<void>(fetchFn, {
    method: 'DELETE',
    path: `/outreach/drafts/${draftId}`,
    auth: 'required',
    token,
  });
}

export function discardDrafts(
  ids: number[],
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<{ deletedIds: number[]; skippedIds: number[] }> {
  return request<{ deletedIds: number[]; skippedIds: number[] }>(fetchFn, {
    method: 'POST',
    path: '/outreach/drafts/discard',
    body: { ids },
    auth: 'required',
    token,
  });
}
