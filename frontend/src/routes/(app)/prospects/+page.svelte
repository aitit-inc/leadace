<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { channelLabel } from '$lib/contact-channels';
  import StatusBadge from '$lib/components/StatusBadge.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import Pagination from '$lib/components/Pagination.svelte';
  import ProspectDetail from '$lib/components/prospects/ProspectDetail.svelte';
  import type { PageProps } from './$types';
  import { PAGE_SIZE } from '$lib/pagination';
  import { STATUSES } from './constants';

  let { data }: PageProps = $props();
  let expandedId = $state<number | null>(null);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Filters are URL-driven — `data.filters` is the source of truth; no parallel
  // $state mirror, so back / direct-link navigation and in-page edits stay in sync.
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
    debounceTimer = setTimeout(() => updateUrl({ q: next, page: 1 }), 400);
  }
  function onPageChange(n: number) {
    updateUrl({ page: n });
  }

  $effect(() => () => {
    if (debounceTimer) clearTimeout(debounceTimer);
  });
</script>

<div class="flex items-center justify-between mb-4">
  <h2 class="font-display text-2xl font-semibold tracking-tight text-text">Prospects</h2>
  <span class="text-sm tabular-nums text-text-muted">{data.total} total</span>
</div>

<div class="flex flex-wrap items-center gap-3 mb-4">
  <input
    type="text"
    value={filterQ}
    oninput={onQueryInput}
    placeholder="Search by name, contact, or domain"
    class="field md:w-80"
  />
  <select value={filterStatus} onchange={onStatusChange} class="field w-auto">
    <option value="">All statuses</option>
    {#each STATUSES as s}
      <option value={s}>{s}</option>
    {/each}
  </select>
  <select value={filterPriority} onchange={onPriorityChange} class="field w-auto">
    <option value="">All priorities</option>
    {#each [1, 2, 3, 4, 5] as p}
      <option value={String(p)}>P{p}</option>
    {/each}
  </select>
</div>

{#if data.prospects.length === 0}
  <EmptyState message="No prospects found" />
{:else}
  <div class="card overflow-hidden">
    <div class="hidden md:grid grid-cols-[1fr_140px_90px_50px_100px] gap-4 border-b border-border px-5 py-2.5 text-xs font-semibold text-text-muted">
      <span>Name / Organization</span>
      <span>Channels</span>
      <span>Status</span>
      <span class="text-center">Pri</span>
      <span class="text-right">Added</span>
    </div>

    <div class="divide-y divide-border">
      {#each data.prospects as p}
        <div>
          <button
            class="hidden md:grid w-full grid-cols-[1fr_140px_90px_50px_100px] gap-4 px-5 py-3 text-left text-sm hover:bg-surface-2 transition-colors focus-visible:-outline-offset-2"
            onclick={() => (expandedId = expandedId === p.ppId ? null : p.ppId)}
          >
            <div class="min-w-0">
              <p class="text-text truncate">{p.name}</p>
              <p class="text-xs text-text-muted truncate">{p.organizationName}</p>
            </div>
            <span class="text-text-secondary self-center">{channelLabel(p)}</span>
            <span class="self-center"><StatusBadge status={p.status} /></span>
            <span class="text-center tabular-nums text-text-secondary self-center">P{p.priority}</span>
            <span class="text-right text-xs tabular-nums text-text-muted self-center">
              {new Date(p.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            </span>
          </button>

          <button
            class="flex md:hidden w-full flex-col gap-1 px-5 py-3 text-left hover:bg-surface-2 transition-colors focus-visible:-outline-offset-2"
            onclick={() => (expandedId = expandedId === p.ppId ? null : p.ppId)}
          >
            <div class="flex items-start justify-between gap-2">
              <p class="min-w-0 flex-1 truncate text-sm text-text">{p.name}</p>
              <span class="shrink-0"><StatusBadge status={p.status} /></span>
            </div>
            <p class="text-xs text-text-muted truncate">{p.organizationName}</p>
            <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs tabular-nums text-text-muted">
              <span>{channelLabel(p)}</span>
              <span aria-hidden="true">·</span>
              <span>P{p.priority}</span>
              <span aria-hidden="true">·</span>
              <span>{new Date(p.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
            </div>
          </button>

          {#if expandedId === p.ppId}
            <div class="mx-5 mb-4 rounded-xl bg-page px-4 py-3">
              <ProspectDetail {p} />
              <p class="mt-3 text-sm">
                <a href="/prospects/{p.prospectId}" class="font-semibold text-accent-strong hover:underline">Open prospect →</a>
              </p>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  </div>
  <Pagination page={data.page} pageSize={PAGE_SIZE} total={data.total} onChange={onPageChange} />
{/if}
