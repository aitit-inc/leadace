<script lang="ts">
  import { Sparkles, Copy, Check } from '@lucide/svelte';
  import { dismissSuggestion } from '$lib/api/suggestions';
  import type { Suggestion } from '$lib/types/suggestions';

  let {
    suggestions,
    token,
    onChanged,
  }: {
    suggestions: Suggestion[];
    token: string | undefined;
    onChanged: () => void | Promise<void>;
  } = $props();

  let copiedId = $state<number | null>(null);
  let dismissingId = $state<number | null>(null);
  let dismissError = $state('');

  async function copyCommand(s: Suggestion) {
    try {
      await navigator.clipboard.writeText(s.command);
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
</script>

<section class="overflow-hidden rounded-xl border border-border bg-surface">
  <div class="flex items-center gap-2 border-b border-border px-5 py-3">
    <span class="flex h-6 w-6 items-center justify-center rounded-full bg-accent/15 text-accent">
      <Sparkles size={14} />
    </span>
    <h2 class="text-sm font-semibold text-text">Suggestions</h2>
    <span class="rounded-full bg-accent/15 px-2 py-0.5 text-xs font-semibold text-accent">
      {suggestions.length}
    </span>
    <span class="ml-auto hidden text-xs text-text-muted sm:inline">Next steps the AI recommends</span>
  </div>
  {#if dismissError}
    <p class="border-b border-border px-5 py-2 text-xs text-danger">{dismissError}</p>
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
            class="shrink-0 rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-medium text-text-muted hover:bg-surface-2 hover:text-text disabled:opacity-50"
          >
            Dismiss
          </button>
        </div>
        <div class="mt-3 overflow-hidden rounded-lg border border-border bg-surface-2">
          <div class="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
            <span class="text-[11px] font-medium uppercase tracking-wider text-text-muted">
              Run this in Claude Code
            </span>
            <button
              type="button"
              onclick={() => copyCommand(s)}
              class="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-xs font-medium text-text-secondary hover:text-text"
            >
              {#if copiedId === s.id}
                <Check size={13} class="text-success" /> Copied
              {:else}
                <Copy size={13} /> Copy
              {/if}
            </button>
          </div>
          <pre class="overflow-x-auto px-3 py-2"><code class="font-mono text-xs text-text">{s.command}</code></pre>
        </div>
      </div>
    {/each}
  </div>
</section>
