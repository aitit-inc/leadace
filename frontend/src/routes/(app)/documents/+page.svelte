<script lang="ts">
  import { invalidate } from '$app/navigation';
  import {
    approveDocumentVersion,
    getDocument,
    listDocumentHistory,
    saveDocument,
  } from '$lib/api/documents';
  import type { DocumentVersion } from '$lib/types/documents';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import type { PageProps } from './$types';

  const SLUG_LABELS: Record<string, string> = {
    business: 'Business',
    sales_strategy: 'Sales Strategy',
    search_notes: 'Search Notes',
    learnings: 'Learnings Log',
    public_journal: 'Public Journal',
  };

  let { data }: PageProps = $props();
  let token = $derived(data.session?.access_token);

  let selectedSlug = $state<string | null>(null);
  let currentDoc = $state<DocumentVersion | null>(null);
  let history = $state<DocumentVersion[]>([]);
  let showHistory = $state(false);
  let loadingDoc = $state(false);

  let editing = $state(false);
  let draft = $state('');
  let saving = $state(false);
  let saveError = $state<string | null>(null);
  let approving = $state(false);
  let approveError = $state<string | null>(null);

  const PLAYBOOK_PREFIX = 'playbook_';
  function isPlaybook(slug: string) {
    return slug.startsWith(PLAYBOOK_PREFIX);
  }
  // Agent-saved playbook versions wait for a human: skills follow only approved ones.
  let pendingApproval = $derived(
    selectedSlug !== null && isPlaybook(selectedSlug) && currentDoc?.approvedAt === null,
  );

  async function approve() {
    if (!data.activeProjectId || !selectedSlug || !currentDoc || approving) return;
    approving = true;
    approveError = null;
    try {
      await approveDocumentVersion(data.activeProjectId, selectedSlug, currentDoc.id, fetch, token);
      await selectDoc(selectedSlug);
    } catch (e) {
      approveError = e instanceof Error ? e.message : 'Approval failed.';
    } finally {
      approving = false;
    }
  }

  // Reset the drilldown when the project (and its index) changes.
  $effect(() => {
    void data.activeProjectId;
    selectedSlug = null;
    currentDoc = null;
    history = [];
    showHistory = false;
    editing = false;
    saveError = null;
  });

  async function selectDoc(slug: string) {
    if (!data.activeProjectId) return;
    selectedSlug = slug;
    loadingDoc = true;
    showHistory = false;
    history = [];
    editing = false;
    saveError = null;
    try {
      currentDoc = await getDocument(data.activeProjectId, slug, fetch, token);
    } catch {
      currentDoc = null;
    }
    loadingDoc = false;
  }

  async function loadHistory() {
    if (!data.activeProjectId || !selectedSlug) return;
    showHistory = true;
    const res = await listDocumentHistory(
      data.activeProjectId,
      selectedSlug,
      { limit: 20 },
      fetch,
      token,
    );
    history = res.history;
  }

  function startEdit() {
    draft = currentDoc?.content ?? '';
    saveError = null;
    editing = true;
  }

  function cancelEdit() {
    editing = false;
    saveError = null;
  }

  async function save() {
    if (!data.activeProjectId || !selectedSlug || !draft.trim() || saving) return;
    saving = true;
    saveError = null;
    try {
      await saveDocument(data.activeProjectId, selectedSlug, draft, fetch, token);
      editing = false;
      await selectDoc(selectedSlug);
      await invalidate('app:documents');
    } catch (e) {
      saveError = e instanceof Error ? e.message : 'Save failed.';
    } finally {
      saving = false;
    }
  }

  function formatDate(iso: string) {
    return new Date(iso).toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function label(slug: string) {
    if (isPlaybook(slug)) return `Playbook: ${slug.slice(PLAYBOOK_PREFIX.length)}`;
    return SLUG_LABELS[slug] ?? slug;
  }

</script>

<h2 class="mb-6 font-display text-2xl font-semibold tracking-tight text-text">Documents</h2>

{#if !data.activeProjectId}
  <EmptyState message="No active project. Create one with /leadace first." />
{:else}
  <div class="flex flex-col md:flex-row gap-4 md:gap-6">
    <div class="md:w-48 md:shrink-0">
      <div class="flex flex-wrap gap-2 md:flex-col md:gap-1">
        {#each data.documents as doc}
          <button
            onclick={() => selectDoc(doc.slug)}
            class="rounded-xl px-3 py-2 text-left text-sm transition-colors md:w-full
              {selectedSlug === doc.slug
                ? 'bg-surface font-semibold text-text'
                : 'text-text-secondary hover:bg-surface-2 hover:text-text'}"
          >
            <span class="block">{label(doc.slug)}</span>
            <span class="mt-0.5 block text-xs font-normal tabular-nums text-text-muted">
              {doc.updatedAt ? formatDate(doc.updatedAt) : 'Not created yet'}
            </span>
          </button>
        {/each}
      </div>
    </div>

    <div class="flex-1 min-w-0">
      {#if !selectedSlug}
        <p class="text-text-muted text-sm">Select a document to view</p>
      {:else if loadingDoc}
        <p class="text-text-muted text-sm">Loading...</p>
      {:else if editing}
        <div class="mb-3 flex items-center justify-between gap-2">
          <h3 class="font-display text-lg font-semibold text-text">{label(selectedSlug)}</h3>
          <div class="flex items-center gap-2">
            <button onclick={cancelEdit} class="btn btn-ghost btn-sm">
              Cancel
            </button>
            <button
              onclick={save}
              disabled={saving || !draft.trim()}
              class="btn btn-primary btn-sm"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
        <textarea
          bind:value={draft}
          aria-label={label(selectedSlug)}
          rows="22"
          spellcheck="false"
          class="field resize-y p-4 leading-relaxed"
        ></textarea>
        {#if saveError}
          <p class="mt-2 text-sm text-danger">{saveError}</p>
        {/if}
      {:else if !currentDoc}
        <EmptyState message="Document not found" />
      {:else}
        <div class="mb-4 flex items-center justify-between gap-2">
          <div>
            <h3 class="font-display text-lg font-semibold text-text">{label(selectedSlug)}</h3>
            <p class="mt-0.5 text-xs tabular-nums text-text-muted">Last updated: {formatDate(currentDoc.createdAt)}</p>
          </div>
          <div class="flex items-center gap-2">
            <button onclick={startEdit} class="btn btn-secondary btn-sm">Edit</button>
            <button
              onclick={() => (showHistory ? (showHistory = false) : loadHistory())}
              class="btn btn-ghost btn-sm"
            >
              {showHistory ? 'Hide history' : 'Show history'}
            </button>
          </div>
        </div>

        {#if pendingApproval}
          <div class="mb-4 flex flex-col gap-3 rounded-2xl bg-warning/10 p-4 sm:flex-row sm:items-center sm:justify-between">
            <p class="text-sm text-text-secondary">
              <span class="font-semibold text-text">Pending approval.</span>
              This version was saved by the agent. Skills follow a playbook only once you approve it — read it first; it runs as procedure.
            </p>
            <button
              onclick={approve}
              disabled={approving}
              class="btn btn-primary btn-sm shrink-0"
            >
              {approving ? 'Approving…' : 'Approve'}
            </button>
          </div>
          {#if approveError}
            <p class="mb-2 text-sm text-danger">{approveError}</p>
          {/if}
        {/if}

        <div class="card overflow-x-auto p-5">
          <pre class="whitespace-pre-wrap font-sans text-sm leading-relaxed text-text">{currentDoc.content}</pre>
        </div>

        {#if showHistory && history.length > 0}
          <div class="mt-6">
            <h4 class="mb-3 text-xs font-semibold text-text-muted">
              Version History ({history.length})
            </h4>
            <div class="card divide-y divide-border overflow-hidden">
              {#each history as ver, i}
                <details>
                  <summary class="cursor-pointer px-4 py-2.5 text-sm transition-colors hover:bg-surface-2 focus-visible:-outline-offset-2">
                    <span class="tabular-nums text-text-secondary">{formatDate(ver.createdAt)}</span>
                    {#if i === 0}
                      <span class="chip ml-2 text-text-secondary ring-1 ring-inset ring-border">current</span>
                    {/if}
                    {#if selectedSlug && isPlaybook(selectedSlug)}
                      <span class="chip ml-2 {ver.approvedAt ? 'text-text-muted ring-1 ring-inset ring-border' : 'bg-warning/15 text-warning'}">
                        {ver.approvedAt ? 'approved' : 'pending approval'}
                      </span>
                    {/if}
                  </summary>
                  <div class="border-t border-border bg-page px-4 py-3">
                    <pre class="whitespace-pre-wrap font-sans text-sm leading-relaxed text-text-secondary">{ver.content}</pre>
                  </div>
                </details>
              {/each}
            </div>
          </div>
        {/if}
      {/if}
    </div>
  </div>
{/if}
