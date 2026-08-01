// Mirrors backend/src/domain/alerts.ts `Alert`.
export type Alert =
	| { kind: 'reply_collection_revoked'; fromEmail: string; since: string }
	| { kind: 'reply_collection_scope_missing'; fromEmail: string };
