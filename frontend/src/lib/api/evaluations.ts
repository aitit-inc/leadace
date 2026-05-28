import { request, type RequestFetch } from '../api';
import type { Evaluation, ProjectStats } from '$lib/types/evaluations';

export function getProjectStats(
  projectId: string,
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<ProjectStats> {
  return request<ProjectStats>(fetchFn, {
    method: 'GET',
    path: `/projects/${projectId}/stats`,
    auth: 'required',
    token,
  });
}

export type ListEvaluationsParams = {
  page: number;
  limit: number;
};

export function listEvaluations(
  projectId: string,
  params: ListEvaluationsParams,
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<{ evaluations: Evaluation[]; total: number }> {
  const sp = new URLSearchParams({
    limit: String(params.limit),
    offset: String((params.page - 1) * params.limit),
  });
  return request<{ evaluations: Evaluation[]; total: number }>(fetchFn, {
    method: 'GET',
    path: `/projects/${projectId}/evaluations?${sp}`,
    auth: 'required',
    token,
  });
}
