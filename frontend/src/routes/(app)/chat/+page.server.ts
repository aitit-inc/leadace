import { isHttpError, redirect } from '@sveltejs/kit';
import { getThread, listThreads } from '$lib/api/chat';
import { listThreadJobs } from '$lib/api/jobs';
import type { Job } from '$lib/types/jobs';
import { ApiError } from '$lib/api';
import type { ChatMessage, ChatThread } from '$lib/types/chat';
import type { PageServerLoad } from './$types';

// The selected thread lives in ?t= so a reload or a shared link lands on it.
export const load: PageServerLoad = async ({ fetch, parent, url, locals, depends }) => {
  depends('app:chat');
  const { activeProjectId } = await parent();
  const token = locals.session?.access_token;
  const threads = await listThreads(activeProjectId ? { projectId: activeProjectId } : {}, fetch, token);
  const requested = url.searchParams.get('t');

  // The list is the active project's; the selected thread may belong to
  // another one (the chat created a project mid-conversation) and is fetched
  // on its own. Only a thread that no longer exists falls back to /chat.
  let thread: ChatThread | null = null;
  let messages: ChatMessage[] = [];
  let jobs: Job[] = [];
  if (requested) {
    try {
      const [r, j] = await Promise.all([getThread(requested, fetch, token), listThreadJobs(requested, fetch, token)]);
      thread = r.thread;
      messages = r.messages;
      jobs = j;
    } catch (e) {
      if (isHttpError(e)) throw e;
      if (!(e instanceof ApiError && e.status === 404)) throw e;
      redirect(303, '/chat');
    }
  }
  return { activeProjectId, threads, thread, messages, jobs };
};
