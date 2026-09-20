<script lang="ts">
  import { Copy, Check, MessagesSquare, MoreHorizontal } from '@lucide/svelte';
  import { dismissSuggestion } from '$lib/api/suggestions';
  import type { Suggestion } from '$lib/types/suggestions';

  let {
    suggestions,
    projectName,
    token,
    onAsk,
    onChanged,
  }: {
    suggestions: Suggestion[];
    projectName: string | null;
    token: string | undefined;
    onAsk: (instruction: string) => void;
    onChanged: () => void | Promise<void>;
  } = $props();

  let menuId = $state<number | null>(null);
  let menuTrigger: HTMLButtonElement | null = null;
  let copiedId = $state<number | null>(null);
  let dismissingId = $state<number | null>(null);
  let dismissError = $state('');

  function claudeCodeCommand(s: Suggestion) {
    return projectName ? `/leadace ${projectName} ${s.instruction}` : `/leadace ${s.instruction}`;
  }

  async function copyCommand(s: Suggestion) {
    try {
      await navigator.clipboard.writeText(claudeCodeCommand(s));
      copiedId = s.id;
      setTimeout(() => {
        if (copiedId === s.id) copiedId = null;
      }, 1500);
    } catch {
      // Clipboard unavailable (insecure context / denied) — nothing actionable to show.
    }
  }

  async function dismiss(s: Suggestion) {
    dismissingId = s.id;
    dismissError = '';
    try {
      await dismissSuggestion(s.id, fetch, token);
      await onChanged();
    } catch (e) {
      dismissError = e instanceof Error ? e.message : 'Failed to dismiss the suggestion.';
    } finally {
      dismissingId = null;
    }
  }

  $effect(() => {
    if (menuId === null) return;
    function onDocClick(e: MouseEvent) {
      const target = e.target;
      if (!(target instanceof Element) || !target.closest('[data-suggestion-menu]')) menuId = null;
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      menuId = null;
      // Escape can close a menu the focus is inside, which would strand it.
      menuTrigger?.focus();
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  });
</script>

<!-- No overflow-hidden: the per-suggestion menu opens past the card's edge. -->
<section class="card">
  <div class="flex items-center gap-2 px-5 pb-2 pt-4">
    <h2 class="font-display text-lg font-semibold text-text">Suggestions</h2>
    <span class="chip bg-surface-2 tabular-nums text-text-secondary">{suggestions.length}</span>
    <span class="ml-auto hidden text-sm text-text-muted sm:inline">Next steps the AI recommends</span>
  </div>
  {#if dismissError}
    <p class="px-5 py-2 text-sm text-danger">{dismissError}</p>
  {/if}
  <div class="divide-y divide-border">
    {#each suggestions as s (s.id)}
      <div class="px-5 py-4">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <h3 class="text-sm font-semibold text-text">{s.title}</h3>
            <p class="mt-1 whitespace-pre-line text-sm text-text-secondary">{s.body}</p>
          </div>
          <button
            type="button"
            onclick={() => dismiss(s)}
            disabled={dismissingId === s.id}
            class="btn btn-ghost btn-sm shrink-0"
          >
            Dismiss
          </button>
        </div>
        <div class="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-surface-2 px-3 py-2">
          <p class="min-w-0 flex-1 text-sm text-text-secondary">{s.instruction}</p>
          <button type="button" onclick={() => onAsk(s.instruction)} class="btn btn-primary btn-sm shrink-0">
            <MessagesSquare size={14} /> Ask Ace
          </button>
          <div class="relative shrink-0" data-suggestion-menu>
            <button
              type="button"
              onclick={(e) => {
                menuTrigger = e.currentTarget;
                menuId = menuId === s.id ? null : s.id;
              }}
              aria-haspopup="menu"
              aria-expanded={menuId === s.id}
              aria-label="Other ways to run this"
              class="btn btn-ghost btn-sm"
            >
              <MoreHorizontal size={16} />
            </button>
            {#if menuId === s.id}
              <div
                role="menu"
                aria-label="Other ways to run this"
                class="absolute right-0 top-full z-30 mt-1 w-64 overflow-hidden rounded-2xl border border-border bg-surface shadow-lg"
              >
                <button
                  type="button"
                  onclick={() => copyCommand(s)}
                  role="menuitem"
                  class="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm text-text-secondary transition-colors hover:bg-surface-2 hover:text-text"
                >
                  {#if copiedId === s.id}
                    <Check size={16} class="text-inbound" /> Copied
                  {:else}
                    <Copy size={16} /> Copy Claude Code command
                  {/if}
                </button>
              </div>
            {/if}
          </div>
        </div>
      </div>
    {/each}
  </div>
</section>
