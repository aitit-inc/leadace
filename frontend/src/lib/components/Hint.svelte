<script lang="ts">
  import { CircleHelp } from '@lucide/svelte';
  import type { Snippet } from 'svelte';

  let { label, children }: { label: string; children: Snippet } = $props();

  let open = $state(false);
  let root: HTMLSpanElement | undefined = $state();

  function onWindowClick(e: MouseEvent) {
    if (root && !root.contains(e.target as Node)) open = false;
  }
</script>

<svelte:window onclick={open ? onWindowClick : undefined} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<span
  class="relative inline-flex items-center"
  bind:this={root}
  onkeydown={(e) => {
    if (e.key === 'Escape' && open) {
      e.stopPropagation();
      open = false;
    }
  }}
>
  <button
    type="button"
    aria-label={label}
    aria-expanded={open}
    onclick={() => (open = !open)}
    class="inline-flex text-text-muted hover:text-text {open ? 'text-text' : ''}"
  >
    <CircleHelp size={14} />
  </button>
  {#if open}
    <div
      role="tooltip"
      class="absolute left-0 top-full z-30 mt-2 w-[min(20rem,calc(100vw-3rem))] cursor-default rounded-md border border-border bg-page px-3 py-2 text-left text-xs font-normal normal-case leading-relaxed tracking-normal text-text-secondary shadow-lg"
    >
      {@render children()}
    </div>
  {/if}
</span>
