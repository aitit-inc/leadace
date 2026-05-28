import { request, type RequestFetch } from '../api';
import type { Project } from '$lib/types/projects';

export function listProjects(
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<Project[]> {
  return request<{ projects: Project[] }>(fetchFn, {
    method: 'GET',
    path: '/projects',
    auth: 'required',
    token,
  }).then((r) => r.projects);
}

export function createProject(
  name: string,
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<Project> {
  return request<Project>(fetchFn, {
    method: 'POST',
    path: '/projects',
    body: { name },
    auth: 'required',
    token,
  });
}

export function deleteProject(
  projectId: string,
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<void> {
  return request<void>(fetchFn, {
    method: 'DELETE',
    path: `/projects/${projectId}`,
    auth: 'required',
    token,
  });
}
