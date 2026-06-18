import { request, type RequestFetch } from '../api';

export type AccountDeletionReason =
  | 'too_expensive'
  | 'not_enough_results'
  | 'missing_features'
  | 'too_hard_to_use'
  | 'switched_to_alternative'
  | 'no_longer_needed'
  | 'other';

export type AccountDeletionSurvey =
  | { reason: Exclude<AccountDeletionReason, 'other'> }
  | { reason: 'other'; detail: string };

export function deleteAccount(
  survey: AccountDeletionSurvey,
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<void> {
  return request<void>(fetchFn, {
    method: 'DELETE',
    path: '/me/account',
    auth: 'required',
    token,
    body: survey,
  });
}
