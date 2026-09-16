<script lang="ts">
  import { Copy, Check } from '@lucide/svelte';
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

<section class="card overflow-hidden">
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
        <div class="mt-3 overflow-hidden rounded-xl bg-surface-2">
          <div class="flex items-center justify-between gap-2 px-3 py-2">
            <span class="text-xs font-semibold text-text-secondary">Run this in Claude Code</span>
            <button type="button" onclick={() => copyCommand(s)} class="btn btn-secondary btn-sm">
              {#if copiedId === s.id}
                <Check size={14} class="text-inbound" /> Copied
              {:else}
                <Copy size={14} /> Copy
              {/if}
            </button>
          </div>
          <pre class="overflow-x-auto px-3 pb-3"><code class="font-mono text-xs text-text">{s.command}</code></pre>
        </div>
      </div>
    {/each}
  </div>
</section>
