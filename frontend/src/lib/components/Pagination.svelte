<script lang="ts">
  type Props = {
    page: number;
    pageSize: number;
    total: number;
    onChange: (page: number) => void;
  };

  let { page, pageSize, total, onChange }: Props = $props();

  let totalPages = $derived(Math.max(1, Math.ceil(total / pageSize)));
  let firstShown = $derived(total === 0 ? 0 : (page - 1) * pageSize + 1);
  let lastShown = $derived(Math.min(page * pageSize, total));
  let canPrev = $derived(page > 1);
  let canNext = $derived(page < totalPages);
</script>

{#if total > pageSize}
  <div class="mt-4 flex items-center justify-between gap-3 border-t border-border pt-3">
    <span class="text-xs tabular-nums text-text-muted">
      {firstShown}–{lastShown} of {total}
    </span>
    <div class="flex items-center gap-2">
      <button
        type="button"
        disabled={!canPrev}
        onclick={() => onChange(page - 1)}
        class="btn btn-secondary btn-sm"
      >
        ← Prev
      </button>
      <span class="text-xs tabular-nums text-text-muted">
        {page} / {totalPages}
      </span>
      <button
        type="button"
        disabled={!canNext}
        onclick={() => onChange(page + 1)}
        class="btn btn-secondary btn-sm"
      >
        Next →
      </button>
    </div>
  </div>
{/if}
