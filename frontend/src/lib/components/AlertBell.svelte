<script lang="ts">
  import { Bell } from '@lucide/svelte';
  import { goto } from '$app/navigation';
  import { setActiveProject } from '$lib/active-project';
  import { attentionMeta } from '$lib/attention-meta';
  import type { AttentionItem } from '$lib/types/attention';

  let { items }: { items: AttentionItem[] } = $props();

  let open = $state(false);
  let buttonEl: HTMLButtonElement | null = $state(null);
  let menuEl: HTMLDivElement | null = $state(null);

  function close() {
    open = false;
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
    onclick={() => (open = !open)}
    aria-haspopup="menu"
    aria-expanded={open}
    aria-label={items.length > 0 ? `Alerts (${items.length})` : 'Alerts'}
    class="relative flex h-9 w-9 items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-surface-2 hover:text-text"
  >
    <Bell size={18} />
    {#if items.length > 0}
      <span
        class="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1 text-xs font-semibold tabular-nums text-on-accent"
      >
        {items.length}
      </span>
    {/if}
  </button>

  {#if open}
    <div
      bind:this={menuEl}
      role="menu"
      class="absolute right-0 top-11 z-40 w-80 overflow-hidden rounded-2xl border border-border bg-surface shadow-lg"
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
    </div>
  {/if}
</div>
