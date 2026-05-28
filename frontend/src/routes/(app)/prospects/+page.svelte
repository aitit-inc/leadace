<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { channelLabel } from '$lib/contact-channels';
  import { safeHttpUrl } from '$lib/redirect';
  import StatusBadge from '$lib/components/StatusBadge.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import Pagination from '$lib/components/Pagination.svelte';
  import type { PageProps } from './$types';
  import { PAGE_SIZE } from '$lib/pagination';
  import { STATUSES } from './constants';

  let { data }: PageProps = $props();
  let expandedId = $state<number | null>(null);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Filters are URL-driven — `data.filters` is the source of truth. We render
  // the bound `value` from data and push URL updates from the select handlers,
  // so external navigation (back / direct link) and in-page edits stay in
  // sync without a parallel $state mirror.
  let filterStatus = $derived<string>(data.filters.status ?? '');
  let filterPriority = $derived<string>(String(data.filters.priority));
  let filterQ = $derived<string>(data.filters.q ?? '');

  function updateUrl(next: { status?: string; priority?: string; q?: string; page?: number }) {
    const sp = new URLSearchParams(page.url.searchParams);
    const status = next.status ?? filterStatus;
    const priority = next.priority ?? filterPriority;
    const q = next.q ?? filterQ;
    const nextPage = next.page ?? data.page;

    if (status) sp.set('status', status);
    else sp.delete('status');
    if (priority) sp.set('priority', priority);
    else sp.delete('priority');
    if (q) sp.set('q', q);
    else sp.delete('q');
    // Filter changes reset page; pure page changes preserve filters.
    if (next.page !== undefined && nextPage > 1) sp.set('page', String(nextPage));
    else sp.delete('page');

    const qs = sp.toString();
    void goto(qs ? `?${qs}` : '?', { replaceState: true, keepFocus: true, noScroll: true });
  }

  function onStatusChange(e: Event) {
    updateUrl({ status: (e.currentTarget as HTMLSelectElement).value, page: 1 });
  }
  function onPriorityChange(e: Event) {
    updateUrl({ priority: (e.currentTarget as HTMLSelectElement).value, page: 1 });
  }
  function onQueryInput(e: Event) {
    const next = (e.currentTarget as HTMLInputElement).value.trim();
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => updateUrl({ q: next, page: 1 }), 200);
  }
  function onPageChange(n: number) {
    updateUrl({ page: n });
  }

  $effect(() => () => {
    if (debounceTimer) clearTimeout(debounceTimer);
  });
</script>

<div class="flex items-center justify-between mb-4">
  <h2 class="text-lg font-semibold text-text">Prospects</h2>
  <span class="text-xs text-text-muted font-mono">{data.total} total</span>
</div>

<div class="flex flex-wrap items-center gap-3 mb-4">
  <input
    type="text"
    value={filterQ}
    oninput={onQueryInput}
    placeholder="Search by name, contact, or domain"
    class="w-full md:w-80 bg-surface rounded px-3 py-1.5 text-xs text-text outline-none placeholder:text-text-muted"
  />
  <select value={filterStatus} onchange={onStatusChange} class="bg-surface rounded px-2 py-1 text-xs text-text outline-none">
    <option value="">All statuses</option>
    {#each STATUSES as s}
      <option value={s}>{s}</option>
    {/each}
  </select>
  <select value={filterPriority} onchange={onPriorityChange} class="bg-surface rounded px-2 py-1 text-xs text-text outline-none">
    <option value="">All priorities</option>
    {#each [1, 2, 3, 4, 5] as p}
      <option value={String(p)}>P{p}</option>
    {/each}
  </select>
</div>

{#if data.prospects.length === 0}
  <EmptyState message="No prospects found" />
{:else}
  <div class="space-y-0">
    <div class="hidden md:grid grid-cols-[1fr_140px_70px_50px_100px] gap-4 px-3 py-2 text-xs font-medium text-text-muted">
      <span>Name / Organization</span>
      <span>Channels</span>
      <span>Status</span>
      <span class="text-center">Pri</span>
      <span class="text-right">Added</span>
    </div>

    {#each data.prospects as p}
      <button
        class="hidden md:grid w-full grid-cols-[1fr_140px_70px_50px_100px] gap-4 px-3 py-2.5 text-left text-sm hover:bg-surface transition-colors rounded"
        onclick={() => (expandedId = expandedId === p.ppId ? null : p.ppId)}
      >
        <div class="min-w-0">
          <p class="text-text truncate">{p.name}</p>
          <p class="text-xs text-text-muted truncate">{p.organizationName}</p>
        </div>
        <span class="text-xs text-text-secondary self-center">{channelLabel(p)}</span>
        <span class="self-center"><StatusBadge status={p.status} /></span>
        <span class="text-center text-xs font-mono text-text-secondary self-center">P{p.priority}</span>
        <span class="text-right text-xs font-mono text-text-muted self-center">
          {new Date(p.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
        </span>
      </button>

      <button
        class="flex md:hidden w-full flex-col gap-1 px-3 py-3 text-left hover:bg-surface transition-colors rounded"
        onclick={() => (expandedId = expandedId === p.ppId ? null : p.ppId)}
      >
        <div class="flex items-start justify-between gap-2">
          <p class="min-w-0 flex-1 truncate text-sm text-text">{p.name}</p>
          <span class="shrink-0"><StatusBadge status={p.status} /></span>
        </div>
        <p class="text-xs text-text-muted truncate">{p.organizationName}</p>
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-text-muted">
          <span>{channelLabel(p)}</span>
          <span aria-hidden="true">·</span>
          <span>P{p.priority}</span>
          <span aria-hidden="true">·</span>
          <span>{new Date(p.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
        </div>
      </button>

      {#if expandedId === p.ppId}
        {@const safeWebsite = safeHttpUrl(p.websiteUrl)}
        {@const safeForm = safeHttpUrl(p.contactFormUrl)}
        <div class="mx-3 mb-2 rounded bg-surface px-4 py-3 text-xs space-y-1.5">
          <p><span class="text-text-muted">Organization:</span> <a href="/organizations/{p.organizationId}" class="text-accent hover:underline">{p.organizationName}</a></p>
          <p class="break-words"><span class="text-text-muted">Website:</span> {#if safeWebsite}<a href={safeWebsite} target="_blank" rel="noopener noreferrer" class="text-accent hover:underline">{p.websiteUrl}</a>{:else}<span class="font-mono text-text-muted">{p.websiteUrl}</span>{/if}</p>
          {#if p.email}<p class="break-all"><span class="text-text-muted">Email:</span> <span class="font-mono">{p.email}</span></p>{/if}
          {#if p.contactFormUrl}<p class="break-all"><span class="text-text-muted">Form:</span> {#if safeForm}<a href={safeForm} target="_blank" rel="noopener noreferrer" class="text-accent hover:underline">{p.contactFormUrl}</a>{:else}<span class="font-mono text-text-muted">{p.contactFormUrl}</span>{/if}</p>{/if}
          {#if p.contactName}<p><span class="text-text-muted">Contact:</span> {p.contactName}{#if p.overview} &mdash; {p.overview}{/if}</p>{/if}
          <p><span class="text-text-muted">Match reason:</span> {p.matchReason}</p>
          {#if p.notes}<p><span class="text-text-muted">Notes:</span> {p.notes}</p>{/if}
          {#if p.doNotContact}<p class="text-danger font-medium">Do not contact</p>{/if}
        </div>
      {/if}
    {/each}
  </div>
  <Pagination page={data.page} pageSize={PAGE_SIZE} total={data.total} onChange={onPageChange} />
{/if}
