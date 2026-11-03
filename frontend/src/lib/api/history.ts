import { request, type RequestFetch } from '../api';
import type { HistoryRow } from '$lib/types/dashboard';

export async function getHistory(projectId: string, fetchFn: RequestFetch = fetch, token?: string): Promise<HistoryRow[]> {
  const { rows } = await request<{ rows: HistoryRow[] }>(fetchFn, {
    method: 'GET',
    path: `/projects/${projectId}/history`,
    auth: 'required',
    token,
  });
  return rows;
}
