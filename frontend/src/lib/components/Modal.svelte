<script lang="ts">
  import type { Snippet } from 'svelte';

  // Native <dialog> + showModal(): the browser owns the focus trap, the inert
  // background and Escape. A backdrop click targets the <dialog> itself, so its
  // box carries no padding of its own.

  let {
    labelledBy,
    size = 'md',
    closable = true,
    onclose,
    children,
  }: {
    labelledBy: string;
    size?: 'sm' | 'md';
    closable?: boolean;
    onclose: () => void;
    children: Snippet;
  } = $props();

  let el = $state<HTMLDialogElement>();
  const maxWidth = $derived(size === 'sm' ? 'max-w-sm' : 'max-w-md');

  $effect(() => {
    const opener = document.activeElement;
    el?.showModal();
    // <dialog> restores focus on close(), but callers unmount it without closing.
    return () => {
      if (opener instanceof HTMLElement) opener.focus();
    };
  });
</script>

<dialog
  bind:this={el}
  aria-labelledby={labelledBy}
  oncancel={(e) => !closable && e.preventDefault()}
  {onclose}
  onclick={(e) => e.target === el && closable && el.close()}
  class="m-auto w-full {maxWidth} rounded-3xl border border-border bg-surface p-0 text-text shadow-lg backdrop:bg-black/40"
>
  <div class="p-6">{@render children()}</div>
</dialog>
