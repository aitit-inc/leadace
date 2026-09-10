import { describe, expect, it } from 'vitest';
import { answerSaved, stillFinishing } from './chat-stop';
import type { ChatContent, ChatMessage } from './types/chat';

let nextId = 0;
const msg = (content: ChatContent): ChatMessage => ({ id: ++nextId, role: content.role, content, createdAt: '' });
const user = (text: string) => msg({ role: 'user', parts: [{ text }] });
const model = (text: string, callIds: string[] = []) =>
  msg({
    role: 'model',
    parts: [...(text ? [{ text }] : []), ...callIds.map((id) => ({ functionCall: { id, name: 'list_projects', args: {} } }))],
  });
const tool = (callIds: string[]) =>
  msg({ role: 'tool', parts: callIds.map((id) => ({ functionResponse: { id, name: 'list_projects', response: { result: 'ok' } } })) });

describe('stillFinishing', () => {
  it('waits for a started call whose result is not saved', () => {
    expect(stillFinishing([user('go'), model('', ['c1', 'c2']), tool(['c1'])], '', false)).toBe(true);
  });

  it('is done once every call has its result', () => {
    expect(stillFinishing([user('go'), model('', ['c1', 'c2']), tool(['c1', 'c2'])], '', false)).toBe(false);
  });

  it('waits for the answer that was being written, not an earlier one that reads the same', () => {
    expect(stillFinishing([model('Here are ten'), user('go')], 'Here are ten', false)).toBe(true);
  });

  it('is done once the saved answer holds what was shown', () => {
    expect(stillFinishing([user('go'), model('Here are ten ideas: 1.')], 'Here are ten', false)).toBe(false);
  });

  it('has nothing to wait for when the turn stopped before any output', () => {
    expect(stillFinishing([user('go')], '', false)).toBe(false);
  });

  it('ignores a call an earlier turn left without a result', () => {
    expect(stillFinishing([user('first'), model('', ['old']), user('go')], '', false)).toBe(false);
  });

  it('does not wait on a call awaiting approval', () => {
    expect(stillFinishing([user('go'), model('', ['c1'])], '', true)).toBe(false);
  });
});

describe('answerSaved', () => {
  it('holds once the saved answer begins with what was shown, while its call still runs', () => {
    const messages = [user('go'), model('Here are ten', ['c1'])];
    expect(answerSaved(messages, 'Here are')).toBe(true);
    expect(stillFinishing(messages, 'Here are', false)).toBe(true);
  });
});
