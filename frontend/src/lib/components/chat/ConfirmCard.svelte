<script lang="ts">
  import { ShieldAlert } from '@lucide/svelte';
  import type { PendingCall } from '$lib/types/chat';

  let {
    pending,
    busy,
    onrespond,
  }: { pending: PendingCall; busy: boolean; onrespond: (approve: boolean) => void } = $props();

  // The server marks an action that cannot be undone by writing a warning.
  let danger = $derived(pending.summary.warning !== undefined);
</script>

<div
  class="my-2 max-w-[85%] rounded border px-3 py-2.5 text-sm {danger
    ? 'border-danger/50 bg-danger/5'
    : 'border-accent/50 bg-accent/10'}"
>
  <div class="flex items-center gap-2 text-text">
    <ShieldAlert size={15} class={danger ? 'text-danger' : 'text-accent'} />
    <span class="font-semibold">{pending.summary.title}</span>
  </div>

  <dl class="mt-2 space-y-1">
    {#each pending.summary.facts as fact (fact.label)}
      <div class="flex gap-3">
        <dt class="w-28 shrink-0 text-text-muted">{fact.label}</dt>
        <dd class="min-w-0 flex-1 text-text-secondary">{fact.value}</dd>
      </div>
    {/each}
  </dl>

  {#if pending.summary.body}
    <p class="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded border border-border bg-page p-2 text-text-secondary">
      {pending.summary.body}
    </p>
  {/if}

  {#if pending.summary.warning}
    <p class="mt-2 text-danger">{pending.summary.warning}</p>
  {/if}

  <div class="mt-3 flex items-center gap-3">
    <button
      type="button"
      disabled={busy}
      onclick={() => onrespond(true)}
      class="rounded px-3 py-1.5 font-medium text-page hover:bg-accent-strong disabled:opacity-50 {danger
        ? 'bg-danger'
        : 'bg-accent'}"
    >
      {pending.summary.confirmLabel}
    </button>
    <button
      type="button"
      disabled={busy}
      onclick={() => onrespond(false)}
      class="text-text-muted hover:text-text disabled:opacity-50"
    >
      Cancel
    </button>
  </div>
</div>
