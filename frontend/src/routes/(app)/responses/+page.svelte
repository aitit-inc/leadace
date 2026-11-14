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
  import { ANSWERS, SENTIMENTS, TYPES } from './constants';

  let { data }: PageProps = $props();

  let filterSentiment = $derived<string>(data.filters.sentiment ?? '');
  let filterType = $derived<string>(data.filters.responseType ?? '');
  let filterAnswer = $derived<string>(data.filters.answer ?? '');

  function updateUrl(next: { sentiment?: string; responseType?: string; answer?: string; page?: number }) {
    const sp = new URLSearchParams(page.url.searchParams);
    const sentiment = next.sentiment ?? filterSentiment;
    const responseType = next.responseType ?? filterType;
    const answer = next.answer ?? filterAnswer;
    const nextPage = next.page ?? data.page;

    if (sentiment) sp.set('sentiment', sentiment);
    else sp.delete('sentiment');
    if (responseType) sp.set('responseType', responseType);
    else sp.delete('responseType');
    if (answer) sp.set('answer', answer);
    else sp.delete('answer');
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
  function onAnswerChange(e: Event) {
    updateUrl({ answer: (e.currentTarget as HTMLSelectElement).value, page: 1 });
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

<h2 class="font-display text-2xl font-semibold tracking-tight text-text mb-4">Responses</h2>

<div class="flex gap-4 mb-4">
  <select value={filterSentiment} onchange={onSentimentChange} class="field w-auto">
    <option value="">All sentiments</option>
    {#each SENTIMENTS as s}
      <option value={s}>{s}</option>
    {/each}
  </select>
  <select value={filterType} onchange={onTypeChange} class="field w-auto">
    <option value="">All types</option>
    {#each TYPES as t}
      <option value={t}>{formatType(t)}</option>
    {/each}
  </select>
  <select value={filterAnswer} onchange={onAnswerChange} class="field w-auto">
    <option value="">Answered or not</option>
    {#each ANSWERS as a}
      <option value={a}>{a === 'waiting' ? 'Waiting for your answer' : 'Answered'}</option>
    {/each}
  </select>
</div>

{#if data.responses.length === 0}
  <EmptyState message="No responses yet" />
{:else}
  <div class="card overflow-hidden">
    <div class="hidden md:grid grid-cols-[120px_80px_1fr_80px_100px] gap-4 border-b border-border px-5 py-2.5 text-xs font-semibold text-text-muted">
      <span>Date</span>
      <span>Channel</span>
      <span>Prospect / Content</span>
      <span>Sentiment</span>
      <span>Type</span>
    </div>

    <div class="divide-y divide-border">
      {#each data.responses as r}
        <div>
          <a
            href="/prospects/{r.prospectId}"
            class="hidden md:grid w-full grid-cols-[120px_80px_1fr_80px_100px] gap-4 px-5 py-3 text-left text-sm hover:bg-surface-2 transition-colors focus-visible:-outline-offset-2"
          >
            <span class="text-text-secondary text-xs tabular-nums">{formatDate(r.receivedAt)}</span>
            <span><ChannelBadge channel={r.channel} /></span>
            <div class="min-w-0">
              <p class="text-xs text-text-muted truncate">
                {r.prospectName}
                {#if r.outreachSubject}&mdash; re: {r.outreachSubject}{/if}
              </p>
              <p class="text-text truncate">{truncate(r.content)}</p>
            </div>
            <span class="self-center"><SentimentBadge sentiment={r.sentiment} /></span>
            <span class="text-xs text-text-secondary self-center">
              {formatType(r.responseType)}
              {#if r.answer === 'waiting'}<span class="chip bg-warning/15 text-warning">Waiting</span>{/if}
            </span>
          </a>

          <a
            href="/prospects/{r.prospectId}"
            class="flex md:hidden w-full flex-col gap-1 px-5 py-3 text-left hover:bg-surface-2 transition-colors focus-visible:-outline-offset-2"
          >
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-2 min-w-0">
                <ChannelBadge channel={r.channel} />
                <span class="text-xs tabular-nums text-text-muted truncate">{formatDate(r.receivedAt)}</span>
              </div>
              <SentimentBadge sentiment={r.sentiment} />
            </div>
            <p class="text-xs text-text-muted truncate">
              {r.prospectName}
              {#if r.outreachSubject}&mdash; re: {r.outreachSubject}{/if}
            </p>
            <p class="text-sm text-text line-clamp-2">{truncate(r.content, 140)}</p>
            <span class="text-xs text-text-secondary">
              {formatType(r.responseType)}
              {#if r.answer === 'waiting'}<span class="chip bg-warning/15 text-warning">Waiting</span>{/if}
            </span>
          </a>
        </div>
      {/each}
    </div>
  </div>
  <Pagination page={data.page} pageSize={PAGE_SIZE} total={data.total} onChange={onPageChange} />
{/if}
