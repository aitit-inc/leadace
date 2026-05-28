import { request, type RequestFetch } from '../api';
import type { Prospect, ProspectStatus } from '$lib/types/prospects';

export type ListProspectsParams = {
  page: number;
  limit: number;
  status?: ProspectStatus;
  priority?: number;
  q?: string;
};

export function listProspects(
  projectId: string,
  params: ListProspectsParams,
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<{ prospects: Prospect[]; total: number }> {
  const sp = new URLSearchParams({
    limit: String(params.limit),
    offset: String((params.page - 1) * params.limit),
  });
  if (params.status) sp.set('status', params.status);
  if (params.priority !== undefined) sp.set('priority', String(params.priority));
  if (params.q) sp.set('q', params.q);
  return request<{ prospects: Prospect[]; total: number }>(fetchFn, {
    method: 'GET',
    path: `/projects/${projectId}/prospects?${sp}`,
    auth: 'required',
    token,
  });
}
