export type GmailStatus =
  | { state: 'connected'; email: string; updatedAt: string }
  | { state: 'revoked'; email: string; since: string }
  | { state: 'disconnected' }
  | { state: 'error'; message: string };
