<script lang="ts">
  import { Loader2, CheckCircle2, XCircle, Ban } from '@lucide/svelte';
  import { JOB_KIND_LABELS, JOB_ORIGIN_LABELS, JOB_STATUS_LABELS, type Job, type JobDetail } from '$lib/types/jobs';
  import JobLog from './JobLog.svelte';

  let {
    job,
    ondetails,
    oncancel,
    showOrigin = false,
  }: {
    job: Job | JobDetail;
    ondetails: (id: string) => void;
    oncancel?: (id: string) => void;
    showOrigin?: boolean;
  } = $props();
  let running = $derived(job.status === 'queued' || job.status === 'running');
  let log = $derived('log' in job ? job.log : null);
  let open = $state(false);

  function toggle() {
    open = !open;
    if (open && !log) ondetails(job.id);
  }
</script>

<div class="card my-2 px-4 py-3 text-sm">
  <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
    {#if running}
      <Loader2 size={16} class="animate-spin text-accent-strong" />
    {:else if job.status === 'succeeded'}
      <CheckCircle2 size={16} class="text-inbound" />
    {:else if job.status === 'cancelled'}
      <Ban size={16} class="text-text-muted" />
    {:else}
      <XCircle size={16} class="text-danger" />
    {/if}
    <span class="font-semibold text-text">{JOB_KIND_LABELS[job.kind]}</span>
    <span class="text-text-muted">{JOB_STATUS_LABELS[job.status]}</span>
    <span class="text-xs text-text-muted">
      · {new Date(job.createdAt).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
    </span>
    {#if showOrigin}
      <span class="text-xs text-text-muted">· {JOB_ORIGIN_LABELS[job.startedBy]}</span>
      {#if job.threadId}
        <a href="/chat?t={job.threadId}" class="text-xs text-text-muted underline hover:text-text">Open chat</a>
      {/if}
    {/if}
    {#if running && oncancel}
      <button type="button" class="ml-auto text-sm text-text-muted hover:text-danger" onclick={() => oncancel?.(job.id)}>Cancel</button>
    {/if}
  </div>
  {#if running && job.progress}
    <p class="mt-1 text-text-secondary">
      {job.progress.step}{job.progress.total !== null ? ` · ${job.progress.done}/${job.progress.total}` : ''}
    </p>
    {#if job.progress.total}
      <div class="mt-2 h-1 rounded-full bg-surface-2">
        <div
          class="h-1 rounded-full bg-accent transition-[width] duration-200 ease-spring"
          style="width: {Math.min(100, (job.progress.done / job.progress.total) * 100)}%"
        ></div>
      </div>
    {/if}
  {:else if job.status === 'succeeded' && job.result}
    <p class="mt-1 text-text-secondary">{job.result.summary}</p>
  {:else if job.status === 'failed' && job.error}
    <p class="mt-1 text-danger">{job.error}</p>
  {/if}
  {#if job.logEntries > 0}
    <button type="button" class="mt-2 text-xs font-semibold text-text-muted hover:text-text" onclick={toggle}>Details {open ? '▾' : '▸'}</button>
    {#if open}
      {#if log}
        <JobLog {log} />
      {:else}
        <p class="mt-1 text-text-muted">Loading…</p>
      {/if}
    {/if}
  {/if}
</div>
