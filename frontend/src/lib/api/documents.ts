import { request, type RequestFetch } from '../api';
import type { DocumentSummary, DocumentVersion } from '$lib/types/documents';

export function listDocuments(
  projectId: string,
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<{ documents: DocumentSummary[] }> {
  return request<{ documents: DocumentSummary[] }>(fetchFn, {
    method: 'GET',
    path: `/projects/${projectId}/documents`,
    auth: 'required',
    token,
  });
}

export function getDocument(
  projectId: string,
  slug: string,
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<DocumentVersion> {
  return request<DocumentVersion>(fetchFn, {
    method: 'GET',
    path: `/projects/${projectId}/documents/${slug}`,
    auth: 'required',
    token,
  });
}

export function saveDocument(
  projectId: string,
  slug: string,
  content: string,
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<{ id: number; slug: string; createdAt: string; approvedAt: string | null }> {
  return request<{ id: number; slug: string; createdAt: string; approvedAt: string | null }>(fetchFn, {
    method: 'PUT',
    path: `/projects/${projectId}/documents/${slug}`,
    body: { content },
    auth: 'required',
    token,
  });
}

export function approveDocumentVersion(
  projectId: string,
  slug: string,
  id: number,
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<{ id: number; slug: string; createdAt: string; approvedAt: string | null }> {
  return request<{ id: number; slug: string; createdAt: string; approvedAt: string | null }>(fetchFn, {
    method: 'POST',
    path: `/projects/${projectId}/documents/${slug}/approve`,
    body: { id },
    auth: 'required',
    token,
  });
}

export type ListDocumentHistoryParams = {
  limit?: number;
};

export function listDocumentHistory(
  projectId: string,
  slug: string,
  params: ListDocumentHistoryParams,
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<{ history: DocumentVersion[] }> {
  const sp = new URLSearchParams();
  if (params.limit !== undefined) sp.set('limit', String(params.limit));
  const qs = sp.toString();
  return request<{ history: DocumentVersion[] }>(fetchFn, {
    method: 'GET',
    path: `/projects/${projectId}/documents/${slug}/history${qs ? `?${qs}` : ''}`,
    auth: 'required',
    token,
  });
}
