<script lang="ts">
  import EmptyState from '$lib/components/EmptyState.svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  function pct(n: number, d: number) {
    if (d === 0) return '0%';
    return ((n / d) * 100).toFixed(1) + '%';
  }
</script>

<h2 class="mb-6 font-display text-2xl font-semibold tracking-tight text-text">Evaluations</h2>

{#if !data.stats}
  <EmptyState message="No data available" />
{:else}
  {@const stats = data.stats}
  {@const replyTone = stats.metrics.responseCounts.totalResponses > 0 ? 'text-inbound' : 'text-text'}
  <section class="mb-10 space-y-3">
    <h3 class="font-display text-lg font-semibold text-text">Current Metrics</h3>

    <div class="grid grid-cols-2 gap-px overflow-hidden rounded-2xl bg-border md:grid-cols-4">
      <div class="bg-surface p-5">
        <p class="font-display text-3xl font-semibold tracking-tight tabular-nums text-text">{stats.metrics.totalOutreach}</p>
        <p class="mt-1 text-sm text-text-secondary">Total outreach</p>
      </div>
      <div class="bg-surface p-5">
        <p class="font-display text-3xl font-semibold tracking-tight tabular-nums {replyTone}">
          {stats.metrics.responseCounts.totalResponses}
        </p>
        <p class="mt-1 text-sm text-text-secondary">Responses</p>
      </div>
      <div class="bg-surface p-5">
        <p class="font-display text-3xl font-semibold tracking-tight tabular-nums {replyTone}">
          {pct(stats.metrics.responseCounts.totalResponses, stats.metrics.totalOutreach)}
        </p>
        <p class="mt-1 text-sm text-text-secondary">Response rate</p>
      </div>
      <div class="bg-surface p-5">
        <p class="font-display text-3xl font-semibold tracking-tight {stats.dataSufficiency.sufficient ? 'text-inbound' : 'text-warning'}">
          {stats.dataSufficiency.sufficient ? 'Yes' : 'No'}
        </p>
        <p class="mt-1 text-sm tabular-nums text-text-secondary">Data sufficient · {stats.dataSufficiency.totalSent} sends</p>
      </div>
    </div>

    {#if stats.metrics.channelResponseRate.length > 0}
      <div class="card p-5">
        <p class="mb-3 text-sm font-semibold text-text">By channel</p>
        <div class="grid grid-cols-[1fr_60px_70px_60px] md:grid-cols-[1fr_80px_80px_80px] gap-2 text-sm">
          <span class="text-xs font-semibold text-text-muted">Channel</span>
          <span class="text-right text-xs font-semibold text-text-muted">Sent</span>
          <span class="text-right text-xs font-semibold text-text-muted">Resp.</span>
          <span class="text-right text-xs font-semibold text-text-muted">Rate</span>
          {#each stats.metrics.channelResponseRate as ch}
            <span class="truncate text-text">{ch.channel}</span>
            <span class="text-right tabular-nums text-text-secondary">{ch.total}</span>
            <span class="text-right tabular-nums text-text-secondary">{ch.responses}</span>
            <span class="text-right tabular-nums text-text">{pct(ch.responses, ch.total)}</span>
          {/each}
        </div>
      </div>
    {/if}

    {#if stats.metrics.channelByIndustry.length > 0}
      <div class="card p-5">
        <p class="mb-3 text-sm font-semibold text-text">By industry × channel</p>
        <div class="grid grid-cols-[1fr_64px_44px_44px_52px] md:grid-cols-[1fr_90px_70px_70px_80px] gap-2 text-sm">
          <span class="text-xs font-semibold text-text-muted">Industry</span>
          <span class="text-xs font-semibold text-text-muted">Channel</span>
          <span class="text-right text-xs font-semibold text-text-muted">Sent</span>
          <span class="text-right text-xs font-semibold text-text-muted">Resp.</span>
          <span class="text-right text-xs font-semibold text-text-muted">Rate</span>
          {#each stats.metrics.channelByIndustry as ci}
            <span class="truncate text-text">{ci.industry ?? 'Unclassified'}</span>
            <span class="truncate text-text-secondary">{ci.channel}</span>
            <span class="text-right tabular-nums text-text-secondary">{ci.total}</span>
            <span class="text-right tabular-nums text-text-secondary">{ci.responses}</span>
            <span class="text-right tabular-nums text-text">{pct(ci.responses, ci.total)}</span>
          {/each}
        </div>
        <p class="mt-3 text-xs text-text-muted">Rates on small Sent counts are noisy — weigh by Sent.</p>
      </div>
    {/if}

    {#if stats.metrics.industryResponseRate.length > 0}
      <div class="card p-5">
        <p class="mb-3 text-sm font-semibold text-text">By industry · reply-matured sends</p>
        <div class="grid grid-cols-[1fr_60px_70px_60px] md:grid-cols-[1fr_80px_80px_80px] gap-2 text-sm">
          <span class="text-xs font-semibold text-text-muted">Industry</span>
          <span class="text-right text-xs font-semibold text-text-muted">Sent</span>
          <span class="text-right text-xs font-semibold text-text-muted">Resp.</span>
          <span class="text-right text-xs font-semibold text-text-muted">Rate</span>
          {#each stats.metrics.industryResponseRate as ind}
            <span class="truncate text-text">{ind.industry}</span>
            <span class="text-right tabular-nums text-text-secondary">{ind.total}</span>
            <span class="text-right tabular-nums text-text-secondary">{ind.responses}</span>
            <span class="text-right tabular-nums text-text">{pct(ind.responses, ind.total)}</span>
          {/each}
        </div>
      </div>
    {/if}

    {#if stats.metrics.sizeResponseRate.length > 0}
      <div class="card p-5">
        <p class="mb-3 text-sm font-semibold text-text">By company size · reply-matured sends</p>
        <div class="grid grid-cols-[1fr_60px_70px_60px] md:grid-cols-[1fr_80px_80px_80px] gap-2 text-sm">
          <span class="text-xs font-semibold text-text-muted">Employees</span>
          <span class="text-right text-xs font-semibold text-text-muted">Sent</span>
          <span class="text-right text-xs font-semibold text-text-muted">Resp.</span>
          <span class="text-right text-xs font-semibold text-text-muted">Rate</span>
          {#each stats.metrics.sizeResponseRate as s}
            <span class="tabular-nums text-text">{s.employeeBand}</span>
            <span class="text-right tabular-nums text-text-secondary">{s.total}</span>
            <span class="text-right tabular-nums text-text-secondary">{s.responses}</span>
            <span class="text-right tabular-nums text-text">{pct(s.responses, s.total)}</span>
          {/each}
        </div>
      </div>
    {/if}

    {#if stats.metrics.countryResponseRate.length > 0}
      <div class="card p-5">
        <p class="mb-3 text-sm font-semibold text-text">By country · reply-matured sends</p>
        <div class="grid grid-cols-[1fr_60px_70px_60px] md:grid-cols-[1fr_80px_80px_80px] gap-2 text-sm">
          <span class="text-xs font-semibold text-text-muted">Country</span>
          <span class="text-right text-xs font-semibold text-text-muted">Sent</span>
          <span class="text-right text-xs font-semibold text-text-muted">Resp.</span>
          <span class="text-right text-xs font-semibold text-text-muted">Rate</span>
          {#each stats.metrics.countryResponseRate as c}
            <span class="text-text">{c.country ?? 'Unknown'}</span>
            <span class="text-right tabular-nums text-text-secondary">{c.total}</span>
            <span class="text-right tabular-nums text-text-secondary">{c.responses}</span>
            <span class="text-right tabular-nums text-text">{pct(c.responses, c.total)}</span>
          {/each}
        </div>
      </div>
    {/if}

    {#if stats.metrics.discoveryStrategyResponseRate.length > 0}
      <div class="card p-5">
        <p class="mb-3 text-sm font-semibold text-text">By discovery strategy</p>
        <div class="grid grid-cols-[1fr_52px_52px_52px_60px] md:grid-cols-[1fr_70px_70px_70px_80px] gap-2 text-sm">
          <span class="text-xs font-semibold text-text-muted">Strategy</span>
          <span class="text-right text-xs font-semibold text-text-muted">Sent</span>
          <span class="text-right text-xs font-semibold text-text-muted">Resp.</span>
          <span class="text-right text-xs font-semibold text-text-muted">Rate</span>
          <span class="text-right text-xs font-semibold text-text-muted">Bounce</span>
          {#each stats.metrics.discoveryStrategyResponseRate as d}
            <span class="truncate text-text">{d.strategy ?? 'Unattributed'}</span>
            <span class="text-right tabular-nums text-text-secondary">{d.total}</span>
            <span class="text-right tabular-nums text-text-secondary">{d.responses}</span>
            <span class="text-right tabular-nums text-text">{pct(d.responses, d.total)}</span>
            <span class="text-right tabular-nums text-text-secondary">{d.bounceRate.toFixed(1)}%</span>
          {/each}
        </div>
        <p class="mt-3 text-xs text-text-muted">High bounce marks a dead source. Bounce % counts threaded email sends only.</p>
      </div>
    {/if}

    {#if stats.metrics.variantResponseRate.length > 0}
      <div class="card p-5">
        <p class="mb-3 text-sm font-semibold text-text">By message angle · reply-matured sends</p>
        <div class="grid grid-cols-[1fr_56px_44px_44px_44px_60px] md:grid-cols-[1fr_80px_70px_70px_70px_80px] gap-2 text-sm">
          <span class="text-xs font-semibold text-text-muted">Angle</span>
          <span class="text-xs font-semibold text-text-muted">Status</span>
          <span class="text-right text-xs font-semibold text-text-muted">Sent</span>
          <span class="text-right text-xs font-semibold text-text-muted">Resp.</span>
          <span class="text-right text-xs font-semibold text-text-muted">Rate</span>
          <span class="text-right text-xs font-semibold text-text-muted">Reward/send</span>
          {#each stats.metrics.variantResponseRate as v}
            <span class="min-w-0">
              <span class="block truncate font-mono text-text">{v.variantId}</span>
              {#if v.label}<span class="block truncate text-xs text-text-muted">{v.label}</span>{/if}
            </span>
            <span class={v.active ? 'text-text' : 'text-text-muted'}>{v.active ? 'Active' : 'Archived'}</span>
            <span class="text-right tabular-nums text-text-secondary">{v.total}</span>
            <span class="text-right tabular-nums text-text-secondary">{v.responses}</span>
            <span class="text-right tabular-nums text-text">{pct(v.responses, v.total)}</span>
            <span class="text-right tabular-nums text-text">{v.meanReward.toFixed(2)}</span>
          {/each}
        </div>
      </div>
    {/if}

    {#if stats.metrics.priorityResponseRate.length > 0}
      <div class="card p-5">
        <p class="mb-3 text-sm font-semibold text-text">By priority</p>
        <div class="grid grid-cols-[1fr_60px_70px_60px] md:grid-cols-[1fr_80px_80px_80px] gap-2 text-sm">
          <span class="text-xs font-semibold text-text-muted">Priority</span>
          <span class="text-right text-xs font-semibold text-text-muted">Sent</span>
          <span class="text-right text-xs font-semibold text-text-muted">Resp.</span>
          <span class="text-right text-xs font-semibold text-text-muted">Rate</span>
          {#each stats.metrics.priorityResponseRate as pr}
            <span class="tabular-nums text-text">P{pr.priority}</span>
            <span class="text-right tabular-nums text-text-secondary">{pr.total}</span>
            <span class="text-right tabular-nums text-text-secondary">{pr.responses}</span>
            <span class="text-right tabular-nums text-text">{pct(pr.responses, pr.total)}</span>
          {/each}
        </div>
      </div>
    {/if}

    {#if stats.metrics.sentimentBreakdown.length > 0}
      <div class="card p-5">
        <p class="mb-3 text-sm font-semibold text-text">Sentiment breakdown</p>
        <div class="flex flex-wrap gap-2">
          {#each stats.metrics.sentimentBreakdown as s}
            <span class="chip bg-inbound/10 text-inbound">
              <span class="font-normal">{s.sentiment}/{s.responseType}:</span>
              <span class="tabular-nums">{s.count}</span>
            </span>
          {/each}
        </div>
      </div>
    {/if}

    {#if stats.metrics.inquiryOutcomeCounts}
      {@const ioc = stats.metrics.inquiryOutcomeCounts}
      {@const iocTotal = ioc.opened + ioc.inquired + ioc.lead + ioc.signup_clicked + ioc.unsubscribed}
      {#if iocTotal > 0}
        <div class="card p-5">
          <p class="mb-3 text-sm font-semibold text-text">Inquiry landing outcomes</p>
          <div class="flex flex-wrap gap-2">
            <span class="chip bg-inbound/10 text-inbound">
              <span class="font-normal">opened:</span>
              <span class="tabular-nums">{ioc.opened}</span>
            </span>
            <span class="chip bg-inbound/10 text-inbound">
              <span class="font-normal">inquired:</span>
              <span class="tabular-nums">{ioc.inquired}</span>
            </span>
            <span class="chip bg-inbound/10 text-inbound">
              <span class="font-normal">lead:</span>
              <span class="tabular-nums">{ioc.lead}</span>
            </span>
            <span class="chip bg-inbound/10 text-inbound">
              <span class="font-normal">signup_clicked:</span>
              <span class="tabular-nums">{ioc.signup_clicked}</span>
            </span>
            <span class="chip bg-inbound/10 text-inbound">
              <span class="font-normal">unsubscribed:</span>
              <span class="tabular-nums">{ioc.unsubscribed}</span>
            </span>
          </div>
        </div>
      {/if}
    {/if}
  </section>

  {#if stats.dailyActivity.length > 0}
    <section class="mb-10">
      <h3 class="mb-3 font-display text-lg font-semibold text-text">Activity trend · last 30d</h3>
      <div class="card grid max-w-sm grid-cols-[1fr_70px_70px] gap-2 p-5 text-sm md:grid-cols-[1fr_80px_80px]">
        <span class="text-xs font-semibold text-text-muted">Date</span>
        <span class="text-right text-xs font-semibold text-text-muted">Sent</span>
        <span class="text-right text-xs font-semibold text-text-muted">Resp.</span>
        {#each stats.dailyActivity as d}
          <span class="tabular-nums text-text">{d.date.slice(5)}</span>
          <span class="text-right tabular-nums text-text-secondary">{d.sent}</span>
          <span class="text-right tabular-nums text-text-secondary">{d.responses}</span>
        {/each}
      </div>
    </section>
  {/if}
{/if}
