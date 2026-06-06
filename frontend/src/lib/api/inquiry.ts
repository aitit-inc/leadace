import { request, type RequestFetch } from '../api';

export type InquiryOutcome = 'opened' | 'inquired' | 'lead' | 'signup_clicked' | 'unsubscribed';

// Discriminated CTA payload — landing renders one variant, never both.
// 'meeting' is the human-sales path (Book/Request meeting); schedulingUrl
// is optional and, when null, the button is notify-only. 'signup' is the
// self-serve path (Sign up button → SaaS signup page); signupUrl is
// always present (the backend rejects signup mode without a URL).
export type InquiryLandingCta =
  | { type: 'meeting'; schedulingUrl: string | null }
  | { type: 'signup'; signupUrl: string };

export type InquiryLandingSession = {
  id: number;
  outcome: InquiryOutcome;
  chatTurnsUsed: number;
  chatTurnsMax: number;
  closed: boolean;
};

export type InquiryLandingPayload = {
  shortId: string | null;
  preview: boolean;

  senderName: string | null;
  senderCompany: string | null;
  senderJobTitle: string | null;
  brandColor: string | null;
  brandLogoUrl: string | null;
  // Landing background mode. false = light canvas, true = dark. The landing
  // view toggles the `.dark` class on its root so theme tokens follow it.
  backgroundDark: boolean;

  recipientName: string | null;
  recipientOrganization: string | null;

  oneLiner: string | null;
  videoUrl: string | null;
  pdfUrl: string | null;
  cta: InquiryLandingCta;

  chatEnabled: boolean;
  chatFaqSuggestions: string[];
  session: InquiryLandingSession | null;
};

export type InquiryChatMessageResult = {
  assistantMessage: string;
  chatTurnsUsed: number;
  chatTurnsMax: number;
  sessionClosed: boolean;
  reachedTurnLimit: boolean;
};

export type InquiryChatTurn = { role: 'user' | 'assistant'; content: string };

// Mirrors backend REJECTION_PRIMARY_REASONS — frontend exposes the
// chip-relevant subset to keep the landing chip strip honest.
export type InquiryPrimaryReason =
  | 'not_relevant'
  | 'wrong_timing'
  | 'already_have_solution'
  | 'budget'
  | 'feature_gap'
  | 'other';

export type InquiryUnsubscribeBody = {
  primary_reason?: InquiryPrimaryReason;
  free_text?: string;
};

export type InquiryUnsubscribeResult = {
  unsubscribed: true;
  responseId: number | null;
};

export type InquiryRequestMeetingResult = {
  responseId: number;
};

export type InquirySignupClickResult = {
  sessionId: number;
};

export function loadLanding(
  shortId: string,
  fetchFn: RequestFetch = fetch,
): Promise<InquiryLandingPayload> {
  return request<InquiryLandingPayload>(fetchFn, {
    method: 'GET',
    path: `/inquiry/${encodeURIComponent(shortId)}`,
    auth: 'none',
  });
}

// Preview is sender-side and auth-required, so it goes through the
// authenticated transport (which redirects to /login on 401) rather than
// the public path used by loadLanding.
export function loadInquiryPreview(
  projectId: string,
  prospectId: number | null,
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<InquiryLandingPayload> {
  const sp = new URLSearchParams({ projectId });
  if (prospectId !== null) sp.set('prospectId', String(prospectId));
  return request<InquiryLandingPayload>(fetchFn, {
    method: 'GET',
    path: `/inquiry/preview?${sp}`,
    auth: 'required',
    token,
  });
}

// Stateless: the server records nothing, so the client carries the transcript.
export function sendPreviewChatMessage(
  projectId: string,
  prospectId: number | null,
  transcript: InquiryChatTurn[],
  message: string,
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<InquiryChatMessageResult> {
  return request<InquiryChatMessageResult>(fetchFn, {
    method: 'POST',
    path: '/inquiry/preview/message',
    body: {
      projectId,
      ...(prospectId !== null ? { prospectId } : {}),
      transcript,
      message,
    },
    auth: 'required',
    token,
  });
}

export function sendChatMessage(
  shortId: string,
  message: string,
  fetchFn: RequestFetch = fetch,
): Promise<InquiryChatMessageResult> {
  return request<InquiryChatMessageResult>(fetchFn, {
    method: 'POST',
    path: `/inquiry/${encodeURIComponent(shortId)}/message`,
    body: { message },
    auth: 'none',
  });
}

export function unsubscribeInquiry(
  shortId: string,
  body: InquiryUnsubscribeBody,
  fetchFn: RequestFetch = fetch,
): Promise<InquiryUnsubscribeResult> {
  return request<InquiryUnsubscribeResult>(fetchFn, {
    method: 'POST',
    path: `/inquiry/${encodeURIComponent(shortId)}/unsubscribe`,
    body,
    auth: 'none',
  });
}

export function requestMeeting(
  shortId: string,
  note: string | undefined,
  fetchFn: RequestFetch = fetch,
): Promise<InquiryRequestMeetingResult> {
  return request<InquiryRequestMeetingResult>(fetchFn, {
    method: 'POST',
    path: `/inquiry/${encodeURIComponent(shortId)}/request-meeting`,
    body: note ? { note } : {},
    auth: 'none',
  });
}

export function recordSignupClick(
  shortId: string,
  fetchFn: RequestFetch = fetch,
): Promise<InquirySignupClickResult> {
  return request<InquirySignupClickResult>(fetchFn, {
    method: 'POST',
    path: `/inquiry/${encodeURIComponent(shortId)}/signup-click`,
    auth: 'none',
  });
}
