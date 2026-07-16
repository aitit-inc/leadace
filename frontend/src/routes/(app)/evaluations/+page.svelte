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
        <p class="text-xs text-text-muted mt-0.5">Data sufficient · {stats.dataSufficiency.totalSent} sends</p>
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

    {#if stats.metrics.industryResponseRate.length > 0}
      <div class="mb-6">
        <p class="text-xs font-medium text-text-secondary mb-2">By industry · reply-matured sends</p>
        <div class="grid grid-cols-[1fr_60px_70px_60px] md:grid-cols-[1fr_80px_80px_80px] gap-2 text-xs">
          <span class="text-text-muted">Industry</span>
          <span class="text-text-muted text-right">Sent</span>
          <span class="text-text-muted text-right">Resp.</span>
          <span class="text-text-muted text-right">Rate</span>
          {#each stats.metrics.industryResponseRate as ind}
            <span class="text-text truncate">{ind.industry}</span>
            <span class="text-text-secondary text-right font-mono">{ind.total}</span>
            <span class="text-text-secondary text-right font-mono">{ind.responses}</span>
            <span class="text-text text-right font-mono">{pct(ind.responses, ind.total)}</span>
          {/each}
        </div>
      </div>
    {/if}

    {#if stats.metrics.sizeResponseRate.length > 0}
      <div class="mb-6">
        <p class="text-xs font-medium text-text-secondary mb-2">By company size · reply-matured sends</p>
        <div class="grid grid-cols-[1fr_60px_70px_60px] md:grid-cols-[1fr_80px_80px_80px] gap-2 text-xs">
          <span class="text-text-muted">Employees</span>
          <span class="text-text-muted text-right">Sent</span>
          <span class="text-text-muted text-right">Resp.</span>
          <span class="text-text-muted text-right">Rate</span>
          {#each stats.metrics.sizeResponseRate as s}
            <span class="text-text font-mono">{s.employeeBand}</span>
            <span class="text-text-secondary text-right font-mono">{s.total}</span>
            <span class="text-text-secondary text-right font-mono">{s.responses}</span>
            <span class="text-text text-right font-mono">{pct(s.responses, s.total)}</span>
          {/each}
        </div>
      </div>
    {/if}

    {#if stats.metrics.countryResponseRate.length > 0}
      <div class="mb-6">
        <p class="text-xs font-medium text-text-secondary mb-2">By country · reply-matured sends</p>
        <div class="grid grid-cols-[1fr_60px_70px_60px] md:grid-cols-[1fr_80px_80px_80px] gap-2 text-xs">
          <span class="text-text-muted">Country</span>
          <span class="text-text-muted text-right">Sent</span>
          <span class="text-text-muted text-right">Resp.</span>
          <span class="text-text-muted text-right">Rate</span>
          {#each stats.metrics.countryResponseRate as c}
            <span class="text-text font-mono">{c.country ?? 'Unknown'}</span>
            <span class="text-text-secondary text-right font-mono">{c.total}</span>
            <span class="text-text-secondary text-right font-mono">{c.responses}</span>
            <span class="text-text text-right font-mono">{pct(c.responses, c.total)}</span>
          {/each}
        </div>
      </div>
    {/if}

    {#if stats.metrics.discoveryStrategyResponseRate.length > 0}
      <div class="mb-6">
        <p class="text-xs font-medium text-text-secondary mb-2">By discovery strategy</p>
        <div class="grid grid-cols-[1fr_52px_52px_52px_60px] md:grid-cols-[1fr_70px_70px_70px_80px] gap-2 text-xs">
          <span class="text-text-muted">Strategy</span>
          <span class="text-text-muted text-right">Sent</span>
          <span class="text-text-muted text-right">Resp.</span>
          <span class="text-text-muted text-right">Rate</span>
          <span class="text-text-muted text-right">Bounce</span>
          {#each stats.metrics.discoveryStrategyResponseRate as d}
            <span class="text-text font-mono truncate">{d.strategy ?? 'Unattributed'}</span>
            <span class="text-text-secondary text-right font-mono">{d.total}</span>
            <span class="text-text-secondary text-right font-mono">{d.responses}</span>
            <span class="text-text text-right font-mono">{pct(d.responses, d.total)}</span>
            <span class="text-text-secondary text-right font-mono">{d.bounceRate.toFixed(1)}%</span>
          {/each}
        </div>
        <p class="text-[11px] text-text-muted mt-1.5">High bounce marks a dead source. Bounce % counts threaded email sends only.</p>
      </div>
    {/if}

    {#if stats.metrics.freshSignalResponseRate.withSignal.total + stats.metrics.freshSignalResponseRate.withoutSignal.total > 0}
      {@const fs = stats.metrics.freshSignalResponseRate}
      <div class="mb-6">
        <p class="text-xs font-medium text-text-secondary mb-2">Fresh signal at send time</p>
        <div class="grid grid-cols-[1fr_60px_70px_60px] md:grid-cols-[1fr_80px_80px_80px] gap-2 text-xs">
          <span class="text-text-muted">Outreach</span>
          <span class="text-text-muted text-right">Sent</span>
          <span class="text-text-muted text-right">Resp.</span>
          <span class="text-text-muted text-right">Rate</span>
          <span class="text-text">With signal</span>
          <span class="text-text-secondary text-right font-mono">{fs.withSignal.total}</span>
          <span class="text-text-secondary text-right font-mono">{fs.withSignal.responses}</span>
          <span class="text-text text-right font-mono">{pct(fs.withSignal.responses, fs.withSignal.total)}</span>
          <span class="text-text">Without signal</span>
          <span class="text-text-secondary text-right font-mono">{fs.withoutSignal.total}</span>
          <span class="text-text-secondary text-right font-mono">{fs.withoutSignal.responses}</span>
          <span class="text-text text-right font-mono">{pct(fs.withoutSignal.responses, fs.withoutSignal.total)}</span>
        </div>
      </div>
    {/if}

    {#if stats.metrics.variantResponseRate.length > 0}
      <div class="mb-6">
        <p class="text-xs font-medium text-text-secondary mb-2">By message angle · reply-matured sends</p>
        <div class="grid grid-cols-[1fr_56px_44px_44px_44px_60px] md:grid-cols-[1fr_80px_70px_70px_70px_80px] gap-2 text-xs">
          <span class="text-text-muted">Angle</span>
          <span class="text-text-muted">Status</span>
          <span class="text-text-muted text-right">Sent</span>
          <span class="text-text-muted text-right">Resp.</span>
          <span class="text-text-muted text-right">Rate</span>
          <span class="text-text-muted text-right">Reward/send</span>
          {#each stats.metrics.variantResponseRate as v}
            <span class="min-w-0">
              <span class="block text-text font-mono truncate">{v.variantId}</span>
              {#if v.label}<span class="block text-text-muted truncate">{v.label}</span>{/if}
            </span>
            <span class={v.active ? 'text-success' : 'text-text-muted'}>{v.active ? 'Active' : 'Archived'}</span>
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
