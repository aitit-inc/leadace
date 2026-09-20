<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import Pagination from '$lib/components/Pagination.svelte';
  import type { PageProps } from './$types';
  import { PAGE_SIZE } from '$lib/pagination';

  let { data }: PageProps = $props();

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function pushUrl(nextQ: string, nextPage: number) {
    const sp = new URLSearchParams(page.url.searchParams);
    if (nextQ) sp.set('q', nextQ);
    else sp.delete('q');
    if (nextPage > 1) sp.set('page', String(nextPage));
    else sp.delete('page');
    const qs = sp.toString();
    void goto(qs ? `?${qs}` : '?', { replaceState: true, keepFocus: true, noScroll: true });
  }

  function onQueryInput(e: Event) {
    const next = (e.currentTarget as HTMLInputElement).value.trim();
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => pushUrl(next, 1), 400);
  }

  function onPageChange(n: number) {
    pushUrl(data.q, n);
  }
</script>

<div class="flex items-center justify-between mb-4">
  <h2 class="font-display text-2xl font-semibold tracking-tight text-text">Organizations</h2>
  <span class="text-sm tabular-nums text-text-muted">{data.total} total</span>
</div>

<div class="mb-4">
  <input
    type="text"
    value={data.q}
    oninput={onQueryInput}
    placeholder="Search by name or domain"
    class="field md:w-80"
  />
</div>

{#if data.organizations.length === 0}
  <EmptyState message="No organizations yet. Ask Ace in chat to find or import prospects — their organizations are created automatically." />
{:else}
  <div class="card overflow-hidden">
    <div class="hidden md:grid grid-cols-[1.5fr_1fr_70px_70px_100px] gap-4 border-b border-border px-5 py-2.5 text-xs font-semibold text-text-muted">
      <span>Name</span>
      <span>Domain</span>
      <span class="text-center">Prosp.</span>
      <span class="text-center">Proj.</span>
      <span class="text-right">Updated</span>
    </div>

    <div class="divide-y divide-border">
      {#each data.organizations as o}
        <div>
          <a
            href="/organizations/{o.id}"
            class="hidden md:grid grid-cols-[1.5fr_1fr_70px_70px_100px] gap-4 px-5 py-3 text-sm hover:bg-surface-2 transition-colors focus-visible:-outline-offset-2"
          >
            <span class="text-text truncate">{o.name}</span>
            <span class="text-text-secondary truncate self-center">{o.domain}</span>
            <span class="text-center tabular-nums text-text-secondary self-center">{o.prospectCount}</span>
            <span class="text-center tabular-nums text-text-secondary self-center">{o.projectCount}</span>
            <span class="text-right text-xs tabular-nums text-text-muted self-center">
              {new Date(o.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            </span>
          </a>

          <a
            href="/organizations/{o.id}"
            class="flex md:hidden flex-col gap-1 px-5 py-3 text-left hover:bg-surface-2 transition-colors focus-visible:-outline-offset-2"
          >
            <p class="text-sm text-text truncate">{o.name}</p>
            <p class="text-xs text-text-muted truncate">{o.domain}</p>
            <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs tabular-nums text-text-muted">
              <span>{o.prospectCount} prospects</span>
              <span aria-hidden="true">·</span>
              <span>{o.projectCount} projects</span>
              <span aria-hidden="true">·</span>
              <span>{new Date(o.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
            </div>
          </a>
        </div>
      {/each}
    </div>
  </div>
  <Pagination page={data.page} pageSize={PAGE_SIZE} total={data.total} onChange={onPageChange} />
{/if}
