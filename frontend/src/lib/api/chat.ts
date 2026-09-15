import { API_BASE, request, type RequestFetch } from '../api';
import type { ChatEvent, ChatMessage, ChatThread } from '$lib/types/chat';

export function listThreads(
  params: { projectId?: string; limit?: number },
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<ChatThread[]> {
  const sp = new URLSearchParams();
  if (params.projectId) sp.set('projectId', params.projectId);
  if (params.limit) sp.set('limit', String(params.limit));
  return request<{ threads: ChatThread[] }>(fetchFn, { method: 'GET', path: `/chat/threads?${sp}`, auth: 'required', token }).then((r) => r.threads);
}

export function createThread(
  body: { projectId?: string; title?: string },
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<ChatThread> {
  return request<ChatThread>(fetchFn, { method: 'POST', path: '/chat/threads', body, auth: 'required', token });
}

export function getThread(
  id: string,
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<{ thread: ChatThread; messages: ChatMessage[] }> {
  return request(fetchFn, { method: 'GET', path: `/chat/threads/${encodeURIComponent(id)}`, auth: 'required', token });
}

export function deleteThread(id: string, fetchFn: RequestFetch = fetch, token?: string): Promise<void> {
  return request<{ id: string }>(fetchFn, { method: 'DELETE', path: `/chat/threads/${encodeURIComponent(id)}`, auth: 'required', token }).then(() => undefined);
}

export function sendChatMessage(threadId: string, text: string, fetchFn: RequestFetch, token: string): Promise<ChatMessage> {
  return request<ChatMessage>(fetchFn, { method: 'POST', path: `/chat/threads/${encodeURIComponent(threadId)}/messages`, body: { text }, auth: 'required', token });
}

export function confirmChatCall(threadId: string, callId: string, approve: boolean, fetchFn: RequestFetch, token: string): Promise<void> {
  return request<void>(fetchFn, { method: 'POST', path: `/chat/threads/${encodeURIComponent(threadId)}/confirm`, body: { callId, approve }, auth: 'required', token });
}

// Resolves once the turn has stopped and recorded what ran.
export function stopChat(threadId: string, fetchFn: RequestFetch, token: string): Promise<void> {
  return request<void>(fetchFn, { method: 'POST', path: `/chat/threads/${encodeURIComponent(threadId)}/stop`, auth: 'required', token });
}

const RECONNECT_MS = 3000;
const RECONNECT_MAX_MS = 60000;

// The thread's live feed: every turn the agent takes on it, whoever set it
// off. A browser cannot put a header on a WebSocket, so the token rides as a
// subprotocol. A dropped socket reconnects, backing off while the server keeps
// refusing (a thread deleted in another tab), and every connection calls
// onOpen so the caller can catch up on what it missed. Returns the function
// that closes the feed.
export function watchThread(
  threadId: string,
  token: () => string,
  onEvent: (e: ChatEvent) => void,
  onOpen: () => void,
): () => void {
  let socket: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let delay = RECONNECT_MS;
  let closed = false;
  const connect = () => {
    socket = new WebSocket(`${API_BASE.replace(/^http/, 'ws')}/api/chat/threads/${encodeURIComponent(threadId)}/live`, ['leadace', token()]);
    socket.onopen = () => {
      delay = RECONNECT_MS;
      onOpen();
    };
    socket.onmessage = (m) => onEvent(JSON.parse(m.data as string) as ChatEvent);
    socket.onclose = () => {
      if (closed) return;
      retry = setTimeout(connect, delay);
      delay = Math.min(delay * 2, RECONNECT_MAX_MS);
    };
  };
  connect();
  return () => {
    closed = true;
    clearTimeout(retry);
    socket?.close();
  };
}
