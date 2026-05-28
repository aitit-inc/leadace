<script lang="ts">
  import type { Sentiment } from '$lib/types/responses';

  let { sentiment }: { sentiment: Sentiment } = $props();

  const colors: Record<Sentiment, string> = {
    positive: 'bg-success/15 text-success',
    neutral: 'bg-surface-2 text-text-secondary',
    negative: 'bg-danger/15 text-danger',
  };
</script>

<span class="inline-block rounded px-1.5 py-0.5 text-[11px] font-medium font-mono {colors[sentiment]}">{sentiment}</span>
