<script lang="ts">
  import { Loader2, CheckCircle2, XCircle, Ban } from '@lucide/svelte';
  import { JOB_KIND_LABELS, type Job } from '$lib/types/jobs';

  let { job, oncancel }: { job: Job; oncancel?: (id: string) => void } = $props();
  let running = $derived(job.status === 'queued' || job.status === 'running');
</script>

<div class="my-2 rounded border border-border bg-surface px-3 py-2 text-xs">
  <div class="flex items-center gap-2">
    {#if running}
      <Loader2 size={14} class="animate-spin text-accent" />
    {:else if job.status === 'succeeded'}
      <CheckCircle2 size={14} class="text-success" />
    {:else if job.status === 'cancelled'}
      <Ban size={14} class="text-text-muted" />
    {:else}
      <XCircle size={14} class="text-danger" />
    {/if}
    <span class="font-medium text-text">{JOB_KIND_LABELS[job.kind]}</span>
    <span class="text-text-muted">{job.status}</span>
    {#if running && oncancel}
      <button type="button" class="ml-auto text-text-muted hover:text-danger" onclick={() => oncancel?.(job.id)}>Cancel</button>
    {/if}
  </div>
  {#if running && job.progress}
    <p class="mt-1 text-text-secondary">
      {job.progress.step}{job.progress.total !== null ? ` · ${job.progress.done}/${job.progress.total}` : ''}
    </p>
  {:else if job.status === 'succeeded' && job.result}
    <p class="mt-1 text-text-secondary">{job.result.summary}</p>
  {:else if job.status === 'failed' && job.error}
    <p class="mt-1 text-danger">{job.error}</p>
  {/if}
</div>
