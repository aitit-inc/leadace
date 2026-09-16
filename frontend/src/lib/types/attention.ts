// Mirrors backend/src/domain/attention.ts `AttentionItem`.
export type QuotaConstraint = 'lifetime' | 'monthly';

export type AttentionItem =
	| { kind: 'hot_leads'; count: number }
	| { kind: 'no_project' }
	| { kind: 'compliance_incomplete'; missing: string[] }
	| { kind: 'gmail_disconnected' }
	| { kind: 'gmail_auth_revoked'; fromEmail: string; since: string }
	| { kind: 'mailbox_send_refused'; fromEmail: string; sentThatDay: number }
	| { kind: 'no_outbound_channels' }
	| { kind: 'quota_exhausted'; constraint: QuotaConstraint }
	| { kind: 'credit_top_up_failed'; since: string }
	| { kind: 'reply_collection_scope_missing'; fromEmail: string }
	| { kind: 'reply_collection_failing'; fromEmail: string; since: string; detail: string | null }
	| { kind: 'outreach_futility'; projectId: string; projectName: string; sends: number; engaged: number }
	| { kind: 'outreach_drafts'; count: number };
