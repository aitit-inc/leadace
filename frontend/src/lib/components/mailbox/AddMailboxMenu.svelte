<script lang="ts">
  import { ChevronDown } from '@lucide/svelte';

  let {
    freeBlocked,
    hasGoogle,
    connecting,
    onGoogle,
    onAlias,
    onSmtp,
  }: {
    freeBlocked: boolean;
    // A Send-As alias needs a connected Google account to send through.
    hasGoogle: boolean;
    connecting: boolean;
    onGoogle: () => void;
    onAlias: () => void;
    onSmtp: () => void;
  } = $props();

  let open = $state(false);
  let root: HTMLDivElement | undefined = $state();

  function onWindowClick(e: MouseEvent) {
    if (root && !root.contains(e.target as Node)) open = false;
  }

  function pick(action: () => void) {
    open = false;
    action();
  }

  const items = $derived([
    {
      label: 'Connect a Google account',
      desc: 'Any Gmail or Google Workspace mailbox, via Google sign-in',
      blocked: freeBlocked ? 'Paid plan required' : null,
      action: onGoogle,
    },
    {
      label: 'Add a Send-As alias',
      desc: 'An address a connected Google account already sends as',
      blocked: freeBlocked ? 'Paid plan required' : hasGoogle ? null : 'Connect a Google account first',
      action: onAlias,
    },
    {
      label: 'Add an SMTP mailbox',
      desc: 'Any other provider, with an app password',
      blocked: freeBlocked ? 'Paid plan required' : null,
      action: onSmtp,
    },
  ]);
</script>

<svelte:window onclick={open ? onWindowClick : undefined} onkeydown={(e) => e.key === 'Escape' && (open = false)} />

<div class="relative" bind:this={root}>
  <button
    type="button"
    aria-expanded={open}
    disabled={connecting}
    onclick={() => (open = !open)}
    class="inline-flex items-center gap-1 rounded bg-accent px-3 py-1.5 text-xs font-medium text-page transition-colors hover:bg-accent-strong disabled:opacity-50"
  >
    {connecting ? 'Connecting…' : 'Add mailbox'}
    <ChevronDown size={14} />
  </button>
  {#if open}
    <div
      class="absolute right-0 top-full z-20 mt-1.5 w-72 rounded-md border border-border bg-page p-1 shadow-lg"
    >
      {#each items as item (item.label)}
        <button
          type="button"
          disabled={item.blocked !== null}
          onclick={() => pick(item.action)}
          class="flex w-full flex-col items-start rounded px-2.5 py-2 text-left hover:bg-surface disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span class="text-sm text-text">{item.label}</span>
          <span class="text-[11px] {item.blocked ? 'text-warning' : 'text-text-muted'}">
            {item.blocked ?? item.desc}
          </span>
        </button>
      {/each}
    </div>
  {/if}
</div>
