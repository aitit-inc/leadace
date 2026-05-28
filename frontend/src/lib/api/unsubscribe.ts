import { request, type RequestFetch } from '../api';

export type UnsubscribeInfo = {
  email: string;
  organizationName: string;
  alreadyUnsubscribed: boolean;
};

export function loadUnsubscribeInfo(
  token: string,
  fetchFn: RequestFetch = fetch,
): Promise<UnsubscribeInfo> {
  return request<UnsubscribeInfo>(fetchFn, {
    method: 'GET',
    path: `/unsubscribe/${encodeURIComponent(token)}`,
    auth: 'none',
  });
}

export function confirmUnsubscribe(
  token: string,
  fetchFn: RequestFetch = fetch,
): Promise<{ unsubscribed: true }> {
  return request<{ unsubscribed: true }>(fetchFn, {
    method: 'POST',
    path: `/unsubscribe/${encodeURIComponent(token)}`,
    auth: 'none',
  });
}
