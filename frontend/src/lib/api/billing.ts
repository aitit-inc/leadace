import { request, type RequestFetch } from '../api';
import type { AutoTopUp, PaidPlanTier, PlanInfo, SubscriptionInfo } from '$lib/types/plan';

export function getPlan(
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<PlanInfo> {
  return request<PlanInfo>(fetchFn, {
    method: 'GET',
    path: '/me/plan',
    auth: 'required',
    token,
  });
}

export type CreateCheckoutSessionBody = {
  priceId: string;
  successUrl: string;
  cancelUrl: string;
};

export function createCheckoutSession(
  body: CreateCheckoutSessionBody,
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<{ url: string }> {
  return request<{ url: string }>(fetchFn, {
    method: 'POST',
    path: '/me/checkout',
    body,
    auth: 'required',
    token,
  });
}

export type CreatePortalSessionBody = {
  returnUrl: string;
};

export function createPortalSession(
  body: CreatePortalSessionBody,
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<{ url: string }> {
  return request<{ url: string }>(fetchFn, {
    method: 'POST',
    path: '/me/portal',
    body,
    auth: 'required',
    token,
  });
}

export type CreateCreditCheckoutBody = {
  packCents: number;
  successUrl: string;
  cancelUrl: string;
};

export function createCreditCheckoutSession(
  body: CreateCreditCheckoutBody,
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<{ url: string }> {
  return request<{ url: string }>(fetchFn, {
    method: 'POST',
    path: '/me/credits/checkout',
    body,
    auth: 'required',
    token,
  });
}

export type AutoTopUpPatch = {
  enabled: boolean;
  amountCents?: number;
  thresholdCents?: number;
};

export function updateAutoTopUp(
  body: AutoTopUpPatch,
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<AutoTopUp> {
  return request<AutoTopUp>(fetchFn, {
    method: 'PUT',
    path: '/me/credits/auto-top-up',
    body,
    auth: 'required',
    token,
  });
}

export function getSubscription(
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<SubscriptionInfo> {
  return request<SubscriptionInfo>(fetchFn, {
    method: 'GET',
    path: '/me/subscription',
    auth: 'required',
    token,
  });
}

// An upgrade applies now and is charged today; a downgrade is scheduled for
// the period end.
export function changePlan(
  body: { priceId: string; fromPlan: PaidPlanTier; periodEnd: string },
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<SubscriptionInfo> {
  return request<SubscriptionInfo>(fetchFn, {
    method: 'POST',
    path: '/me/plan-change',
    body,
    auth: 'required',
    token,
  });
}

export function cancelPlanChange(
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<SubscriptionInfo> {
  return request<SubscriptionInfo>(fetchFn, {
    method: 'DELETE',
    path: '/me/plan-change',
    auth: 'required',
    token,
  });
}
