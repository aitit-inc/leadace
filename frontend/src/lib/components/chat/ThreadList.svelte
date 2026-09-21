<script lang="ts">
  import { ChevronDown, Plus, Trash2 } from '@lucide/svelte';
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

  let open = $state(false);
  let selected = $derived(threads.find((t) => t.id === selectedId));

  function select(id: string) {
    open = false;
    onselect(id);
  }

  function start() {
    open = false;
    onnew();
  }
</script>

{#snippet list()}
  <ul class="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
    {#each threads as t (t.id)}
      <li class="group flex items-center gap-1">
        <button
          type="button"
          onclick={() => select(t.id)}
          class="min-w-0 flex-1 truncate rounded-full px-3 py-2 text-left text-sm transition-colors {t.id === selectedId
            ? 'bg-surface font-semibold text-text'
            : 'text-text-secondary hover:bg-surface-2 hover:text-text'}"
          title={t.title}
        >
          {t.title}
        </button>
        <!-- Kept visible where there is no hover to reveal it. -->
        <button
          type="button"
          onclick={() => ondelete(t.id)}
          class="shrink-0 rounded-full p-1.5 text-text-muted hover:text-danger md:invisible md:group-focus-within:visible md:group-hover:visible"
          aria-label="Delete chat"
        >
          <Trash2 size={14} />
        </button>
      </li>
    {:else}
      <li class="px-3 py-2 text-sm text-text-muted">No chats yet</li>
    {/each}
  </ul>
{/snippet}

<aside class="hidden h-full w-56 shrink-0 flex-col md:flex">
  <button type="button" onclick={start} class="btn btn-secondary mb-3 w-full">
    <Plus size={16} /> New chat
  </button>
  {@render list()}
</aside>

<div class="flex shrink-0 flex-col md:hidden">
  <div class="flex items-center gap-2">
    <button
      type="button"
      onclick={() => (open = !open)}
      aria-expanded={open}
      class="flex min-w-0 flex-1 items-center gap-2 rounded-full bg-surface px-3 py-2 text-sm text-text"
    >
      <span class="min-w-0 flex-1 truncate text-left">{selected?.title ?? 'Chats'}</span>
      <ChevronDown size={16} class="shrink-0 transition-transform duration-200 {open ? 'rotate-180' : ''}" />
    </button>
    <button type="button" onclick={start} aria-label="New chat" class="btn btn-secondary h-10 w-10 shrink-0 p-0">
      <Plus size={16} />
    </button>
  </div>
  {#if open}
    <div class="mt-2 flex max-h-64 flex-col">
      {@render list()}
    </div>
  {/if}
</div>
