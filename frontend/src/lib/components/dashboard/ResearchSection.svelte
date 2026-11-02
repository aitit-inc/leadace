<script lang="ts">
  import type { DashboardResearch, DashboardResponder } from '$lib/types/dashboard';

  let {
    research,
    responders,
    contacted,
    engaged,
  }: {
    research: DashboardResearch;
    responders: DashboardResponder[];
    contacted: number;
    engaged: number;
  } = $props();
</script>

{#if research.researched > 0}
  <p class="mb-4 text-sm text-text-secondary">
    Ace looked at <span class="tabular-nums font-semibold text-text">{research.researched}</span>
    {research.researched === 1 ? 'company' : 'companies'}.
    {#if research.notFit > 0}
      <span class="tabular-nums">{research.notFit}</span> (<span class="tabular-nums">{research.notFitPercent}%</span>) didn't fit your
      target or couldn't be confirmed.
    {/if}
    {#if research.noContact > 0}
      <span class="tabular-nums">{research.noContact}</span> fit but publish no way to reach them.
    {/if}
  </p>
{/if}

{#if responders.length > 0}
  <div class="mb-4">
    <p class="text-xs font-semibold text-text-muted">Who responded</p>
    <ul class="mt-1 space-y-1">
      {#each responders as r}
        <li class="flex items-baseline justify-between gap-2 text-sm">
          <span class="min-w-0 truncate text-text">
            {r.prospectName === r.organizationName ? r.organizationName : `${r.prospectName}, ${r.organizationName}`}
          </span>
          <span class="shrink-0 text-xs text-inbound">{r.level === 'positive' ? 'Positive' : 'With interest'}</span>
        </li>
      {/each}
    </ul>
  </div>
{:else if engaged > 0}
  <p class="mb-4 text-sm text-text-muted">No one has shown interest yet.</p>
{:else if contacted > 0}
  <p class="mb-4 text-sm text-text-muted">No one has responded yet. Replies often take a few days.</p>
{/if}

{#if research.notFitExamples.length > 0}
  <div class="mb-5">
    <p class="text-xs font-semibold text-text-muted">Why companies didn't fit (latest)</p>
    <ul class="mt-1 space-y-2">
      {#each research.notFitExamples as e}
        <li class="text-sm text-text-secondary">
          <span class="font-semibold text-text">{e.organizationName}:</span>
          {e.reason}
        </li>
      {/each}
    </ul>
  </div>
{/if}
