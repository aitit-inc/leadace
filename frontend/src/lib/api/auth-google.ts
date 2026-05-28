import { request, type RequestFetch } from '../api';

export type GmailCredentialsStatus = {
  connected: boolean;
  email?: string;
  updatedAt?: string;
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

export type SaveGoogleCredentialsBody = {
  refreshToken: string;
  scope: string;
  email: string;
};

// Called once during the OAuth callback (the only point at which Supabase
// hands us a provider_refresh_token). Backend rejects with 400 when the
// gmail.send scope wasn't granted — the callback handler uses that status to
// drop the user back at /login with a consent-required prompt.
export function saveGoogleCredentials(
  body: SaveGoogleCredentialsBody,
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<void> {
  return request<void>(fetchFn, {
    method: 'POST',
    path: '/auth/google-credentials',
    body,
    auth: 'required',
    token,
  });
}
