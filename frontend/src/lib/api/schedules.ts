import { request, type RequestFetch } from '../api';
import type { NewSchedule, Schedule, SchedulePatch } from '$lib/types/schedules';

export function listSchedules(
  projectId: string,
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<{ schedules: Schedule[] }> {
  return request(fetchFn, {
    method: 'GET',
    path: `/schedules?projectId=${encodeURIComponent(projectId)}`,
    auth: 'required',
    token,
  });
}

export function createSchedule(
  body: NewSchedule,
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<Schedule> {
  return request(fetchFn, { method: 'POST', path: '/schedules', body, auth: 'required', token });
}

export function updateSchedule(
  id: string,
  patch: SchedulePatch,
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<Schedule> {
  return request(fetchFn, {
    method: 'PATCH',
    path: `/schedules/${encodeURIComponent(id)}`,
    body: patch,
    auth: 'required',
    token,
  });
}

export function deleteSchedule(
  id: string,
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<{ id: string }> {
  return request(fetchFn, {
    method: 'DELETE',
    path: `/schedules/${encodeURIComponent(id)}`,
    auth: 'required',
    token,
  });
}
