<script lang="ts">
  import { Bell, TriangleAlert } from '@lucide/svelte';
  import type { Alert } from '$lib/types/alerts';

  let { alerts }: { alerts: Alert[] } = $props();

  let open = $state(false);
  let buttonEl: HTMLButtonElement | null = $state(null);
  let menuEl: HTMLDivElement | null = $state(null);

  function close() {
    open = false;
  }

  function describe(alert: Alert): { title: string; detail: string } {
    switch (alert.kind) {
      case 'reply_collection_revoked':
        return {
          title: 'Reply collection stopped',
          detail: `Google rejected the saved access for ${alert.fromEmail} on ${new Date(
            alert.since,
          ).toLocaleDateString()}. Replies to this address have not been read since.`,
        };
      case 'reply_collection_scope_missing':
        return {
          title: 'Replies are not being read',
          detail: `${alert.fromEmail} can send, but permission to read replies was never granted, so replies and bounces to it go unrecorded.`,
        };
    }
  }

  $effect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node;
      if (buttonEl?.contains(target) || menuEl?.contains(target)) return;
      close();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  });
</script>

<div class="relative">
  <button
    bind:this={buttonEl}
    type="button"
    onclick={() => (open = !open)}
    aria-haspopup="menu"
    aria-expanded={open}
    aria-label={alerts.length > 0 ? `Alerts (${alerts.length})` : 'Alerts'}
    class="relative flex h-9 w-9 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-surface hover:text-text focus:outline-none focus:ring-2 focus:ring-text/30"
  >
    <Bell size={18} />
    {#if alerts.length > 0}
      <span
        class="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-medium text-page"
      >
        {alerts.length}
      </span>
    {/if}
  </button>

  {#if open}
    <div
      bind:this={menuEl}
      role="menu"
      class="absolute right-0 top-11 z-40 w-80 rounded-md border border-border bg-page shadow-lg"
    >
      {#if alerts.length === 0}
        <p class="px-3 py-4 text-sm text-text-muted">No alerts.</p>
      {:else}
        <ul class="divide-y divide-border">
          {#each alerts as alert}
            {@const described = describe(alert)}
            <li class="px-3 py-3">
              <div class="flex items-start gap-2">
                <TriangleAlert size={14} class="mt-0.5 shrink-0 text-danger" />
                <div class="min-w-0">
                  <p class="text-sm font-medium text-text">{described.title}</p>
                  <p class="mt-0.5 text-xs text-text-muted">{described.detail}</p>
                  <a
                    href="/account-settings"
                    onclick={close}
                    role="menuitem"
                    class="mt-1.5 inline-block text-xs font-medium text-accent hover:text-accent-strong transition-colors"
                  >
                    Fix in Account settings →
                  </a>
                </div>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>
