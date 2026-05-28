import { request, type RequestFetch } from '../api';
import type { Organization, OrganizationListItem, OrganizationProspect } from '$lib/types/organizations';

export type ListOrganizationsParams = {
  page: number;
  limit: number;
  q?: string;
};

export function listOrganizations(
  params: ListOrganizationsParams,
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<{ organizations: OrganizationListItem[]; total: number }> {
  const sp = new URLSearchParams({
    limit: String(params.limit),
    offset: String((params.page - 1) * params.limit),
  });
  if (params.q) sp.set('q', params.q);
  return request<{ organizations: OrganizationListItem[]; total: number }>(fetchFn, {
    method: 'GET',
    path: `/organizations?${sp}`,
    auth: 'required',
    token,
  });
}

export function getOrganization(
  organizationId: number,
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<{ organization: Organization; prospects: OrganizationProspect[] }> {
  return request<{ organization: Organization; prospects: OrganizationProspect[] }>(fetchFn, {
    method: 'GET',
    path: `/organizations/${organizationId}`,
    auth: 'required',
    token,
  });
}

export type UpdateOrganizationPatch = {
  name?: string;
  websiteUrl?: string;
};

export function updateOrganization(
  organizationId: number,
  patch: UpdateOrganizationPatch,
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<{ organization: Organization }> {
  return request<{ organization: Organization }>(fetchFn, {
    method: 'PATCH',
    path: `/organizations/${organizationId}`,
    body: patch,
    auth: 'required',
    token,
  });
}
