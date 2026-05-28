import { request, type RequestFetch } from '../api';
import type { ProjectSettings } from '$lib/types/project-settings';

export function getProjectSettings<T = ProjectSettings>(
  projectId: string,
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<T> {
  return request<T>(fetchFn, {
    method: 'GET',
    path: `/projects/${projectId}/settings`,
    auth: 'required',
    token,
  });
}

export function updateProjectSettings<T = ProjectSettings>(
  projectId: string,
  patch: Partial<ProjectSettings>,
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<T> {
  return request<T>(fetchFn, {
    method: 'PUT',
    path: `/projects/${projectId}/settings`,
    body: patch,
    auth: 'required',
    token,
  });
}
