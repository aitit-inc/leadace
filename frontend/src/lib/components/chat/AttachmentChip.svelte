<script lang="ts">
  let {
    name,
    size,
    onopen,
    onremove,
    busy = false,
  }: {
    name: string;
    size: number;
    onopen?: () => void;
    onremove?: () => void;
    busy?: boolean;
  } = $props();

  let readableSize = $derived(size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`);
</script>

<span class="chip max-w-56 gap-1.5 bg-surface-2 py-1 pl-2 pr-1 font-normal text-text-secondary">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true" class="h-3.5 w-3.5 shrink-0">
    <path d="M21 11.5 12.5 20a5 5 0 0 1-7-7l8-8a3.5 3.5 0 0 1 5 5l-8 8a2 2 0 0 1-3-3l7.5-7.5" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
  {#if onopen}
    <button type="button" onclick={onopen} class="min-w-0 truncate hover:text-text hover:underline" title={name}>{name}</button>
  {:else}
    <span class="min-w-0 truncate" title={name}>{name}</span>
  {/if}
  <span class="shrink-0 tabular-nums text-text-muted">{busy ? 'uploading…' : readableSize}</span>
  {#if onremove}
    <button
      type="button"
      onclick={onremove}
      aria-label="Remove {name}"
      class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-border hover:text-text"
    >
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true" class="h-3 w-3">
        <path d="m4 4 8 8M12 4l-8 8" stroke-linecap="round" />
      </svg>
    </button>
  {/if}
</span>
