import { request, type RequestFetch } from '../api';
import type { ProjectStats } from '$lib/types/evaluations';

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
