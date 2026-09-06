<script lang="ts">
  import { goto, invalidate } from '$app/navigation';
  import { ApiError } from '$lib/api';
  import { confirmChatCall, createThread, deleteThread, sendChatMessage } from '$lib/api/chat';
  import { cancelJob, getJob } from '$lib/api/jobs';
  import ThreadList from '$lib/components/chat/ThreadList.svelte';
  import MessageItem from '$lib/components/chat/MessageItem.svelte';
  import JobCard from '$lib/components/chat/JobCard.svelte';
  import ConfirmCard from '$lib/components/chat/ConfirmCard.svelte';
  import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
  import type { ChatEvent, ChatMessage, PendingCall } from '$lib/types/chat';
  import { TERMINAL_JOB_STATUSES, type Job } from '$lib/types/jobs';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  let token = $derived(data.session?.access_token ?? '');

  // The persisted transcript comes from the loader; the pieces below exist
  // only while a turn streams and are folded back in by the next invalidate.
  let liveMessages = $state<ChatMessage[]>([]);
  let streamingText = $state('');
  let liveTools = $state<Array<{ callId: string; name: string; ok: boolean | null }>>([]);
  let pending = $state<PendingCall | null>(null);
  let jobs = $state<Record<string, Job>>({});
  let busy = $state(false);
  let error = $state('');
  let input = $state('');
  let deleting = $state<string | null>(null);
  let bottom = $state<HTMLDivElement | null>(null);
  // The stream in flight, and which thread it belongs to: switching threads
  // aborts it and drops anything it still emits.
  let controller: AbortController | null = null;
  let streamThreadId: string | null = null;
  let shownThreadId: string | null = null;

  $effect(() => {
    // Reset per-thread state on a thread switch only. Every invalidate hands
    // over a new `data`; the same thread keeps its error, job cards and the
    // turn in flight.
    const id = data.thread?.id ?? null;
    if (shownThreadId === id) return;
    shownThreadId = id;
    if (streamThreadId !== id) {
      controller?.abort();
      busy = false;
    }
    liveMessages = [];
    streamingText = '';
    liveTools = [];
    jobs = Object.fromEntries(data.jobs.map((j) => [j.id, j]));
    error = '';
    pending = data.thread?.pendingCall ?? null;
    for (const j of data.jobs) if (!TERMINAL_JOB_STATUSES.includes(j.status)) void watchJob(j.id, id);
  });

  let messages = $derived.by(() => {
    const seen = new Set(data.messages.map((m) => m.id));
    return [...data.messages, ...liveMessages.filter((m) => !seen.has(m.id))];
  });

  $effect(() => {
    void messages.length;
    void streamingText;
    bottom?.scrollIntoView({ block: 'end' });
  });

  // Tools after which the layout's project list (and the active project a
  // fresh tenant has none of) must be reloaded.
  const PROJECT_LIST_TOOLS = ['setup_project', 'delete_project'];
  let projectsChanged = false;

  const quickActions = [
    { label: "Run today's cycle", text: 'Run the daily cycle for this project.' },
    { label: 'Find 10 prospects', text: 'Find and register 10 new prospects.' },
    { label: 'Draft 5', text: 'Draft outreach for the next 5 reachable prospects.' },
    { label: 'Results?', text: 'How are the results so far? Give me the key numbers and what to do next.' },
  ];

  function handleEvent(threadId: string, e: ChatEvent) {
    if (threadId !== (data.thread?.id ?? streamThreadId)) return;
    switch (e.type) {
      case 'message':
        liveMessages = [...liveMessages, e.message];
        if (e.message.role === 'model') {
          streamingText = '';
          liveTools = [];
        }
        break;
      case 'text_delta':
        streamingText += e.text;
        break;
      case 'tool_call':
        liveTools = [...liveTools, { callId: e.callId, name: e.name, ok: null }];
        break;
      case 'tool_result':
        liveTools = liveTools.map((t) => (t.callId === e.callId ? { ...t, ok: e.ok } : t));
        if (e.ok && PROJECT_LIST_TOOLS.includes(e.name)) projectsChanged = true;
        break;
      case 'confirm_required':
        pending = { callId: e.callId, name: e.name, args: e.args };
        break;
      case 'job_started':
        void watchJob(e.jobId);
        break;
      case 'error':
        error = e.message;
        break;
      case 'done':
        break;
    }
  }

  // A short job (a single draft) reads as live; a long one (the daily cycle,
  // tens of minutes) is polled gently rather than every few seconds.
  const POLL_FAST_MS = 4000;
  const POLL_SLOW_MS = 15000;
  const POLL_FAST_FOR_MS = 60000;
  let mounted = true;
  $effect(() => () => {
    mounted = false;
    controller?.abort();
  });

  async function watchJob(id: string, threadId: string | null = streamThreadId) {
    const startedAt = Date.now();
    while (mounted) {
      try {
        const job = await getJob(id, fetch, token);
        if (!mounted || (data.thread?.id ?? null) !== threadId) return;
        jobs = { ...jobs, [id]: job };
        if (TERMINAL_JOB_STATUSES.includes(job.status)) {
          await invalidate('app:chat');
          return;
        }
      } catch {
        return;
      }
      await new Promise((r) => setTimeout(r, Date.now() - startedAt < POLL_FAST_FOR_MS ? POLL_FAST_MS : POLL_SLOW_MS));
    }
  }

  async function ensureThread(): Promise<string> {
    if (data.thread) return data.thread.id;
    const t = await createThread(data.activeProjectId ? { projectId: data.activeProjectId } : {}, fetch, token);
    // Claimed before the navigation: the load it triggers must see this turn
    // as belonging to the new thread, not abort it as a switch.
    streamThreadId = t.id;
    await goto(`/chat?t=${t.id}`, { replaceState: true, keepFocus: true, noScroll: true });
    return t.id;
  }

  async function runTurn(
    run: (threadId: string, onEvent: (e: ChatEvent) => void, signal: AbortSignal) => Promise<void>,
    onFail?: () => void,
  ) {
    if (busy) return;
    busy = true;
    error = '';
    const ac = new AbortController();
    controller = ac;
    try {
      const threadId = await ensureThread();
      streamThreadId = threadId;
      await run(threadId, (e) => handleEvent(threadId, e), ac.signal);
      if (!ac.signal.aborted) {
        if (projectsChanged) {
          projectsChanged = false;
          await invalidate('app:projects');
        }
        await invalidate('app:chat');
      }
    } catch (e) {
      if (ac.signal.aborted) return;
      error = e instanceof ApiError ? e.message : 'Something went wrong. Please try again.';
      onFail?.();
    } finally {
      if (controller === ac) {
        controller = null;
        busy = false;
        streamingText = '';
        liveTools = [];
      }
    }
  }

  function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    input = '';
    pending = null;
    void runTurn((threadId, onEvent, signal) => sendChatMessage(threadId, trimmed, token, onEvent, signal));
  }

  function respond(approve: boolean) {
    const p = pending;
    if (!p) return;
    pending = null;
    void runTurn(
      (threadId, onEvent, signal) => confirmChatCall(threadId, p.callId, approve, token, onEvent, signal),
      () => (pending = p),
    );
  }

  async function removeThread(id: string) {
    deleting = null;
    await deleteThread(id, fetch, token);
    if (data.thread?.id === id) await goto('/chat', { replaceState: true });
    else await invalidate('app:chat');
  }

  async function cancel(id: string) {
    const job = await cancelJob(id, fetch, token);
    jobs = { ...jobs, [id]: job };
  }
</script>

<svelte:head>
  <title>Chat · LeadAce</title>
</svelte:head>

<div class="flex h-[calc(100vh-7rem)] gap-4">
  <div class="hidden md:block">
    <ThreadList
      threads={data.threads}
      selectedId={data.thread?.id ?? null}
      onselect={(id) => goto(`/chat?t=${id}`, { keepFocus: true, noScroll: true })}
      onnew={() => goto('/chat', { keepFocus: true, noScroll: true })}
      ondelete={(id) => (deleting = id)}
    />
  </div>

  <section class="flex min-w-0 flex-1 flex-col">
    <div class="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
      {#if messages.length === 0 && !streamingText}
        <div class="mx-auto max-w-lg py-10 text-center">
          <h2 class="text-base font-semibold text-text">Ask Ace anything about your outreach</h2>
          <p class="mt-2 text-sm text-text-muted">
            {#if data.activeProjectId}
              Find prospects, draft outreach, run the daily cycle, or ask how the numbers look.
            {:else}
              Paste your company's website URL to set up your first project. Ace reads the site, proposes who to
              contact and what to say, and starts once you approve.
            {/if}
          </p>
        </div>
      {/if}
      {#each messages as m (m.id)}
        <MessageItem content={m.content} />
        {#if m.content.role === 'job' && jobs[m.content.jobId]}
          <JobCard job={jobs[m.content.jobId]!} />
        {/if}
      {/each}
      {#each Object.values(jobs).filter((j) => !TERMINAL_JOB_STATUSES.includes(j.status)) as job (job.id)}
        <JobCard {job} oncancel={cancel} />
      {/each}
      {#if streamingText || liveTools.length > 0}
        <div class="max-w-[85%] space-y-1">
          {#if streamingText}
            <p class="whitespace-pre-wrap text-sm text-text">{streamingText}</p>
          {/if}
          {#each liveTools as t (t.callId)}
            <div class="inline-flex items-center gap-1 rounded bg-surface px-2 py-0.5 font-mono text-[11px] text-text-secondary">
              {t.name} {t.ok === null ? '…' : t.ok ? '✓' : '✗'}
            </div>
          {/each}
        </div>
      {:else if busy}
        <p class="text-xs text-text-muted">Thinking…</p>
      {/if}
      {#if pending}
        <ConfirmCard {pending} {busy} onrespond={respond} />
      {/if}
      {#if error}
        <p class="text-xs text-danger">{error}</p>
      {/if}
      <div bind:this={bottom}></div>
    </div>

    <div class="mt-3 border-t border-border pt-3">
      {#if data.activeProjectId}
        <div class="mb-2 flex flex-wrap gap-1.5">
          {#each quickActions as a (a.label)}
            <button
              type="button"
              disabled={busy}
              onclick={() => send(a.text)}
              class="rounded-full border border-border px-2.5 py-1 text-xs text-text-secondary hover:bg-surface hover:text-text disabled:opacity-50"
            >
              {a.label}
            </button>
          {/each}
        </div>
      {/if}
      <form
        class="flex gap-2"
        onsubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <textarea
          bind:value={input}
          rows={2}
          placeholder={data.activeProjectId ? 'Tell Ace what to do…' : 'https://your-company.com'}
          disabled={busy}
          onkeydown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send(input);
            }
          }}
          class="min-w-0 flex-1 resize-none rounded border border-border bg-page px-3 py-2 text-sm text-text focus:border-accent focus:outline-none disabled:opacity-60"
        ></textarea>
        <button
          type="submit"
          disabled={busy || !input.trim()}
          class="self-end rounded bg-accent px-4 py-2 text-sm font-medium text-page hover:bg-accent-strong disabled:opacity-50"
        >
          Send
        </button>
      </form>
    </div>
  </section>
</div>

{#if deleting}
  <ConfirmDialog
    title="Delete this chat?"
    message="The conversation is removed. Jobs it started keep their results."
    confirmLabel="Delete"
    danger
    onconfirm={() => removeThread(deleting!)}
    oncancel={() => (deleting = null)}
  />
{/if}
