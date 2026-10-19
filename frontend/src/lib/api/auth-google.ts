import { request, type RequestFetch } from '../api';

export type GmailCredentialsStatus = {
  connected: boolean;
  email?: string;
  updatedAt?: string;
  revokedSince?: string | null;
};

export function getGmailStatus(
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<GmailCredentialsStatus> {
  return request<GmailCredentialsStatus>(fetchFn, {
    method: 'GET',
    path: '/auth/google-credentials/status',
    auth: 'required',
    token,
  });
}
