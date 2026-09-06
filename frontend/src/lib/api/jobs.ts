import { request, type RequestFetch } from '../api';
import type { Job } from '$lib/types/jobs';

export function getJob(id: string, fetchFn: RequestFetch = fetch, token?: string): Promise<Job> {
  return request<Job>(fetchFn, { method: 'GET', path: `/jobs/${encodeURIComponent(id)}`, auth: 'required', token });
}

export function listThreadJobs(threadId: string, fetchFn: RequestFetch = fetch, token?: string): Promise<Job[]> {
  const sp = new URLSearchParams({ threadId, limit: '20' });
  return request<{ jobs: Job[] }>(fetchFn, { method: 'GET', path: `/jobs?${sp}`, auth: 'required', token }).then((r) => r.jobs);
}

export function cancelJob(id: string, fetchFn: RequestFetch = fetch, token?: string): Promise<Job> {
  return request<Job>(fetchFn, { method: 'POST', path: `/jobs/${encodeURIComponent(id)}/cancel`, body: {}, auth: 'required', token });
}
