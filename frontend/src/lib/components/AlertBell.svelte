<script lang="ts">
  import { Bell } from '@lucide/svelte';
  import { goto, invalidate } from '$app/navigation';
  import { setActiveProject } from '$lib/active-project';
  import { attentionMeta } from '$lib/attention-meta';
  import { markNotificationsSeen } from '$lib/api/notifications';
  import type { AttentionItem } from '$lib/types/attention';
  import type { NotificationItem } from '$lib/types/notifications';

  let { items, notifications, token }: { items: AttentionItem[]; notifications: NotificationItem[]; token: string | undefined } = $props();

  let unread = $derived(notifications.filter((n) => n.unread).length);
  // Still marked while the panel that revealed them stays open.
  let fresh = $state(new Set<number>());

  let open = $state(false);
  let buttonEl: HTMLButtonElement | null = $state(null);
  let menuEl: HTMLDivElement | null = $state(null);

  function close() {
    open = false;
  }

  function toggle() {
    open = !open;
    if (!open || unread === 0) return;
    fresh = new Set(notifications.filter((n) => n.unread).map((n) => n.id));
    markNotificationsSeen(fetch, token)
      .then(() => invalidate('app:notifications'))
      .catch(() => {});
  }

  // The dashboard renders the cookie's active project, so the futility CTA
  // must switch to the named project first or it lands on the wrong one.
  // Modified clicks (new tab/window) keep native link behavior.
  async function followCta(e: MouseEvent, item: AttentionItem, href: string) {
    close();
    if (
      item.kind === 'outreach_futility' &&
      !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey
    ) {
      e.preventDefault();
      await setActiveProject(item.projectId);
      await goto(href);
    }
  }

  const TONE_TEXT: Record<ReturnType<typeof attentionMeta>['tone'], string> = {
    accent: 'text-accent-strong',
    inbound: 'text-inbound',
    danger: 'text-danger',
    warning: 'text-warning',
  };

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
    onclick={toggle}
    aria-haspopup="menu"
    aria-expanded={open}
    aria-label={items.length + unread > 0 ? `Alerts (${items.length + unread})` : 'Alerts'}
    class="relative flex h-9 w-9 items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-surface-2 hover:text-text"
  >
    <Bell size={18} />
    {#if items.length + unread > 0}
      <span
        class="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1 text-xs font-semibold tabular-nums text-on-accent"
      >
        {items.length + unread}
      </span>
    {/if}
  </button>

  {#if open}
    <div
      bind:this={menuEl}
      role="menu"
      class="absolute right-0 top-11 z-40 max-h-[75vh] w-80 overflow-y-auto rounded-2xl border border-border bg-surface shadow-lg"
    >
      {#if items.length === 0}
        <p class="px-4 py-4 text-sm text-text-muted">Nothing needs you right now.</p>
      {:else}
        <ul class="divide-y divide-border">
          {#each items as item}
            {@const meta = attentionMeta(item)}
            <li class="px-4 py-3">
              <div class="flex items-start gap-2.5">
                <meta.icon size={16} class="mt-0.5 shrink-0 {TONE_TEXT[meta.tone]}" />
                <div class="min-w-0">
                  <p class="text-sm font-semibold text-text">{meta.title}</p>
                  <p class="mt-0.5 text-xs text-text-secondary">{meta.desc}</p>
                  <a
                    href={meta.href}
                    onclick={(e) => followCta(e, item, meta.href)}
                    role="menuitem"
                    class="mt-1.5 inline-block text-sm font-semibold text-accent-strong hover:underline"
                  >
                    {meta.ctaLabel} →
                  </a>
                </div>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
      {#if notifications.length > 0}
        <p class="border-t border-border px-4 pb-1 pt-3 text-xs font-semibold text-text-muted">Notifications</p>
        <ul class="divide-y divide-border">
          {#each notifications as n (n.id)}
            <li>
              <a href={n.link} onclick={close} role="menuitem" class="block px-4 py-3 hover:bg-surface-2">
                <p class="flex items-center gap-1.5 text-sm font-semibold text-text">
                  {#if fresh.has(n.id)}<span class="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-label="New"></span>{/if}
                  <span class="min-w-0 truncate">{n.subject}</span>
                </p>
                <p class="mt-0.5 whitespace-pre-line text-xs text-text-secondary">{n.body}</p>
                <p class="mt-0.5 text-xs text-text-muted">
                  {new Date(n.createdAt).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </p>
              </a>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>
