import { request, type RequestFetch } from '../api';
import type { FunnelStageFilter, OutreachLog } from '$lib/types/outreach';

export type ListOutreachParams = {
  page: number;
  limit: number;
  stage?: FunnelStageFilter;
  period?: '7d' | '30d';
};

export function listOutreach(
  projectId: string,
  params: ListOutreachParams,
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<{ logs: OutreachLog[]; total: number }> {
  const sp = new URLSearchParams({
    limit: String(params.limit),
    offset: String((params.page - 1) * params.limit),
  });
  if (params.stage) sp.set('stage', params.stage);
  if (params.period) sp.set('period', params.period);
  return request<{ logs: OutreachLog[]; total: number }>(fetchFn, {
    method: 'GET',
    path: `/projects/${projectId}/outreach/recent?${sp}`,
    auth: 'required',
    token,
  });
}
