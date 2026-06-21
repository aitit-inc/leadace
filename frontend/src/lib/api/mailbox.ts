import { request, type RequestFetch } from '../api';
import type { MailboxHealth, MailboxWarmupPatch } from '$lib/types/mailbox';

export function getMailboxHealth(
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<MailboxHealth> {
  return request<MailboxHealth>(fetchFn, {
    method: 'GET',
    path: '/me/mailbox-health',
    auth: 'required',
    token,
  });
}

export function updateMailboxWarmup(
  patch: MailboxWarmupPatch,
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<MailboxHealth> {
  return request<MailboxHealth>(fetchFn, {
    method: 'PUT',
    path: '/me/mailbox-warmup',
    body: patch,
    auth: 'required',
    token,
  });
}
