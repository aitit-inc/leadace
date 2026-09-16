<script lang="ts">
  import { ShieldAlert, ShieldCheck, TriangleAlert } from '@lucide/svelte';
  import type { PendingCall } from '$lib/types/chat';

  let {
    pending,
    busy,
    onrespond,
  }: { pending: PendingCall; busy: boolean; onrespond: (approve: boolean) => void } = $props();

  // The server marks an action that cannot be undone by writing a warning.
  let danger = $derived(pending.summary.warning !== undefined);
</script>

<div class="card my-3 max-w-2xl p-5 ring-1 {danger ? 'ring-danger/40' : 'ring-accent/50'}">
  <div class="flex items-start gap-3">
    <span
      class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full {danger
        ? 'bg-danger/12 text-danger'
        : 'bg-accent/15 text-accent-strong'}"
    >
      {#if danger}
        <ShieldAlert size={18} />
      {:else}
        <ShieldCheck size={18} />
      {/if}
    </span>
    <div class="min-w-0">
      <p class="text-xs font-semibold text-text-muted">Needs your OK</p>
      <h3 class="font-display text-lg font-semibold leading-snug text-text">{pending.summary.title}</h3>
    </div>
  </div>

  <dl class="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
    {#each pending.summary.facts as fact (fact.label)}
      <dt class="text-text-muted">{fact.label}</dt>
      <dd class="break-words text-text">{fact.value}</dd>
    {/each}
  </dl>

  {#if pending.summary.body}
    <div class="mt-4 max-h-64 overflow-auto whitespace-pre-wrap rounded-xl bg-page p-4 text-sm leading-relaxed text-text-secondary">
      {pending.summary.body}
    </div>
  {/if}

  {#if pending.summary.warning}
    <p class="mt-3 flex gap-2 text-sm text-danger">
      <TriangleAlert size={16} class="mt-0.5 shrink-0" />
      {pending.summary.warning}
    </p>
  {/if}

  <div class="mt-5 flex items-center gap-2">
    <button
      type="button"
      disabled={busy}
      onclick={() => onrespond(true)}
      class="btn {danger ? 'btn-danger' : 'btn-primary'}"
    >
      {pending.summary.confirmLabel}
    </button>
    <button type="button" disabled={busy} onclick={() => onrespond(false)} class="btn btn-ghost">
      Cancel
    </button>
  </div>
</div>
