<script lang="ts">
  import { goto, invalidate } from '$app/navigation';
  import { ApiError } from '$lib/api';
  import { confirmChatCall, createThread, deleteThread, sendChatMessage, stopChat, watchThread } from '$lib/api/chat';
  import { cancelJob, getJob } from '$lib/api/jobs';
  import ThreadList from '$lib/components/chat/ThreadList.svelte';
  import MessageItem from '$lib/components/chat/MessageItem.svelte';
  import JobCard from '$lib/components/chat/JobCard.svelte';
  import ConfirmCard from '$lib/components/chat/ConfirmCard.svelte';
  import SenderIdentityCard, { type SenderIdentityProposal } from '$lib/components/chat/SenderIdentityCard.svelte';
  import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
  import Logo from '$lib/components/Logo.svelte';
  import type { ChatEvent, ChatMessage, PendingCall } from '$lib/types/chat';
  import { TERMINAL_JOB_STATUSES, type Job, type JobDetail } from '$lib/types/jobs';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  let token = $derived(data.session?.access_token ?? '');
  let threadId = $derived(data.thread?.id ?? null);

  // The persisted transcript comes from the loader; the pieces below come from
  // the thread's live feed and are folded back in by the next invalidate.
  let liveMessages = $state<ChatMessage[]>([]);
  let streamingText = $state('');
  let liveSteps = $state(0);
  // The server's word, so every tab shows the same whoever set the turn off.
  let running = $state(false);
  let sending = $state(false);
  let stopping = $state(false);
  let pending = $state<PendingCall | null>(null);
  let jobs = $state<Record<string, Job | JobDetail>>({});
  let error = $state('');
  let input = $state('');
  let deleting = $state<string | null>(null);
  let bottom = $state<HTMLDivElement | null>(null);
  // A thread, or one project's home. A request started for an earlier view,
  // even one left and come back to, finds the generation moved on.
  let shownView: string | undefined;
  let viewGen = 0;

  $effect(() => {
    // Reset per-view state on a view switch only. Every invalidate hands
    // over a new `data`; the same view keeps its error and job cards.
    const view = threadId ?? `home:${data.activeProjectId}`;
    if (shownView === view) return;
    shownView = view;
    viewGen++;
    liveMessages = [];
    streamingText = '';
    liveSteps = 0;
    running = false;
    stopping = false;
    jobs = Object.fromEntries(data.jobs.map((j) => [j.id, j]));
    error = '';
    pending = data.thread?.pendingCall ?? null;
    for (const j of data.jobs) if (!TERMINAL_JOB_STATUSES.includes(j.status)) void watchJob(j.id);
  });

  $effect(() => {
    const id = threadId;
    if (!id) return;
    return watchThread(id, () => token, (e) => handleEvent(id, e), () => void catchUp(id));
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
  let liveThreadJobs = $derived(
    data.thread ? Object.values(jobs).filter((j) => !TERMINAL_JOB_STATUSES.includes(j.status)) : [],
  );
  let fresh = $derived(
    activity.length === 0 &&
      liveThreadJobs.length === 0 &&
      messages.length === 0 &&
      !streamingText &&
      !running &&
      !pending &&
      !showIdentityCard,
  );

  async function identitySaved() {
    await Promise.all([invalidate('app:chat'), invalidate('app:attention')]);
    void send('Sender identity saved.');
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

  function handleEvent(id: string, e: ChatEvent) {
    if (id !== threadId) return;
    switch (e.type) {
      case 'state':
        if (running && !e.running) void catchUp(id);
        // A turn runs past a card only once someone has answered it.
        if (e.running) pending = null;
        running = e.running;
        streamingText = e.text;
        liveSteps = 0;
        break;
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
    await goto(`/chat?t=${t.id}`, { replaceState: true, keepFocus: true, noScroll: true });
    return t.id;
  }

  async function reload() {
    if (projectsChanged) {
      projectsChanged = false;
      await invalidate('app:projects');
    }
    await invalidate('app:chat');
  }

  // What this tab may have missed: a turn that ended before the feed opened, a
  // message from another tab, an approval card someone answered.
  async function catchUp(id: string) {
    await reload();
    if (id === threadId) pending = data.thread?.pendingCall ?? null;
  }

  // A message sent while a turn runs is answered right after it.
  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || sending || stopping) return;
    input = '';
    pending = null;
    error = '';
    sending = true;
    let id = threadId;
    try {
      id = await ensureThread();
      const message = await sendChatMessage(id, trimmed, fetch, token);
      if (id === threadId) liveMessages = [...liveMessages, message];
    } catch (e) {
      if (id !== threadId) return;
      pending = data.thread?.pendingCall ?? null;
      error = e instanceof ApiError ? e.message : 'Something went wrong. Please try again.';
    } finally {
      sending = false;
    }
  }

  async function respond(approve: boolean) {
    const p = pending;
    const id = threadId;
    if (!p || !id) return;
    pending = null;
    error = '';
    try {
      await confirmChatCall(id, p.callId, approve, fetch, token);
    } catch (e) {
      if (id !== threadId) return;
      pending = p;
      error = e instanceof ApiError ? e.message : 'Something went wrong. Please try again.';
    }
  }

  // Resolves once the stopped turn has recorded what ran, so Send is never
  // ahead of it.
  async function stop() {
    const id = threadId;
    if (!id || stopping) return;
    stopping = true;
    try {
      await stopChat(id, fetch, token);
    } catch (e) {
      if (id === threadId) error = e instanceof ApiError ? e.message : 'Could not stop. Please try again.';
    } finally {
      if (id === threadId) stopping = false;
    }
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

{#snippet quickActionRow(centered: boolean)}
  <div class="flex flex-wrap gap-2 {centered ? 'justify-center' : ''}">
    {#each quickActions as a (a.label)}
      <button
        type="button"
        disabled={sending || stopping}
        onclick={() => send(a.text)}
        class="rounded-full bg-surface px-3 py-1.5 text-sm text-text-secondary transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-50"
      >
        {a.label}
      </button>
    {/each}
  </div>
{/snippet}

{#snippet composer(centered: boolean)}
  <form
    class="flex items-end gap-2 rounded-3xl border border-border bg-surface p-2 pl-4 transition-colors focus-within:border-accent {centered
      ? 'shadow-lg'
      : ''}"
    onsubmit={(e) => {
      e.preventDefault();
      void send(input);
    }}
  >
    <!-- svelte-ignore a11y_autofocus -->
    <textarea
      bind:value={input}
      rows={centered ? 1 : 2}
      autofocus={centered}
      aria-label="Message Ace"
      placeholder={data.activeProjectId ? 'Tell Ace what to do…' : 'https://your-company.com'}
      onkeydown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          void send(input);
        }
      }}
      class="max-h-40 min-w-0 flex-1 resize-none bg-transparent py-2 text-base text-text placeholder:text-text-muted focus:outline-none"
    ></textarea>
    {#if running}
      <button
        type="button"
        onclick={stop}
        disabled={stopping}
        aria-label="Stop"
        title="Stop"
        class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-2 text-text transition-colors hover:bg-border disabled:opacity-50"
      >
        <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" class="h-3.5 w-3.5">
          <rect x="2" y="2" width="12" height="12" rx="2" />
        </svg>
      </button>
    {:else}
      <button type="submit" disabled={sending || stopping || !input.trim()} class="btn btn-primary h-10">
        {data.activeProjectId ? 'Send' : 'Start'}
      </button>
    {/if}
  </form>
{/snippet}

<div class="flex h-[calc(100vh-7rem)] gap-6">
  <div class="hidden md:block">
    <ThreadList
      threads={data.threads}
      selectedId={data.thread?.id ?? null}
      onselect={(id) => goto(`/chat?t=${id}`, { keepFocus: true, noScroll: true })}
      onnew={() => goto('/chat', { keepFocus: true, noScroll: true })}
      ondelete={(id) => (deleting = id)}
    />
  </div>

  <section
    class="flex min-w-0 flex-1 flex-col {fresh ? 'items-center justify-center overflow-y-auto px-2 py-8' : ''}"
  >
    {#if fresh}
      <div class="text-center">
        <div class="animate-rise">
          <Logo size={44} class="mx-auto text-accent" />
        </div>
        <h1 class="mx-auto mt-5 max-w-xl animate-rise font-display text-3xl font-semibold tracking-tight text-balance text-text">
          {data.activeProjectId ? 'What should Ace do next?' : 'Paste your website to begin'}
        </h1>
        <p class="mx-auto mt-3 max-w-lg animate-rise text-base text-text-secondary">
          {#if data.activeProjectId}
            Find prospects, draft outreach, run the daily cycle, or ask how the numbers look.
          {:else}
            Ace reads your site, suggests who to contact and what to say, then waits for your OK. Nothing is sent
            until you approve it.
          {/if}
        </p>
      </div>
    {:else}
      <div class="min-h-0 w-full flex-1 overflow-y-auto pr-1">
        <div class="mx-auto max-w-3xl space-y-4 pb-2">
          {#if activity.length > 0}
            <h2 class="font-display text-lg font-semibold text-text">Activity</h2>
            {#each activity as job (job.id)}
              <JobCard {job} oncancel={cancel} ondetails={loadDetails} showOrigin />
            {/each}
          {/if}
          {#each messages as m (m.id)}
            <div class="animate-rise">
              {#if m.content.role === 'job'}
                {#if jobs[m.content.jobId]}
                  <JobCard job={jobs[m.content.jobId]!} ondetails={loadDetails} />
                {:else}
                  <p class="text-sm text-text-muted">{m.content.summary}</p>
                {/if}
              {:else}
                <MessageItem content={m.content} />
              {/if}
            </div>
          {/each}
          {#each liveThreadJobs as job (job.id)}
            <JobCard {job} oncancel={cancel} ondetails={loadDetails} />
          {/each}
          {#if streamingText}
            <p class="max-w-[85%] whitespace-pre-wrap text-base leading-relaxed text-text">{streamingText}</p>
          {/if}
          {#if stopping}
            <p class="text-sm text-text-muted">Stopping…</p>
          {:else if running}
            <p class="flex items-center gap-2 text-sm text-text-muted">
              <span class="flex gap-1" aria-hidden="true">
                {#each [0, 1, 2] as i (i)}
                  <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" style="animation-delay: {i * 150}ms"></span>
                {/each}
              </span>
              {liveSteps === 0 ? 'Thinking…' : `Working… (${liveSteps} step${liveSteps === 1 ? '' : 's'})`}
            </p>
          {/if}
          {#if pending}
            <ConfirmCard {pending} busy={running || stopping} onrespond={respond} />
          {/if}
          {#if showIdentityCard}
            {#key proposal.callId}
              <SenderIdentityCard {proposal} {token} onsaved={identitySaved} />
            {/key}
          {/if}
          {#if error}
            <p class="text-sm text-danger">{error}</p>
          {/if}
          <div bind:this={bottom}></div>
        </div>
      </div>
    {/if}

    <!-- One composer for both layouts, so sending the first message keeps focus in it. -->
    <div class="mx-auto w-full {fresh ? 'mt-8 max-w-2xl animate-rise' : 'max-w-3xl space-y-2 pt-3'}">
      {#if !fresh && data.activeProjectId}
        {@render quickActionRow(false)}
      {/if}
      {@render composer(fresh)}
    </div>

    {#if fresh}
      <div class="mt-5 w-full max-w-2xl animate-rise">
        {#if data.activeProjectId}
          {@render quickActionRow(true)}
        {:else}
          <ol class="flex flex-wrap justify-center gap-2" aria-label="What happens next">
            {#each ['Reads your site', 'Suggests who to contact', 'Finds companies that fit', 'Drafts emails for your OK'] as step, i (step)}
              <li
                class="rounded-full px-3 py-1.5 text-sm {i === 0
                  ? 'bg-accent/10 font-semibold text-accent-strong'
                  : 'bg-surface text-text-secondary'}"
              >
                {step}
              </li>
            {/each}
          </ol>
        {/if}
      </div>
      {#if error}
        <p class="mt-4 text-sm text-danger">{error}</p>
      {/if}
    {/if}
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
