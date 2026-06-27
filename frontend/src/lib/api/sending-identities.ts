import { request, type RequestFetch } from '../api';
import type {
  SendingIdentity,
  RegisterSmtpIdentityInput,
  MailboxWarmupPatch,
  MailboxHealth,
} from '$lib/types/sending-identity';

export function listSendingIdentities(
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<SendingIdentity[]> {
  return request<{ identities: SendingIdentity[] }>(fetchFn, {
    method: 'GET',
    path: '/me/sending-identities',
    auth: 'required',
    token,
  }).then((r) => r.identities);
}

export function registerSmtpIdentity(
  input: RegisterSmtpIdentityInput,
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<SendingIdentity> {
  return request<SendingIdentity>(fetchFn, {
    method: 'POST',
    path: '/me/sending-identities',
    body: input,
    auth: 'required',
    token,
  });
}

export function updateIdentityWarmup(
  identityId: string,
  patch: MailboxWarmupPatch,
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<MailboxHealth> {
  return request<MailboxHealth>(fetchFn, {
    method: 'PUT',
    path: `/me/sending-identities/${identityId}/warmup`,
    body: patch,
    auth: 'required',
    token,
  });
}

export function deleteSendingIdentity(
  identityId: string,
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<{ deleted: true }> {
  return request<{ deleted: true }>(fetchFn, {
    method: 'DELETE',
    path: `/me/sending-identities/${identityId}`,
    auth: 'required',
    token,
  });
}
