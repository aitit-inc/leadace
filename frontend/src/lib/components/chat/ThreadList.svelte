<script lang="ts">
  import { Plus, Trash2 } from '@lucide/svelte';
  import type { ChatThread } from '$lib/types/chat';

  let {
    threads,
    selectedId,
    onselect,
    onnew,
    ondelete,
  }: {
    threads: ChatThread[];
    selectedId: string | null;
    onselect: (id: string) => void;
    onnew: () => void;
    ondelete: (id: string) => void;
  } = $props();
</script>

<aside class="flex h-full w-56 shrink-0 flex-col border-r border-border pr-3">
  <button
    type="button"
    onclick={onnew}
    class="mb-3 flex items-center justify-center gap-1 rounded border border-border px-2 py-1.5 text-xs text-text hover:bg-surface"
  >
    <Plus size={14} /> New chat
  </button>
  <ul class="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
    {#each threads as t (t.id)}
      <li class="group flex items-center gap-1">
        <button
          type="button"
          onclick={() => onselect(t.id)}
          class="min-w-0 flex-1 truncate rounded px-2 py-1.5 text-left text-xs {t.id === selectedId
            ? 'bg-surface-2 text-text'
            : 'text-text-secondary hover:bg-surface hover:text-text'}"
          title={t.title}
        >
          {t.title}
        </button>
        <button
          type="button"
          onclick={() => ondelete(t.id)}
          class="invisible shrink-0 p-1 text-text-muted hover:text-danger group-hover:visible"
          aria-label="Delete chat"
        >
          <Trash2 size={12} />
        </button>
      </li>
    {:else}
      <li class="px-2 py-1.5 text-xs text-text-muted">No chats yet</li>
    {/each}
  </ul>
</aside>
