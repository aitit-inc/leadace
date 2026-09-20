<script lang="ts">
  import { untrack } from 'svelte';
  import { goto, invalidate } from '$app/navigation';
  import { page } from '$app/state';
  import { ArrowUp } from '@lucide/svelte';
  import { ApiError } from '$lib/api';
  import { ACCEPTED_FILE_TYPES, MAX_ATTACHMENT_BYTES, canAttach } from '$lib/chat-attachments';
  import {
    confirmChatCall,
    createThread,
    deleteThread,
    downloadChatAttachment,
    sendChatMessage,
    stopChat,
    uploadChatAttachment,
    watchThread,
  } from '$lib/api/chat';
  import { cancelJob, getJob } from '$lib/api/jobs';
  import ThreadList from '$lib/components/chat/ThreadList.svelte';
  import AttachmentChip from '$lib/components/chat/AttachmentChip.svelte';
  import MessageItem from '$lib/components/chat/MessageItem.svelte';
  import MicButton from '$lib/components/chat/MicButton.svelte';
  import JobCard from '$lib/components/chat/JobCard.svelte';
  import ConfirmCard from '$lib/components/chat/ConfirmCard.svelte';
  import SenderIdentityCard, { type SenderIdentityProposal } from '$lib/components/chat/SenderIdentityCard.svelte';
  import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
  import Logo from '$lib/components/Logo.svelte';
  import type { ChatAttachment, ChatEvent, ChatMessage, PendingCall } from '$lib/types/chat';
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
  // Already uploaded to this thread, waiting to ride the next message.
  let attachments = $state<ChatAttachment[]>([]);
  let uploading = $state<{ key: number; name: string }[]>([]);
  // Files from a pick whose thread is still being created. They cannot be
  // listed as uploading before it exists, and Send waits for them all the same.
  let attaching = $state(0);
  let dictating = $state(false);
  let dropping = $state(false);
  // dragover keeps firing while a drag is over the page; counting enters and
  // leaves instead would stick whenever the element under the pointer goes.
  let dropTimer: ReturnType<typeof setTimeout> | undefined;
  let uploadKey = 0;
  let filePicker = $state<HTMLInputElement | null>(null);
  let deleting = $state<string | null>(null);
  let bottom = $state<HTMLDivElement | null>(null);
  // A thread, or one project's home. A request started for an earlier view,
  // even one left and come back to, finds the generation moved on.
  let shownView: string | undefined;
  let viewGen = 0;
  // The opening message this view already sent, so an invalidate doesn't repeat it.
  let askSent: string | undefined;

  $effect(() => {
    // Reset per-view state on a view switch only. Every invalidate hands
    // over a new `data`; the same view keeps its error and job cards.
    const view = threadId ?? `home:${data.activeProjectId}`;
    if (shownView === view) return;
    shownView = view;
    viewGen++;
    askSent = undefined;
    liveMessages = [];
    streamingText = '';
    liveSteps = 0;
    attachments = [];
    uploading = [];
    running = false;
    stopping = false;
    jobs = Object.fromEntries(data.jobs.map((j) => [j.id, j]));
    error = '';
    pending = data.thread?.pendingCall ?? null;
    for (const j of data.jobs) if (!TERMINAL_JOB_STATUSES.includes(j.status)) void watchJob(j.id);
  });

  $effect(() => {
    // Only an in-app navigation carries it, so no link can start a turn.
    const ask = data.thread ? undefined : page.state.ask;
    if (!ask || ask === askSent) return;
    askSent = ask;
    // untrack: the handover depends on the state alone, not on what send() reads.
    untrack(() => void send(ask));
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
  // No project yet, or one whose first setup has not been written.
  let needsSetup = $derived(!data.projects.find((p) => p.id === (data.thread?.projectId ?? data.activeProjectId))?.setUp);
  // Asked for once the setup is written, so it never hides the website prompt.
  let showIdentityCard = $derived(data.attention.some((a) => a.kind === 'compliance_incomplete') && !needsSetup);
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
  // fresh tenant has none of, or a project's setup state) must be reloaded.
  const PROJECT_LIST_TOOLS = ['setup_project', 'delete_project', 'apply_strategy_draft'];
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

  // One thread however many callers race for it: `data.thread` only catches up
  // once the creation has navigated, so attaching a file and pressing Enter
  // behind it would otherwise make a thread each.
  let creating: Promise<string> | undefined;

  async function ensureThread(): Promise<string> {
    if (data.thread) return data.thread.id;
    creating ??= createThread(data.activeProjectId ? { projectId: data.activeProjectId } : {}, fetch, token)
      .then(async (t) => {
        await goto(`/chat?t=${t.id}`, { replaceState: true, keepFocus: true, noScroll: true });
        return t.id;
      })
      .finally(() => (creating = undefined));
    return creating;
  }

  // Tool events are not replayed after a reconnect, so a project still being
  // set up rereads its state rather than trusting the apply_strategy_draft one.
  async function reload() {
    if (projectsChanged || needsSetup) {
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

  const MAX_ATTACHMENTS = 5;

  // Uploaded as they are picked, so the model has them the moment the message
  // is sent. They belong to the thread, which is created first if there is none.
  async function attach(picked: FileList | null) {
    if (!picked || picked.length === 0) return;
    const files = [...picked];
    error = '';
    if (attachments.length + uploading.length + attaching + files.length > MAX_ATTACHMENTS) {
      error = `Up to ${MAX_ATTACHMENTS} files per message.`;
      return;
    }
    const tooBig = files.find((f) => f.size > MAX_ATTACHMENT_BYTES);
    if (tooBig) {
      error = `${tooBig.name} is larger than ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB.`;
      return;
    }
    const unreadable = files.find((f) => !canAttach(f.name));
    if (unreadable) {
      error = `Ace cannot read ${unreadable.name}.`;
      return;
    }
    const pickedIn = viewGen;
    attaching += files.length;
    let id: string;
    try {
      id = await ensureThread();
    } catch {
      if (pickedIn === viewGen) error = 'The chat could not be started. Please try again.';
      return;
    } finally {
      attaching -= files.length;
    }
    const gen = viewGen;
    // The whole pick is shown as pending before the first byte goes up, so a
    // second pick counts against the limit and Send waits for all of them.
    const queued = files.map((file) => ({ key: uploadKey++, file }));
    uploading = [...uploading, ...queued.map(({ key, file }) => ({ key, name: file.name }))];
    const failed: string[] = [];
    for (const { key, file } of queued) {
      // The view moved on: its own state was reset, and these belong to it.
      if (gen !== viewGen) return;
      try {
        const uploaded = await uploadChatAttachment(id, file, fetch, token);
        if (gen === viewGen) attachments = [...attachments, uploaded];
      } catch (e) {
        failed.push(e instanceof ApiError ? e.message : `${file.name} could not be attached.`);
      } finally {
        if (gen === viewGen) uploading = uploading.filter((u) => u.key !== key);
      }
    }
    // One message for the pick: several files usually fail for the one reason.
    if (gen === viewGen && failed.length > 0) error = [...new Set(failed)].join(' ');
  }

  function draggingFiles(e: DragEvent) {
    return e.dataTransfer?.types.includes('Files') ?? false;
  }

  function dragFilesOver(e: DragEvent) {
    if (!draggingFiles(e)) return;
    e.preventDefault();
    dropping = true;
    clearTimeout(dropTimer);
    dropTimer = setTimeout(() => (dropping = false), 400);
  }

  function dropFiles(e: DragEvent) {
    if (!draggingFiles(e)) return;
    e.preventDefault();
    clearTimeout(dropTimer);
    dropping = false;
    void attach(e.dataTransfer?.files ?? null);
  }

  async function openFile(file: ChatAttachment) {
    const id = threadId;
    if (!id) return;
    try {
      await downloadChatAttachment(id, file, token);
    } catch (e) {
      if (id === threadId) error = e instanceof ApiError ? e.message : 'The file could not be opened.';
    }
  }

  function dictated(said: string) {
    // Whatever was typed is left as it is, newlines included.
    input = !input || /\s$/.test(input) ? input + said : `${input} ${said}`;
  }

  // A message sent while a turn runs is answered right after it.
  async function send(text: string) {
    const trimmed = text.trim();
    if ((!trimmed && attachments.length === 0) || sending || stopping || uploading.length + attaching > 0) return;
    const attachmentIds = attachments.map((a) => a.id);
    input = '';
    attachments = [];
    dictating = false;
    pending = null;
    error = '';
    sending = true;
    let id = threadId;
    try {
      id = await ensureThread();
      const message = await sendChatMessage(id, trimmed, attachmentIds, fetch, token);
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

<!-- A file dropped beside the chat would otherwise open in the tab, taking the
     draft with it. Text and links dragged into the box are left alone. -->
<svelte:window
  ondragover={(e) => draggingFiles(e) && e.preventDefault()}
  ondrop={(e) => draggingFiles(e) && e.preventDefault()}
/>

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
    class="flex flex-col gap-1.5 rounded-3xl border bg-surface p-2 transition-colors focus-within:border-accent {dropping
      ? 'border-dashed border-accent'
      : 'border-border'} {centered ? 'shadow-lg' : ''}"
    onsubmit={(e) => {
      e.preventDefault();
      void send(input);
    }}
  >
    {#if dropping}
      <p class="px-2 pt-1 text-sm font-semibold text-accent-strong">Drop files here to attach them</p>
    {/if}
    {#if attachments.length > 0 || uploading.length > 0}
      <div class="flex flex-wrap gap-1.5 px-1 pt-1">
        {#each attachments as a (a.id)}
          <AttachmentChip name={a.name} size={a.size} onremove={() => (attachments = attachments.filter((x) => x.id !== a.id))} />
        {/each}
        {#each uploading as u (u.key)}
          <AttachmentChip name={u.name} size={0} busy />
        {/each}
      </div>
    {/if}
    <div class="flex items-end gap-2">
      <input
        bind:this={filePicker}
        type="file"
        multiple
        accept={ACCEPTED_FILE_TYPES}
        class="hidden"
        onchange={(e) => {
          void attach(e.currentTarget.files);
          e.currentTarget.value = '';
        }}
      />
      <button
        type="button"
        onclick={() => filePicker?.click()}
        disabled={sending || stopping}
        aria-label="Attach files"
        title="Attach files (sales deck, pricing, customer results…)"
        class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-50"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true" class="h-5 w-5">
          <path d="M21 11.5 12.5 20a5 5 0 0 1-7-7l8-8a3.5 3.5 0 0 1 5 5l-8 8a2 2 0 0 1-3-3l7.5-7.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <!-- svelte-ignore a11y_autofocus -->
      <textarea
        bind:value={input}
        rows={centered ? 1 : 2}
        autofocus={centered}
        aria-label="Message Ace"
        placeholder={needsSetup ? 'https://your-company.com' : 'Tell Ace what to do…'}
        onkeydown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void send(input);
          }
        }}
        class="max-h-40 min-w-0 flex-1 resize-none bg-transparent py-2 text-base text-text placeholder:text-text-muted focus:outline-none"
      ></textarea>
      <MicButton bind:listening={dictating} ontranscript={dictated} onerror={(m) => (error = m)} />
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
        <button
          type="submit"
          disabled={sending || stopping || uploading.length + attaching > 0 || (!input.trim() && attachments.length === 0)}
          aria-label={needsSetup ? 'Start' : 'Send'}
          title={needsSetup ? 'Start' : 'Send'}
          class="btn btn-primary h-10 w-10 shrink-0 p-0"
        >
          <ArrowUp size={18} />
        </button>
      {/if}
    </div>
  </form>
{/snippet}

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="flex h-[calc(100vh-7rem)] gap-6"
  ondragover={dragFilesOver}
  ondrop={dropFiles}
>
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
          {needsSetup ? 'Paste your website to begin' : 'What should Ace do next?'}
        </h1>
        <p class="mx-auto mt-3 max-w-lg animate-rise text-base text-text-secondary">
          {#if needsSetup}
            Ace reads your site, suggests who to contact and what to say, then waits for your OK. Nothing is sent
            until you approve it.
          {:else}
            Find prospects, draft outreach, run the daily cycle, or ask how the numbers look.
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
                <MessageItem content={m.content} onopenfile={openFile} />
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
      {#if !fresh && !needsSetup}
        {@render quickActionRow(false)}
      {/if}
      {@render composer(fresh)}
    </div>

    {#if fresh}
      <div class="mt-5 w-full max-w-2xl animate-rise">
        {#if needsSetup}
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
        {:else}
          {@render quickActionRow(true)}
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
