import { request, type RequestFetch } from '../api';
import type { DashboardPeriod, DashboardSummary } from '$lib/types/dashboard';

export function getDashboardSummary(
  projectId: string,
  period: DashboardPeriod,
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<DashboardSummary> {
  const sp = new URLSearchParams({ period });
  return request<DashboardSummary>(fetchFn, {
    method: 'GET',
    path: `/projects/${projectId}/dashboard?${sp}`,
    auth: 'required',
    token,
  });
}
