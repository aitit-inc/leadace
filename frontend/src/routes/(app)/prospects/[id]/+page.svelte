<script lang="ts">
  import StatusBadge from '$lib/components/StatusBadge.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import ProspectDetail from '$lib/components/prospects/ProspectDetail.svelte';
  import { channelLabel } from '$lib/contact-channels';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
</script>

<div class="mb-4">
  <a href="/prospects" class="text-xs text-text-muted hover:text-text">← Prospects</a>
</div>

{#if !data.prospect}
  <EmptyState message="Prospect not found" />
{:else}
  {@const p = data.prospect}
  <div class="rounded bg-surface px-4 py-4">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0 flex-1">
        <h2 class="text-lg font-semibold text-text">{p.name}</h2>
        <p class="text-xs text-text-muted mt-1">{p.organizationName}</p>
      </div>
      <span class="shrink-0"><StatusBadge status={p.status} /></span>
    </div>
    <div class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-secondary">
      <span class="font-mono">P{p.priority}</span>
      <span aria-hidden="true">·</span>
      <span>{channelLabel(p)}</span>
      <span aria-hidden="true">·</span>
      <span class="font-mono text-text-muted">
        Added {new Date(p.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
      </span>
    </div>
    <div class="mt-4 border-t border-border pt-4">
      <ProspectDetail {p} />
    </div>
  </div>
{/if}
