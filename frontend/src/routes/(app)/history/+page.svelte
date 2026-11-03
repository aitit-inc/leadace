<script lang="ts">
  import EmptyState from '$lib/components/EmptyState.svelte';
  import HistoryList from '$lib/components/HistoryList.svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
</script>

<h2 class="mb-1 font-display text-2xl font-semibold tracking-tight text-text">History</h2>
<p class="mb-6 text-sm text-text-muted">What was decided, what was done each day, and what came back.</p>

{#if data.rows.length > 0}
  <div class="card p-5">
    <HistoryList rows={data.rows} />
  </div>
{:else}
  <EmptyState message="Nothing yet. What Ace does and decides shows up here." />
{/if}
