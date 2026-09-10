import type { ChatMessage } from '$lib/types/chat';

// The newest model message is the stopped turn's only if no person message follows it.
function stoppedAnswer(messages: ChatMessage[]) {
  const i = messages.findLastIndex((m) => m.content.role === 'model');
  const last = messages[i];
  const later = messages.slice(i + 1);
  if (!last || last.content.role !== 'model' || later.some((m) => m.content.role === 'user')) return null;
  return { parts: last.content.parts, later };
}

export function answerSaved(messages: ChatMessage[], stoppedText: string): boolean {
  const text = stoppedAnswer(messages)?.parts.map((p) => ('text' in p ? p.text : '')).join('') ?? '';
  return text.startsWith(stoppedText);
}

// A call awaiting approval is not finishing: it waits on the person.
export function stillFinishing(messages: ChatMessage[], stoppedText: string, awaitingApproval: boolean): boolean {
  if (awaitingApproval) return false;
  if (!answerSaved(messages, stoppedText)) return true;
  const answer = stoppedAnswer(messages);
  if (!answer) return false;
  const answered = new Set(answer.later.flatMap((m) => (m.content.role === 'tool' ? m.content.parts.map((p) => p.functionResponse.id) : [])));
  return answer.parts.some((p) => 'functionCall' in p && !answered.has(p.functionCall.id));
}
