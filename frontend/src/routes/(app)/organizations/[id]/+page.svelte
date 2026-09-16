<script lang="ts">
  import { invalidate } from '$app/navigation';
  import { updateOrganization } from '$lib/api/organizations';
  import { channelLabel } from '$lib/contact-channels';
  import { safeHttpUrl } from '$lib/redirect';
  import type { Channel } from '$lib/types/outreach';
  import type { OrganizationProspectInteraction } from '$lib/types/organizations';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  let token = $derived(data.session?.access_token);

  let editing = $state(false);
  let editName = $state('');
  let editWebsite = $state('');
  let saveError = $state<string | null>(null);
  let saving = $state(false);
  let expandedProspectId = $state<number | null>(null);

  function channelShort(ch: Channel): string {
    switch (ch) {
      case 'email': return 'Email';
      case 'form': return 'Form';
      case 'sns_twitter': return 'X DM';
      case 'sns_linkedin': return 'LI DM';
      case 'platform': return 'Platform';
    }
  }

  function interactionTime(i: OrganizationProspectInteraction): string {
    return i.type === 'outreach' ? i.sentAt : i.receivedAt;
  }

  function formatRelative(iso: string | null): string {
    if (!iso) return '—';
    const ms = Date.now() - new Date(iso).getTime();
    const days = Math.floor(ms / 86_400_000);
    if (days < 1) return 'today';
    if (days < 2) return 'yesterday';
    if (days < 30) return `${days}d ago`;
    if (days < 365) return `${Math.floor(days / 30)}mo ago`;
    return `${Math.floor(days / 365)}y ago`;
  }

  function formatTimestamp(iso: string): string {
    return new Date(iso).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function startEdit() {
    if (!data.organization) return;
    editName = data.organization.name;
    editWebsite = data.organization.websiteUrl;
    saveError = null;
    editing = true;
  }

  async function saveEdit() {
    if (!data.organization) return;
    saving = true;
    saveError = null;
    try {
      await updateOrganization(
        data.organization.id,
        {
          name: editName,
          websiteUrl: editWebsite,
        },
        fetch,
        token,
      );
      await invalidate('app:organization-detail');
      editing = false;
    } catch (e) {
      saveError = e instanceof Error ? e.message : 'Failed to save';
    } finally {
      saving = false;
    }
  }
</script>

<div class="mb-4">
  <a href="/organizations" class="text-sm text-text-muted transition-colors hover:text-text">← Organizations</a>
</div>

{#if !data.organization}
  <EmptyState message="Organization not found" />
{:else}
  {@const org = data.organization}
  <div class="card mb-6 p-5">
    {#if !editing}
      {@const safeOrgWebsite = safeHttpUrl(org.websiteUrl)}
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0 flex-1">
          <h2 class="font-display text-2xl font-semibold tracking-tight text-text">{org.name}</h2>
          <p class="text-sm text-text-secondary mt-1">{org.domain}</p>
          <p class="text-sm mt-2">
            <span class="text-text-muted">Website:</span>
            {#if safeOrgWebsite}
              <a href={safeOrgWebsite} target="_blank" rel="noopener noreferrer" class="text-accent-strong hover:underline break-all ml-1">{org.websiteUrl}</a>
            {:else}
              <span class="text-text-muted break-all ml-1">{org.websiteUrl}</span>
            {/if}
          </p>
        </div>
        <button
          onclick={startEdit}
          class="btn btn-secondary shrink-0"
        >
          Edit
        </button>
      </div>
    {:else}
      <div class="space-y-3">
        <div>
          <label for="org-name" class="block text-xs font-semibold text-text-muted mb-1.5">Name</label>
          <input
            id="org-name"
            type="text"
            bind:value={editName}
            class="field"
          />
        </div>
        <div>
          <label for="org-website" class="block text-xs font-semibold text-text-muted mb-1.5">Website URL</label>
          <input
            id="org-website"
            type="url"
            bind:value={editWebsite}
            class="field"
          />
        </div>
        <p class="text-xs text-text-muted">Domain ({org.domain}) is the dedup key and cannot be changed.</p>
        {#if saveError}
          <p class="text-sm text-danger">{saveError}</p>
        {/if}
        <div class="flex gap-2">
          <button
            onclick={saveEdit}
            disabled={saving}
            class="btn btn-primary"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
          <button
            onclick={() => (editing = false)}
            disabled={saving}
            class="btn btn-ghost"
          >
            Cancel
          </button>
        </div>
      </div>
    {/if}
  </div>

  <div class="mb-4 flex items-center justify-between">
    <h3 class="font-display text-lg font-semibold text-text">Prospects ({data.prospects.length})</h3>
  </div>

  {#if data.prospects.length === 0}
    <EmptyState message="No prospects under this organization yet." />
  {:else}
    <div class="card overflow-hidden">
      <div class="hidden md:grid grid-cols-[1.5fr_120px_70px_70px_60px_100px] gap-4 border-b border-border px-5 py-2.5 text-xs font-semibold text-text-muted">
        <span>Name</span>
        <span>Channels</span>
        <span class="text-center">Out / Resp</span>
        <span class="text-center">Last</span>
        <span class="text-center">DNC</span>
        <span class="text-right">Added</span>
      </div>

      <div class="divide-y divide-border">
        {#each data.prospects as p}
          {@const expanded = expandedProspectId === p.id}
          {@const totalInteractions = p.outreachCount + p.responseCount}
          <div>
            <button
              type="button"
              class="hidden md:grid w-full grid-cols-[1.5fr_120px_70px_70px_60px_100px] gap-4 px-5 py-3 text-left text-sm hover:bg-surface-2 transition-colors focus-visible:-outline-offset-2"
              onclick={() => (expandedProspectId = expanded ? null : p.id)}
            >
              <div class="min-w-0">
                <p class="text-text truncate">{p.name}</p>
                {#if p.department}<p class="text-xs text-text-muted truncate">{p.department}</p>{/if}
              </div>
              <span class="text-text-secondary self-center">{channelLabel(p)}</span>
              <span class="text-center tabular-nums text-text-secondary self-center">
                {p.outreachCount} / {p.responseCount}
              </span>
              <span class="text-center text-xs tabular-nums text-text-muted self-center">
                {formatRelative(p.lastInteractionAt)}
              </span>
              <span class="text-center text-text-muted self-center">
                {#if p.doNotContact}<span class="chip bg-danger/10 text-danger">Yes</span>{:else}-{/if}
              </span>
              <span class="text-right text-xs tabular-nums text-text-muted self-center">
                {new Date(p.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </span>
            </button>

            <button
              type="button"
              class="flex md:hidden w-full flex-col gap-1 px-5 py-3 text-left hover:bg-surface-2 transition-colors focus-visible:-outline-offset-2"
              onclick={() => (expandedProspectId = expanded ? null : p.id)}
            >
              <div class="flex items-start justify-between gap-2">
                <p class="min-w-0 flex-1 truncate text-sm text-text">{p.name}</p>
                {#if p.doNotContact}<span class="chip shrink-0 bg-danger/10 text-danger">DNC</span>{/if}
              </div>
              {#if p.department}<p class="text-xs text-text-muted truncate">{p.department}</p>{/if}
              <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs tabular-nums text-text-muted">
                <span>{channelLabel(p)}</span>
                <span aria-hidden="true">·</span>
                <span>{p.outreachCount} sent / {p.responseCount} replies</span>
                <span aria-hidden="true">·</span>
                <span>last {formatRelative(p.lastInteractionAt)}</span>
              </div>
            </button>

            {#if expanded}
              {@const safeForm = safeHttpUrl(p.contactFormUrl)}
              {@const safePlatform = safeHttpUrl(p.platformUrl)}
              {@const safeWebsite = safeHttpUrl(p.websiteUrl)}
              <div class="mx-5 mb-4 rounded-xl bg-page px-4 py-3 text-sm space-y-3">
                <div class="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-1">
                  {#if p.contactName}<p><span class="text-text-muted">Contact:</span> {p.contactName}</p>{/if}
                  {#if p.industry}<p><span class="text-text-muted">Industry:</span> {p.industry}</p>{/if}
                  {#if p.email}<p class="break-all"><span class="text-text-muted">Email:</span> {p.email}</p>{/if}
                  {#if p.contactFormUrl}<p class="break-all"><span class="text-text-muted">Form:</span> {#if safeForm}<a href={safeForm} target="_blank" rel="noopener noreferrer" class="text-accent-strong hover:underline">{p.contactFormUrl}</a>{:else}<span class="text-text-muted">{p.contactFormUrl}</span>{/if}</p>{/if}
                  {#if p.platformUrl}<p class="break-all"><span class="text-text-muted">Platform:</span> {#if safePlatform}<a href={safePlatform} target="_blank" rel="noopener noreferrer" class="text-accent-strong hover:underline">{p.platformUrl}</a>{:else}<span class="text-text-muted">{p.platformUrl}</span>{/if}</p>{/if}
                  <p><span class="text-text-muted">Linked projects:</span> {p.projectCount}</p>
                  <p><span class="text-text-muted">Website:</span> {#if safeWebsite}<a href={safeWebsite} target="_blank" rel="noopener noreferrer" class="text-accent-strong hover:underline break-all">{p.websiteUrl}</a>{:else}<span class="text-text-muted break-all">{p.websiteUrl}</span>{/if}</p>
                </div>
                {#if p.overview}
                  <p class="whitespace-pre-wrap text-text-secondary"><span class="text-text-muted">Overview:</span> {p.overview}</p>
                {/if}
                {#if p.notes}
                  <p class="whitespace-pre-wrap text-text-secondary"><span class="text-text-muted">Notes:</span> {p.notes}</p>
                {/if}

                <div>
                  <p class="text-xs font-semibold text-text-muted mb-1.5">Interaction history ({totalInteractions})</p>
                  {#if totalInteractions === 0}
                    <p class="text-text-muted">No outreach or responses recorded yet.</p>
                  {:else}
                    {#if p.interactions.length < totalInteractions}
                      <p class="text-xs text-text-muted mb-1.5">Showing latest {p.interactions.length} of {totalInteractions}.</p>
                    {/if}
                    <ul class="space-y-1.5">
                      {#each p.interactions as i}
                        <li class="flex items-baseline gap-2 border-l-2 pl-2 {i.type === 'response' ? 'border-inbound' : 'border-border'}">
                          <span class="text-xs tabular-nums text-text-muted shrink-0 w-32">{formatTimestamp(interactionTime(i))}</span>
                          <span class="chip bg-surface-2 text-text-secondary shrink-0">
                            {i.type === 'outreach' ? '→' : '←'} {channelShort(i.channel)}
                          </span>
                          {#if i.type === 'outreach'}
                            <span class="text-text-secondary">
                              {i.status}{#if i.subject} — <span class="text-text">{i.subject}</span>{/if}
                            </span>
                          {:else}
                            <span class="text-text-secondary">
                              {i.responseType} ({i.sentiment})
                            </span>
                          {/if}
                        </li>
                      {/each}
                    </ul>
                  {/if}
                </div>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  {/if}
{/if}
