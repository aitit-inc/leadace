<script lang="ts">
  import StatusBadge from '$lib/components/StatusBadge.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import { invalidate } from '$app/navigation';
  import ProspectDetail from '$lib/components/prospects/ProspectDetail.svelte';
  import Conversation from '$lib/components/responses/Conversation.svelte';
  import { channelLabel } from '$lib/contact-channels';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
</script>

<div class="mb-4">
  <a href="/prospects" class="text-sm text-text-muted transition-colors hover:text-text">← Prospects</a>
</div>

{#if !data.prospect}
  <EmptyState message="Prospect not found" />
{:else}
  {@const p = data.prospect}
  <div class="card p-5">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0 flex-1">
        <h2 class="font-display text-2xl font-semibold tracking-tight text-text">{p.name}</h2>
        <p class="text-sm text-text-secondary mt-1">{p.organizationName}</p>
      </div>
      <span class="shrink-0"><StatusBadge status={p.status} /></span>
    </div>
    <div class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-text-secondary">
      <span class="tabular-nums">P{p.priority}</span>
      <span aria-hidden="true">·</span>
      <span>{channelLabel(p)}</span>
      <span aria-hidden="true">·</span>
      <span class="tabular-nums text-text-muted">
        Added {new Date(p.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
      </span>
    </div>
    <div class="mt-4 border-t border-border pt-4">
      <ProspectDetail {p} />
    </div>
  </div>

  <h3 class="mb-3 mt-6 font-display text-lg font-semibold text-text">Conversation</h3>
  {#if data.messages.length > 0}
    <div class="card p-5">
      <Conversation
        messages={data.messages}
        prospectName={p.name}
        token={data.session?.access_token}
        onChanged={() => invalidate('app:responses')}
      />
    </div>
  {:else}
    <EmptyState message="Nothing sent yet" />
  {/if}
{/if}
