<script lang="ts">
  import EmptyState from '$lib/components/EmptyState.svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  function pct(n: number, d: number) {
    if (d === 0) return '0%';
    return ((n / d) * 100).toFixed(1) + '%';
  }
</script>

<h2 class="text-lg font-semibold text-text mb-6">Evaluations</h2>

{#if !data.stats}
  <EmptyState message="No data available" />
{:else}
  {@const stats = data.stats}
  <section class="mb-10">
    <h3 class="text-xs font-medium text-text-muted uppercase tracking-wider mb-4">Current Metrics</h3>

    <div class="grid grid-cols-2 md:grid-cols-4 gap-4 md:gap-6 mb-6">
      <div>
        <p class="text-2xl font-mono font-semibold text-text">{stats.metrics.totalOutreach}</p>
        <p class="text-xs text-text-muted mt-0.5">Total outreach</p>
      </div>
      <div>
        <p class="text-2xl font-mono font-semibold text-text">{stats.metrics.responseCounts.totalResponses}</p>
        <p class="text-xs text-text-muted mt-0.5">Responses</p>
      </div>
      <div>
        <p class="text-2xl font-mono font-semibold text-text">
          {pct(stats.metrics.responseCounts.totalResponses, stats.metrics.totalOutreach)}
        </p>
        <p class="text-xs text-text-muted mt-0.5">Response rate</p>
      </div>
      <div>
        <p class="text-2xl font-mono font-semibold {stats.dataSufficiency.sufficient ? 'text-success' : 'text-warning'}">
          {stats.dataSufficiency.sufficient ? 'Yes' : 'No'}
        </p>
        <p class="text-xs text-text-muted mt-0.5">Data sufficient</p>
      </div>
    </div>

    {#if stats.metrics.channelResponseRate.length > 0}
      <div class="mb-6">
        <p class="text-xs font-medium text-text-secondary mb-2">By channel</p>
        <div class="grid grid-cols-[1fr_60px_70px_60px] md:grid-cols-[1fr_80px_80px_80px] gap-2 text-xs">
          <span class="text-text-muted">Channel</span>
          <span class="text-text-muted text-right">Sent</span>
          <span class="text-text-muted text-right">Resp.</span>
          <span class="text-text-muted text-right">Rate</span>
          {#each stats.metrics.channelResponseRate as ch}
            <span class="text-text font-mono truncate">{ch.channel}</span>
            <span class="text-text-secondary text-right font-mono">{ch.total}</span>
            <span class="text-text-secondary text-right font-mono">{ch.responses}</span>
            <span class="text-text text-right font-mono">{pct(ch.responses, ch.total)}</span>
          {/each}
        </div>
      </div>
    {/if}

    {#if stats.metrics.channelByIndustry.length > 0}
      <div class="mb-6">
        <p class="text-xs font-medium text-text-secondary mb-2">By industry × channel</p>
        <div class="grid grid-cols-[1fr_64px_44px_44px_52px] md:grid-cols-[1fr_90px_70px_70px_80px] gap-2 text-xs">
          <span class="text-text-muted">Industry</span>
          <span class="text-text-muted">Channel</span>
          <span class="text-text-muted text-right">Sent</span>
          <span class="text-text-muted text-right">Resp.</span>
          <span class="text-text-muted text-right">Rate</span>
          {#each stats.metrics.channelByIndustry as ci}
            <span class="text-text truncate">{ci.industry ?? 'Unclassified'}</span>
            <span class="text-text-secondary font-mono truncate">{ci.channel}</span>
            <span class="text-text-secondary text-right font-mono">{ci.total}</span>
            <span class="text-text-secondary text-right font-mono">{ci.responses}</span>
            <span class="text-text text-right font-mono">{pct(ci.responses, ci.total)}</span>
          {/each}
        </div>
        <p class="text-[11px] text-text-muted mt-1.5">Rates on small Sent counts are noisy — weigh by Sent.</p>
      </div>
    {/if}

    {#if stats.metrics.variantResponseRate.length > 0}
      <div class="mb-6">
        <p class="text-xs font-medium text-text-secondary mb-2">By subject variant · reply-matured sends</p>
        <div class="grid grid-cols-[1fr_52px_52px_52px_60px] md:grid-cols-[1fr_70px_70px_70px_80px] gap-2 text-xs">
          <span class="text-text-muted">Variant</span>
          <span class="text-text-muted text-right">Sent</span>
          <span class="text-text-muted text-right">Resp.</span>
          <span class="text-text-muted text-right">Rate</span>
          <span class="text-text-muted text-right">Reward/send</span>
          {#each stats.metrics.variantResponseRate as v}
            <span class="text-text font-mono truncate">{v.variantId}</span>
            <span class="text-text-secondary text-right font-mono">{v.total}</span>
            <span class="text-text-secondary text-right font-mono">{v.responses}</span>
            <span class="text-text text-right font-mono">{pct(v.responses, v.total)}</span>
            <span class="text-text text-right font-mono">{v.meanReward.toFixed(2)}</span>
          {/each}
        </div>
      </div>
    {/if}

    {#if stats.metrics.priorityResponseRate.length > 0}
      <div class="mb-6">
        <p class="text-xs font-medium text-text-secondary mb-2">By priority</p>
        <div class="grid grid-cols-[1fr_60px_70px_60px] md:grid-cols-[1fr_80px_80px_80px] gap-2 text-xs">
          <span class="text-text-muted">Priority</span>
          <span class="text-text-muted text-right">Sent</span>
          <span class="text-text-muted text-right">Resp.</span>
          <span class="text-text-muted text-right">Rate</span>
          {#each stats.metrics.priorityResponseRate as pr}
            <span class="text-text font-mono">P{pr.priority}</span>
            <span class="text-text-secondary text-right font-mono">{pr.total}</span>
            <span class="text-text-secondary text-right font-mono">{pr.responses}</span>
            <span class="text-text text-right font-mono">{pct(pr.responses, pr.total)}</span>
          {/each}
        </div>
      </div>
    {/if}

    {#if stats.metrics.sentimentBreakdown.length > 0}
      <div class="mb-6">
        <p class="text-xs font-medium text-text-secondary mb-2">Sentiment breakdown</p>
        <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {#each stats.metrics.sentimentBreakdown as s}
            <span class="font-mono">
              <span class="text-text-muted">{s.sentiment}/{s.responseType}:</span>
              <span class="text-text font-medium">{s.count}</span>
            </span>
          {/each}
        </div>
      </div>
    {/if}

    {#if stats.metrics.inquiryOutcomeCounts}
      {@const ioc = stats.metrics.inquiryOutcomeCounts}
      {@const iocTotal = ioc.opened + ioc.inquired + ioc.lead + ioc.signup_clicked + ioc.unsubscribed}
      {#if iocTotal > 0}
        <div>
          <p class="text-xs font-medium text-text-secondary mb-2">Inquiry landing outcomes</p>
          <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            <span class="font-mono">
              <span class="text-text-muted">opened:</span>
              <span class="text-text font-medium">{ioc.opened}</span>
            </span>
            <span class="font-mono">
              <span class="text-text-muted">inquired:</span>
              <span class="text-text font-medium">{ioc.inquired}</span>
            </span>
            <span class="font-mono">
              <span class="text-text-muted">lead:</span>
              <span class="text-text font-medium">{ioc.lead}</span>
            </span>
            <span class="font-mono">
              <span class="text-text-muted">signup_clicked:</span>
              <span class="text-text font-medium">{ioc.signup_clicked}</span>
            </span>
            <span class="font-mono">
              <span class="text-text-muted">unsubscribed:</span>
              <span class="text-text font-medium">{ioc.unsubscribed}</span>
            </span>
          </div>
        </div>
      {/if}
    {/if}
  </section>

  {#if stats.dailyActivity.length > 0}
    <section class="mb-10">
      <h3 class="text-xs font-medium text-text-muted uppercase tracking-wider mb-4">Activity trend · last 30d</h3>
      <div class="grid grid-cols-[1fr_70px_70px] md:grid-cols-[1fr_80px_80px] gap-2 text-xs max-w-sm">
        <span class="text-text-muted">Date</span>
        <span class="text-text-muted text-right">Sent</span>
        <span class="text-text-muted text-right">Resp.</span>
        {#each stats.dailyActivity as d}
          <span class="text-text font-mono">{d.date.slice(5)}</span>
          <span class="text-text-secondary text-right font-mono">{d.sent}</span>
          <span class="text-text-secondary text-right font-mono">{d.responses}</span>
        {/each}
      </div>
    </section>
  {/if}
{/if}
