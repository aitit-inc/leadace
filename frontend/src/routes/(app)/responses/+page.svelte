<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import type { ResponseType } from '$lib/types/responses';
  import ChannelBadge from '$lib/components/ChannelBadge.svelte';
  import SentimentBadge from '$lib/components/SentimentBadge.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import Pagination from '$lib/components/Pagination.svelte';
  import type { PageProps } from './$types';
  import { PAGE_SIZE } from '$lib/pagination';
  import { SENTIMENTS, TYPES } from './constants';

  let { data }: PageProps = $props();
  let expandedId = $state<number | null>(null);

  let filterSentiment = $derived<string>(data.filters.sentiment ?? '');
  let filterType = $derived<string>(data.filters.responseType ?? '');

  function updateUrl(next: { sentiment?: string; responseType?: string; page?: number }) {
    const sp = new URLSearchParams(page.url.searchParams);
    const sentiment = next.sentiment ?? filterSentiment;
    const responseType = next.responseType ?? filterType;
    const nextPage = next.page ?? data.page;

    if (sentiment) sp.set('sentiment', sentiment);
    else sp.delete('sentiment');
    if (responseType) sp.set('responseType', responseType);
    else sp.delete('responseType');
    if (next.page !== undefined && nextPage > 1) sp.set('page', String(nextPage));
    else sp.delete('page');

    const qs = sp.toString();
    void goto(qs ? `?${qs}` : '?', { replaceState: true, keepFocus: true, noScroll: true });
  }

  function onSentimentChange(e: Event) {
    updateUrl({ sentiment: (e.currentTarget as HTMLSelectElement).value, page: 1 });
  }
  function onTypeChange(e: Event) {
    updateUrl({ responseType: (e.currentTarget as HTMLSelectElement).value, page: 1 });
  }
  function onPageChange(n: number) {
    updateUrl({ page: n });
  }

  function formatDate(iso: string) {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function truncate(text: string, max = 100) {
    return text.length > max ? text.slice(0, max) + '...' : text;
  }

  function formatType(t: ResponseType): string {
    return t.replace(/_/g, ' ');
  }
</script>

<h2 class="text-lg font-semibold text-text mb-4">Responses</h2>

<div class="flex gap-4 mb-4">
  <select value={filterSentiment} onchange={onSentimentChange} class="bg-surface rounded px-2 py-1 text-xs text-text outline-none">
    <option value="">All sentiments</option>
    {#each SENTIMENTS as s}
      <option value={s}>{s}</option>
    {/each}
  </select>
  <select value={filterType} onchange={onTypeChange} class="bg-surface rounded px-2 py-1 text-xs text-text outline-none">
    <option value="">All types</option>
    {#each TYPES as t}
      <option value={t}>{formatType(t)}</option>
    {/each}
  </select>
</div>

{#if data.responses.length === 0}
  <EmptyState message="No responses yet" />
{:else}
  <div class="space-y-0">
    <div class="hidden md:grid grid-cols-[120px_70px_1fr_80px_100px] gap-4 px-3 py-2 text-xs font-medium text-text-muted">
      <span>Date</span>
      <span>Channel</span>
      <span>Prospect / Content</span>
      <span>Sentiment</span>
      <span>Type</span>
    </div>

    {#each data.responses as r}
      <button
        class="hidden md:grid w-full grid-cols-[120px_70px_1fr_80px_100px] gap-4 px-3 py-2.5 text-left text-sm hover:bg-surface transition-colors rounded"
        onclick={() => (expandedId = expandedId === r.id ? null : r.id)}
      >
        <span class="text-text-secondary text-xs font-mono">{formatDate(r.receivedAt)}</span>
        <span><ChannelBadge channel={r.channel} /></span>
        <div class="min-w-0">
          <p class="text-xs text-text-muted truncate">
            {r.prospectName}
            {#if r.outreachSubject}&mdash; re: {r.outreachSubject}{/if}
          </p>
          <p class="text-text truncate">{truncate(r.content)}</p>
        </div>
        <span class="self-center"><SentimentBadge sentiment={r.sentiment} /></span>
        <span class="text-xs text-text-secondary self-center">{formatType(r.responseType)}</span>
      </button>

      <button
        class="flex md:hidden w-full flex-col gap-1 px-3 py-3 text-left hover:bg-surface transition-colors rounded"
        onclick={() => (expandedId = expandedId === r.id ? null : r.id)}
      >
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-center gap-2 min-w-0">
            <ChannelBadge channel={r.channel} />
            <span class="text-[11px] text-text-muted font-mono truncate">{formatDate(r.receivedAt)}</span>
          </div>
          <SentimentBadge sentiment={r.sentiment} />
        </div>
        <p class="text-xs text-text-muted truncate">
          {r.prospectName}
          {#if r.outreachSubject}&mdash; re: {r.outreachSubject}{/if}
        </p>
        <p class="text-sm text-text line-clamp-2">{truncate(r.content, 140)}</p>
        <span class="text-[11px] text-text-secondary uppercase tracking-wide">{formatType(r.responseType)}</span>
      </button>

      {#if expandedId === r.id}
        <div class="mx-3 mb-2 rounded bg-surface px-4 py-3">
          <p class="text-xs text-text whitespace-pre-wrap break-words">{r.content}</p>
        </div>
      {/if}
    {/each}
  </div>
  <Pagination page={data.page} pageSize={PAGE_SIZE} total={data.total} onChange={onPageChange} />
{/if}
