import { request, type RequestFetch } from '../api';

export function deleteAccount(
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<void> {
  return request<void>(fetchFn, {
    method: 'DELETE',
    path: '/me/account',
    auth: 'required',
    token,
  });
}
