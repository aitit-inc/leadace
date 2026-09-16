<script lang="ts">
  import type { Sentiment } from '$lib/types/responses';

  let { sentiment }: { sentiment: Sentiment } = $props();

  const colors: Record<Sentiment, string> = {
    positive: 'bg-inbound/10 text-inbound',
    neutral: 'bg-surface-2 text-text-secondary',
    negative: 'bg-danger/15 text-danger',
  };
</script>

<span class="chip capitalize {colors[sentiment]}">{sentiment}</span>
