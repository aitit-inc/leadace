import { request, type RequestFetch } from '../api';
import type { TenantSettings } from '$lib/types/tenants';

// URL stays /tenant-settings on the wire; the "workspace" rename is UX-only.

export function getWorkspaceSettings(
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<TenantSettings> {
  return request<TenantSettings>(fetchFn, {
    method: 'GET',
    path: '/tenant-settings',
    auth: 'required',
    token,
  });
}

export type UpdateWorkspaceSettingsPatch = Omit<TenantSettings, 'id'>;

export function updateWorkspaceSettings(
  patch: UpdateWorkspaceSettingsPatch,
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<TenantSettings> {
  return request<TenantSettings>(fetchFn, {
    method: 'PUT',
    path: '/tenant-settings',
    body: patch,
    auth: 'required',
    token,
  });
}
