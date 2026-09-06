import { API_BASE, ApiError, request, throwApiError, type RequestFetch } from '../api';
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

// One streamed turn: POST, then read `event:` / `data:` frames until the body
// ends. The transport in $lib/api.ts is JSON-only, so this owns its own fetch.
async function streamTurn(
  path: string,
  body: unknown,
  token: string,
  onEvent: (e: ChatEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${API_BASE}/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) await throwApiError(res, 'required');
  if (!res.body) throw new ApiError(res.status, 'The server sent no stream.');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let terminal = false;
  const deliver = (e: ChatEvent) => {
    if (e.type === 'done' || e.type === 'error') terminal = true;
    onEvent(e);
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = frame
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      deliver(JSON.parse(data) as ChatEvent);
    }
  }
  // A stream that ends without `done` or `error` was cut: the turn may have
  // stopped anywhere, so say so instead of reading the silence as success.
  if (!terminal) throw new ApiError(0, 'The connection ended before the turn finished. Reload to see what was saved.');
}

export function sendChatMessage(threadId: string, text: string, token: string, onEvent: (e: ChatEvent) => void, signal?: AbortSignal): Promise<void> {
  return streamTurn(`/chat/threads/${encodeURIComponent(threadId)}/messages`, { text }, token, onEvent, signal);
}

export function confirmChatCall(threadId: string, callId: string, approve: boolean, token: string, onEvent: (e: ChatEvent) => void, signal?: AbortSignal): Promise<void> {
  return streamTurn(`/chat/threads/${encodeURIComponent(threadId)}/confirm`, { callId, approve }, token, onEvent, signal);
}
