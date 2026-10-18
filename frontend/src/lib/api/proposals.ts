import { request, type RequestFetch } from '../api';
import type { Proposal, ProposalStatus } from '$lib/types/proposals';

export function listProposals(
  projectId: string,
  params: { status?: ProposalStatus },
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<{ proposals: Proposal[] }> {
  const qs = params.status ? `?status=${params.status}` : '';
  return request<{ proposals: Proposal[] }>(fetchFn, {
    method: 'GET',
    path: `/projects/${projectId}/proposals${qs}`,
    auth: 'required',
    token,
  });
}

export function applyProposal(
  id: number,
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<{ id: number; status: ProposalStatus }> {
  return request<{ id: number; status: ProposalStatus }>(fetchFn, {
    method: 'POST',
    path: `/proposals/${id}/apply`,
    auth: 'required',
    token,
  });
}

export function stopProposal(
  id: number,
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<{ id: number; status: ProposalStatus }> {
  return request<{ id: number; status: ProposalStatus }>(fetchFn, {
    method: 'POST',
    path: `/proposals/${id}/stop`,
    auth: 'required',
    token,
  });
}
