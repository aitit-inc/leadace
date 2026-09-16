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

<aside class="flex h-full w-56 shrink-0 flex-col">
  <button type="button" onclick={onnew} class="btn btn-secondary mb-3 w-full">
    <Plus size={16} /> New chat
  </button>
  <ul class="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
    {#each threads as t (t.id)}
      <li class="group flex items-center gap-1">
        <button
          type="button"
          onclick={() => onselect(t.id)}
          class="min-w-0 flex-1 truncate rounded-full px-3 py-2 text-left text-sm transition-colors {t.id === selectedId
            ? 'bg-surface font-semibold text-text'
            : 'text-text-secondary hover:bg-surface-2 hover:text-text'}"
          title={t.title}
        >
          {t.title}
        </button>
        <button
          type="button"
          onclick={() => ondelete(t.id)}
          class="invisible shrink-0 rounded-full p-1.5 text-text-muted hover:text-danger group-focus-within:visible group-hover:visible"
          aria-label="Delete chat"
        >
          <Trash2 size={14} />
        </button>
      </li>
    {:else}
      <li class="px-3 py-2 text-sm text-text-muted">No chats yet</li>
    {/each}
  </ul>
</aside>
