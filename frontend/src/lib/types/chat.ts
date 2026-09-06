// Mirrors backend domain/chat.ts + services/chat/threads.ts + services/chat/agent.ts.
export type ChatRole = 'user' | 'model' | 'tool' | 'job';

export type FunctionCallPart = {
  functionCall: { id: string; name: string; args: Record<string, unknown> };
};
export type TextPart = { text: string };
export type FunctionResponsePart = {
  functionResponse: { id: string; name: string; response: Record<string, unknown> };
};

export type ChatContent =
  | { role: 'user'; parts: TextPart[] }
  | { role: 'model'; parts: Array<TextPart | FunctionCallPart> }
  | { role: 'tool'; parts: FunctionResponsePart[] }
  | { role: 'job'; jobId: string; kind: string; status: string; summary: string };

export type ChatMessage = {
  id: number;
  role: ChatRole;
  content: ChatContent;
  createdAt: string;
};

// The thread's pending call as the UI sees it (the backend also keeps the
// message it belongs to).
export type PendingCall = {
  callId: string;
  name: string;
  args: Record<string, unknown>;
};

export type ChatThread = {
  id: string;
  projectId: string | null;
  title: string;
  pendingCall: PendingCall | null;
  createdAt: string;
  updatedAt: string;
};

export type ChatEvent =
  | { type: 'message'; message: ChatMessage }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; callId: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; callId: string; name: string; ok: boolean; text: string }
  | { type: 'confirm_required'; callId: string; name: string; args: Record<string, unknown> }
  | { type: 'job_started'; jobId: string; kind: string }
  | { type: 'done' }
  | { type: 'error'; message: string };
