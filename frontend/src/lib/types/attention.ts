// Mirrors backend/src/domain/attention.ts `AttentionItem`.
export type QuotaConstraint = 'daily' | 'lifetime' | 'monthly';

export type AttentionItem =
	| { kind: 'hot_leads'; count: number }
	| { kind: 'mcp_not_connected' }
	| { kind: 'compliance_incomplete'; missing: string[] }
	| { kind: 'gmail_disconnected' }
	| { kind: 'gmail_auth_revoked'; fromEmail: string; since: string }
	| { kind: 'no_outbound_channels' }
	| { kind: 'quota_exhausted'; constraint: QuotaConstraint }
	| { kind: 'reply_collection_scope_missing'; fromEmail: string }
	| { kind: 'reply_collection_failing'; fromEmail: string; since: string; detail: string | null }
	| { kind: 'outreach_futility'; projectId: string; projectName: string; sends: number; replies: number }
	| { kind: 'outreach_drafts'; count: number };
