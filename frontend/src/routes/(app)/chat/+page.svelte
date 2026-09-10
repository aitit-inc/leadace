<script lang="ts">
  import { goto, invalidate } from '$app/navigation';
  import { ApiError } from '$lib/api';
  import { confirmChatCall, createThread, deleteThread, sendChatMessage } from '$lib/api/chat';
  import { cancelJob, getJob } from '$lib/api/jobs';
  import { answerSaved, stillFinishing } from '$lib/chat-stop';
  import ThreadList from '$lib/components/chat/ThreadList.svelte';
  import MessageItem from '$lib/components/chat/MessageItem.svelte';
  import JobCard from '$lib/components/chat/JobCard.svelte';
  import ConfirmCard from '$lib/components/chat/ConfirmCard.svelte';
  import SenderIdentityCard, { type SenderIdentityProposal } from '$lib/components/chat/SenderIdentityCard.svelte';
  import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
  import type { ChatEvent, ChatMessage, PendingCall } from '$lib/types/chat';
  import { TERMINAL_JOB_STATUSES, type Job, type JobDetail } from '$lib/types/jobs';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  let token = $derived(data.session?.access_token ?? '');

  // The persisted transcript comes from the loader; the pieces below exist
  // only while a turn streams and are folded back in by the next invalidate.
  let liveMessages = $state<ChatMessage[]>([]);
  let streamingText = $state('');
  let liveSteps = $state(0);
  let stoppedText = $state('');
  let stopping = $state(false);
  // Stop waits for the server's first event: before it, the turn's own writes
  // (the message, a claimed approval) could still land after the stop settled.
  let accepted = $state(false);
  let pending = $state<PendingCall | null>(null);
  let jobs = $state<Record<string, Job | JobDetail>>({});
  let busy = $state(false);
  let error = $state('');
  let input = $state('');
  let deleting = $state<string | null>(null);
  let bottom = $state<HTMLDivElement | null>(null);
  // The stream in flight, and which thread it belongs to: switching threads
  // aborts it and drops anything it still emits.
  let controller: AbortController | null = null;
  let streamThreadId: string | null = null;
  // A thread switch or a later stop takes over from the stop in progress.
  let stopper: object | null = null;
  // A thread, or one project's home. A request started for an earlier view,
  // even one left and come back to, finds the generation moved on.
  let shownView: string | undefined;
  let viewGen = 0;

  $effect(() => {
    // Reset per-view state on a view switch only. Every invalidate hands
    // over a new `data`; the same view keeps its error, job cards and the
    // turn in flight.
    const id = data.thread?.id ?? null;
    const view = id ?? `home:${data.activeProjectId}`;
    if (shownView === view) return;
    shownView = view;
    viewGen++;
    if (streamThreadId !== id) {
      controller?.abort();
      busy = false;
    }
    liveMessages = [];
    streamingText = '';
    liveSteps = 0;
    stoppedText = '';
    stopping = false;
    stopper = null;
    jobs = Object.fromEntries(data.jobs.map((j) => [j.id, j]));
    error = '';
    pending = data.thread?.pendingCall ?? null;
    for (const j of data.jobs) if (!TERMINAL_JOB_STATUSES.includes(j.status)) void watchJob(j.id);
  });

  let messages = $derived.by(() => {
    const seen = new Set(data.messages.map((m) => m.id));
    return [...data.messages, ...liveMessages.filter((m) => !seen.has(m.id))];
  });

  let activity = $derived(data.thread ? [] : data.jobs.map((j) => jobs[j.id] ?? j));

  $effect(() => {
    void messages.length;
    void streamingText;
    bottom?.scrollIntoView({ block: 'end' });
  });

  let proposal = $derived.by((): SenderIdentityProposal => {
    const calls = messages.flatMap((m) =>
      m.content.role === 'model' ? m.content.parts.flatMap((p) => ('functionCall' in p ? [p.functionCall] : [])) : [],
    );
    const call = calls.findLast((c) => c.name === 'propose_sender_identity');
    const text = (k: string) => {
      const v = call?.args[k];
      return typeof v === 'string' ? v : null;
    };
    return { callId: call?.id ?? null, legalName: text('legalName'), postalAddress: text('postalAddress'), senderCountry: text('senderCountry') };
  });
  let showIdentityCard = $derived(
    data.attention.some((a) => a.kind === 'compliance_incomplete') && (data.thread?.projectId ?? data.activeProjectId) !== null,
  );

  async function identitySaved() {
    await Promise.all([invalidate('app:chat'), invalidate('app:attention')]);
    send('Sender identity saved.');
  }

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
    accepted = true;
    switch (e.type) {
      case 'message':
        liveMessages = [...liveMessages, e.message];
        if (e.message.role === 'model') {
          streamingText = '';
          liveSteps = 0;
        }
        break;
      case 'text_delta':
        streamingText += e.text;
        break;
      case 'tool_call':
        liveSteps += 1;
        break;
      case 'tool_result':
        if (e.ok && PROJECT_LIST_TOOLS.includes(e.name)) projectsChanged = true;
        break;
      case 'confirm_required':
        pending = { callId: e.callId, summary: e.summary };
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

  async function watchJob(id: string) {
    const gen = viewGen;
    const startedAt = Date.now();
    while (mounted) {
      try {
        const job = await getJob(id, fetch, token);
        if (!mounted || gen !== viewGen) return;
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

  async function loadDetails(id: string) {
    const gen = viewGen;
    try {
      const job = await getJob(id, fetch, token);
      // A poll may have stored a newer copy while this one was in flight.
      const shown = jobs[id];
      if (gen === viewGen && !(shown && 'log' in shown)) jobs = { ...jobs, [id]: job };
    } catch (e) {
      if (gen === viewGen) error = e instanceof ApiError ? e.message : 'Could not load the job details.';
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
    if (busy || stopping) return;
    busy = true;
    accepted = false;
    error = '';
    const ac = new AbortController();
    controller = ac;
    try {
      const threadId = await ensureThread();
      streamThreadId = threadId;
      await run(threadId, (e) => handleEvent(threadId, e), ac.signal);
      if (!ac.signal.aborted) await reload();
    } catch (e) {
      if (ac.signal.aborted) return;
      error = e instanceof ApiError ? e.message : 'Something went wrong. Please try again.';
      onFail?.();
    } finally {
      if (controller === ac) {
        controller = null;
        busy = false;
        streamingText = '';
        liveSteps = 0;
      }
    }
  }

  async function reload() {
    if (projectsChanged) {
      projectsChanged = false;
      await invalidate('app:projects');
    }
    await invalidate('app:chat');
  }

  // A stopped turn goes on until it has recorded a call it had started (the
  // server allows it 30 s). A message sent before that lands would read the
  // call as interrupted, so Send waits until the stop is on record.
  const SETTLE_POLL_MS = 500;
  const SETTLE_FOR_MS = 30000;

  async function stop() {
    const me = {};
    stopper = me;
    stoppedText = streamingText;
    stopping = true;
    controller?.abort();
    const until = Date.now() + SETTLE_FOR_MS;
    try {
      for (;;) {
        await reload();
        if (!mounted || stopper !== me) return;
        if (!stillFinishing(data.messages, stoppedText, data.thread?.pendingCall != null) || Date.now() > until) break;
        await new Promise((r) => setTimeout(r, SETTLE_POLL_MS));
      }
      pending = data.thread?.pendingCall ?? null;
    } finally {
      if (stopper === me) {
        stopper = null;
        stopping = false;
        stoppedText = '';
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
    jobs = { ...jobs, [id]: { ...jobs[id], ...job } };
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
      {#if activity.length > 0}
        <h2 class="text-xs font-medium text-text-muted">Activity</h2>
        {#each activity as job (job.id)}
          <JobCard {job} oncancel={cancel} ondetails={loadDetails} showOrigin />
        {/each}
      {:else if messages.length === 0 && !streamingText}
        <div class="mx-auto max-w-lg py-10 text-center">
          <h2 class="text-base font-semibold text-text">Ask Ace anything about your outreach</h2>
          <p class="mt-2 text-base text-text-muted">
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
        {#if m.content.role === 'job'}
          {#if jobs[m.content.jobId]}
            <JobCard job={jobs[m.content.jobId]!} ondetails={loadDetails} />
          {:else}
            <p class="text-xs text-text-muted">{m.content.summary}</p>
          {/if}
        {:else}
          <MessageItem content={m.content} />
        {/if}
      {/each}
      {#if data.thread}
        {#each Object.values(jobs).filter((j) => !TERMINAL_JOB_STATUSES.includes(j.status)) as job (job.id)}
          <JobCard {job} oncancel={cancel} ondetails={loadDetails} />
        {/each}
      {/if}
      {#if streamingText || !answerSaved(messages, stoppedText)}
        <p class="max-w-[85%] whitespace-pre-wrap text-base text-text">{streamingText || stoppedText}</p>
      {/if}
      {#if busy}
        <p class="text-xs text-text-muted">
          {liveSteps === 0 ? 'Thinking…' : `Working… (${liveSteps} step${liveSteps === 1 ? '' : 's'})`}
        </p>
      {:else if stopping}
        <p class="text-xs text-text-muted">Stopping…</p>
      {/if}
      {#if pending}
        <ConfirmCard {pending} busy={busy || stopping} onrespond={respond} />
      {/if}
      {#if showIdentityCard}
        {#key proposal.callId}
          <SenderIdentityCard {proposal} {token} onsaved={identitySaved} />
        {/key}
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
              disabled={busy || stopping}
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
          disabled={busy || stopping}
          onkeydown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send(input);
            }
          }}
          class="min-w-0 flex-1 resize-none rounded border border-border bg-page px-3 py-2 text-base text-text focus:border-accent focus:outline-none disabled:opacity-60"
        ></textarea>
        {#if busy}
          <button
            type="button"
            onclick={stop}
            disabled={!accepted}
            aria-label="Stop"
            title="Stop"
            class="inline-flex h-10 min-w-[4.5rem] items-center justify-center self-end rounded bg-accent px-4 text-page hover:bg-accent-strong disabled:opacity-50"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" class="h-3.5 w-3.5">
              <rect x="2" y="2" width="12" height="12" rx="2" />
            </svg>
          </button>
        {:else}
          <button
            type="submit"
            disabled={stopping || !input.trim()}
            class="inline-flex h-10 min-w-[4.5rem] items-center justify-center self-end rounded bg-accent px-4 text-base font-medium text-page hover:bg-accent-strong disabled:opacity-50"
          >
            Send
          </button>
        {/if}
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
