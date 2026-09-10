<script lang="ts">
  import { JOB_KIND_LABELS, PROSPECT_OUTCOME_LABELS, type JobLogLine } from '$lib/types/jobs';

  let { log }: { log: JobLogLine[] } = $props();
</script>

<ol class="mt-1 space-y-0.5 border-l border-border pl-2">
  {#each log as l}
    <li class="flex gap-2">
      <span class="shrink-0 tabular-nums text-text-muted">
        {new Date(l.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
      </span>
      {#if l.kind === 'stage'}
        <span class="text-text"><span class="font-medium">{JOB_KIND_LABELS[l.stage]}</span> — {l.summary}</span>
      {:else if l.kind === 'decision'}
        <span class="text-text-secondary">→ {l.text}</span>
      {:else}
        <span class="text-text-secondary">
          {l.name} —
          <span
            class={l.outcome === 'failed'
              ? 'text-danger'
              : l.outcome === 'sent' || l.outcome === 'drafted'
                ? 'text-success'
                : 'text-text-muted'}>{PROSPECT_OUTCOME_LABELS[l.outcome]}</span
          >{#if 'subject' in l}: “{l.subject}”{:else if 'reason' in l}: {l.reason}{/if}
        </span>
      {/if}
    </li>
  {/each}
</ol>
