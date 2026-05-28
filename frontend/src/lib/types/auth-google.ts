export type GmailStatus =
  | { state: 'connected'; email: string; updatedAt: string }
  | { state: 'disconnected' }
  | { state: 'error'; message: string };
