<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { listOutreachResponses } from '$lib/api/outreach';
  import type { FunnelStageFilter, InquiryOutcome, OutreachStatus } from '$lib/types/outreach';
  import type { OutreachResponse } from '$lib/types/responses';
  import ChannelBadge from '$lib/components/ChannelBadge.svelte';
  import SentimentBadge from '$lib/components/SentimentBadge.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import Pagination from '$lib/components/Pagination.svelte';
  import type { PageProps } from './$types';
  import { PAGE_SIZE } from '$lib/pagination';

  let { data }: PageProps = $props();
  let token = $derived(data.session?.access_token);

  let expandedId = $state<number | null>(null);
  let responsesCache = $state<Record<number, OutreachResponse[]>>({});
  let loadingResponses = $state<Record<number, boolean>>({});

  let filterStage = $derived<string>(data.filters.stage);
  let filterPeriod = $derived<string>(data.filters.period);

  const STAGE_OPTIONS: { value: FunnelStageFilter; label: string }[] = [
    { value: 'approached', label: 'Approached' },
    { value: 'reached', label: 'Reached' },
    { value: 'engaged', label: 'Engaged' },
    { value: 'won', label: 'Won' },
  ];
  const PERIOD_OPTIONS: { value: '7d' | '30d'; label: string }[] = [
    { value: '7d', label: 'Last 7 days' },
    { value: '30d', label: 'Last 30 days' },
  ];
  let stageLabel = $derived(STAGE_OPTIONS.find((s) => s.value === filterStage)?.label ?? null);

  // Reset per-row expand state when the underlying list changes (page/project
  // change). The cache is intentionally kept — replies for log #N don't
  // change shape just because we paged away and came back.
  $effect(() => {
    void data.logs;
    expandedId = null;
  });

  function updateUrl(next: { stage?: string; period?: string; page?: number }) {
    const sp = new URLSearchParams(page.url.searchParams);
    const stage = next.stage ?? filterStage;
    const period = next.period ?? filterPeriod;
    const nextPage = next.page ?? data.page;

    if (stage) sp.set('stage', stage);
    else sp.delete('stage');
    if (period) sp.set('period', period);
    else sp.delete('period');
    if (next.page !== undefined && nextPage > 1) sp.set('page', String(nextPage));
    else sp.delete('page');

    const qs = sp.toString();
    void goto(qs ? `?${qs}` : '?', { replaceState: true, keepFocus: true, noScroll: true });
  }

  function onStageChange(e: Event) {
    updateUrl({ stage: (e.currentTarget as HTMLSelectElement).value, page: 1 });
  }
  function onPeriodChange(e: Event) {
    updateUrl({ period: (e.currentTarget as HTMLSelectElement).value, page: 1 });
  }
  function onPageChange(n: number) {
    updateUrl({ page: n });
  }

  async function toggleExpand(logId: number) {
    if (expandedId === logId) {
      expandedId = null;
      return;
    }
    expandedId = logId;
    const log = data.logs.find((l) => l.id === logId);
    if (!log || log.responseCount === 0) return;
    // Re-fetch when the cache snapshot is for a stale responseCount. A new
    // response landing while the user is on this page would otherwise stay
    // hidden behind the old expand state.
    const cached = responsesCache[logId];
    const cacheFresh = cached !== undefined && cached.length === log.responseCount;
    if (cacheFresh || loadingResponses[logId]) return;
    loadingResponses = { ...loadingResponses, [logId]: true };
    try {
      const res = await listOutreachResponses(logId, fetch, token);
      responsesCache = { ...responsesCache, [logId]: res.responses };
    } finally {
      const next = { ...loadingResponses };
      delete next[logId];
      loadingResponses = next;
    }
  }

  function formatDate(iso: string) {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function truncate(text: string, max = 80) {
    return text.length > max ? text.slice(0, max) + '...' : text;
  }

  function statusDot(s: OutreachStatus): string {
    switch (s) {
      case 'sent':
        return 'bg-success';
      case 'pending_review':
        return 'bg-text-muted';
      case 'failed':
        return 'bg-danger';
      case 'skipped':
        return 'bg-warning';
    }
  }

  function replyLabel(n: number): string {
    return n === 1 ? '1 reply' : `${n} replies`;
  }

  // Labels/colors match the dashboard's Recent activity chips.
  const INQUIRY_OUTCOME_META: Record<InquiryOutcome, { label: string; chip: string }> = {
    opened: { label: 'Opened page', chip: 'bg-surface-2 text-text-secondary' },
    inquired: { label: 'Chatted', chip: 'bg-info/15 text-info' },
    unsubscribed: { label: 'Unsubscribed', chip: 'bg-danger/15 text-danger' },
    signup_clicked: { label: 'Signed up', chip: 'bg-success/15 text-success' },
    lead: { label: 'Meeting request', chip: 'bg-success/15 text-success' },
  };
</script>

<h2 class="text-lg font-semibold text-text mb-4">Outreach Logs</h2>

<div class="flex flex-wrap items-center gap-4 mb-4">
  <select value={filterStage} onchange={onStageChange} class="bg-surface rounded px-2 py-1 text-xs text-text outline-none">
    <option value="">All sends</option>
    {#each STAGE_OPTIONS as s}
      <option value={s.value}>{s.label}</option>
    {/each}
  </select>
  <select value={filterPeriod} onchange={onPeriodChange} class="bg-surface rounded px-2 py-1 text-xs text-text outline-none">
    <option value="">All time</option>
    {#each PERIOD_OPTIONS as p}
      <option value={p.value}>{p.label}</option>
    {/each}
  </select>
  {#if stageLabel}
    <p class="text-xs text-text-muted">
      Sends whose prospect reached “{stageLabel}” — a prospect with several sends can appear more than once.
    </p>
  {/if}
</div>

{#if data.logs.length === 0}
  <EmptyState message={filterStage || filterPeriod ? 'No sends match the current filter' : 'No outreach logs yet'} />
{:else}
  <div class="space-y-0">
    <div class="hidden md:grid grid-cols-[110px_68px_60px_190px_minmax(0,1fr)] gap-4 px-3 py-2 text-xs font-medium text-text-muted">
      <span>Date</span>
      <span>Channel</span>
      <span>Status</span>
      <span>Recipient</span>
      <span>Subject / Body</span>
    </div>

    {#each data.logs as log}
      <button
        class="hidden md:grid w-full grid-cols-[110px_68px_60px_190px_minmax(0,1fr)] items-center gap-4 px-3 py-2.5 text-left text-sm hover:bg-surface transition-colors rounded"
        onclick={() => toggleExpand(log.id)}
      >
        <span class="text-text-secondary text-xs font-mono">{formatDate(log.sentAt)}</span>
        <span><ChannelBadge channel={log.channel} /></span>
        <span>
          <span class="inline-block h-1.5 w-1.5 rounded-full {statusDot(log.status)}"></span>
          <span class="text-xs text-text-secondary ml-1">{log.status}</span>
        </span>
        <span class="min-w-0">
          <span class="block truncate text-text">{log.prospectName}</span>
          {#if log.prospectEmail}
            <span class="block truncate text-xs text-text-muted font-mono">{log.prospectEmail}</span>
          {/if}
        </span>
        <span class="text-text truncate">
          {#if log.subject}
            <span class="font-medium">{log.subject}</span> &mdash;
          {/if}
          {truncate(log.body)}
          {#if log.responseCount > 0}
            <span class="ml-2 text-[11px] text-success font-medium">↳ {replyLabel(log.responseCount)}</span>
          {/if}
          {#if log.inquiryOutcome}
            <span class="ml-2 rounded px-1.5 py-0.5 text-[11px] font-medium {INQUIRY_OUTCOME_META[log.inquiryOutcome].chip}">
              {INQUIRY_OUTCOME_META[log.inquiryOutcome].label}
            </span>
          {/if}
        </span>
      </button>

      <button
        class="flex md:hidden w-full flex-col gap-1 px-3 py-3 text-left hover:bg-surface transition-colors rounded"
        onclick={() => toggleExpand(log.id)}
      >
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-center gap-2 min-w-0">
            <ChannelBadge channel={log.channel} />
            <span class="text-[11px] text-text-muted font-mono truncate">{formatDate(log.sentAt)}</span>
          </div>
          <div class="flex items-center gap-1 shrink-0">
            <span class="inline-block h-1.5 w-1.5 rounded-full {statusDot(log.status)}"></span>
            <span class="text-[11px] text-text-secondary">{log.status}</span>
          </div>
        </div>
        <div class="min-w-0">
          <p class="text-sm text-text truncate">{log.prospectName}</p>
          {#if log.prospectEmail}
            <p class="text-[11px] text-text-muted font-mono truncate">{log.prospectEmail}</p>
          {/if}
        </div>
        {#if log.subject}
          <p class="text-sm font-medium text-text truncate">{log.subject}</p>
        {/if}
        <p class="text-xs text-text-secondary line-clamp-2">{truncate(log.body, 120)}</p>
        {#if log.responseCount > 0 && log.latestResponseAt}
          <p class="text-[11px] text-success font-medium">↳ {replyLabel(log.responseCount)} · {formatDate(log.latestResponseAt)}</p>
        {/if}
        {#if log.inquiryOutcome}
          <p>
            <span class="rounded px-1.5 py-0.5 text-[11px] font-medium {INQUIRY_OUTCOME_META[log.inquiryOutcome].chip}">
              {INQUIRY_OUTCOME_META[log.inquiryOutcome].label}
            </span>
          </p>
        {/if}
      </button>

      {#if expandedId === log.id}
        <div class="mx-3 mb-2 rounded bg-surface px-4 py-3">
          <p class="text-xs mb-2 break-all">
            <span class="text-text-muted">To:</span>
            <a href="/prospects/{log.prospectId}" class="text-accent hover:underline">{log.prospectName}</a>
            {#if log.prospectEmail}<span class="font-mono text-text-muted ml-1">{log.prospectEmail}</span>{/if}
          </p>
          {#if log.subject}
            <p class="text-xs font-medium text-text mb-1 break-words">{log.subject}</p>
          {/if}
          <p class="text-xs text-text-secondary whitespace-pre-wrap break-words">{log.body}</p>
          {#if log.errorMessage}
            <p class="text-xs text-danger mt-2 break-words">Error: {log.errorMessage}</p>
          {/if}

          {#if log.responseCount > 0}
            <div class="mt-3 border-t border-border pt-3 space-y-2">
              <p class="text-[11px] font-medium text-text-muted uppercase tracking-wider">Replies ({log.responseCount})</p>
              {#if loadingResponses[log.id]}
                <p class="text-xs text-text-muted">Loading replies...</p>
              {:else if responsesCache[log.id]}
                {#each responsesCache[log.id] as r}
                  <div class="rounded bg-page px-3 py-2 space-y-1.5">
                    <div class="flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
                      <span class="font-mono">{formatDate(r.receivedAt)}</span>
                      <SentimentBadge sentiment={r.sentiment} />
                      <span class="font-mono text-text-secondary">{r.responseType}</span>
                      <ChannelBadge channel={r.channel} />
                    </div>
                    <p class="text-xs text-text-secondary whitespace-pre-wrap break-words">{r.content}</p>
                  </div>
                {/each}
              {/if}
            </div>
          {/if}
        </div>
      {/if}
    {/each}
  </div>
  <Pagination page={data.page} pageSize={PAGE_SIZE} total={data.total} onChange={onPageChange} />
{/if}
