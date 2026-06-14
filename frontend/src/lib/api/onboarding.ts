import { request, type RequestFetch } from '../api';

// Mirrors backend services/tenants.ts OnboardingStatus.
export type OnboardingStatus = {
  mcpConnected: boolean;
};

export function getOnboardingStatus(
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<OnboardingStatus> {
  return request<OnboardingStatus>(fetchFn, {
    method: 'GET',
    path: '/me/onboarding-status',
    auth: 'required',
    token,
  });
}
