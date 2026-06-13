<script lang="ts">
  import { invalidate } from '$app/navigation';
  import { getDocument, listDocumentHistory, saveDocument, getMasterDocument } from '$lib/api/documents';
  import type { DocumentVersion } from '$lib/types/documents';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import type { PageProps } from './$types';

  const SLUG_LABELS: Record<string, string> = {
    business: 'Business',
    sales_strategy: 'Sales Strategy',
    search_notes: 'Search Notes',
    email_template: 'Email Template',
  };

  // email_template is the outbound body template; surface it as editable even before the doc exists.
  const ALWAYS_EDITABLE = ['email_template'];

  let { data }: PageProps = $props();
  let token = $derived(data.session?.access_token);

  let displayedDocs = $derived<Array<{ slug: string; updatedAt: string | null }>>([
    ...data.documents,
    ...ALWAYS_EDITABLE.filter((s) => !data.documents.some((d) => d.slug === s)).map(
      (slug) => ({ slug, updatedAt: null as string | null }),
    ),
  ]);

  let selectedSlug = $state<string | null>(null);
  let currentDoc = $state<DocumentVersion | null>(null);
  let history = $state<DocumentVersion[]>([]);
  let showHistory = $state(false);
  let loadingDoc = $state(false);

  let editing = $state(false);
  let draft = $state('');
  let saving = $state(false);
  let saveError = $state<string | null>(null);

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

  async function loadDefault() {
    saveError = null;
    try {
      const def = await getMasterDocument('tpl_email_base', fetch, token);
      draft = def.content;
    } catch {
      saveError = 'Could not load the default template.';
    }
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
    return SLUG_LABELS[slug] ?? slug;
  }

  let isEditable = $derived(selectedSlug !== null && ALWAYS_EDITABLE.includes(selectedSlug));
</script>

<h2 class="text-lg font-semibold text-text mb-6">Documents</h2>

{#if !data.activeProjectId}
  <EmptyState message="No active project. Create one with /leadace first." />
{:else}
  <div class="flex flex-col md:flex-row gap-4 md:gap-6">
    <div class="md:w-48 md:shrink-0">
      <div class="flex flex-wrap gap-2 md:flex-col md:gap-1">
        {#each displayedDocs as doc}
          <button
            onclick={() => selectDoc(doc.slug)}
            class="text-left px-3 py-2 rounded text-sm transition-colors md:w-full
              {selectedSlug === doc.slug
                ? 'bg-surface-2 text-text font-medium'
                : 'text-text-secondary hover:text-text hover:bg-surface'}"
          >
            <span class="block">{label(doc.slug)}</span>
            <span class="block text-xs text-text-muted mt-0.5">
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
          <h3 class="text-base font-semibold text-text">{label(selectedSlug)}</h3>
          <div class="flex items-center gap-3">
            {#if isEditable}
              <button onclick={loadDefault} class="text-xs text-accent hover:underline">
                Load default
              </button>
            {/if}
            <button onclick={cancelEdit} class="text-xs text-text-muted hover:text-text">
              Cancel
            </button>
            <button
              onclick={save}
              disabled={saving || !draft.trim()}
              class="rounded bg-text px-3 py-1 text-xs font-medium text-page transition-opacity hover:opacity-90 disabled:opacity-40"
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
          class="w-full resize-y rounded border border-border bg-page p-4 text-sm text-text font-mono leading-relaxed focus:border-text/60 focus:outline-none"
        ></textarea>
        {#if saveError}
          <p class="mt-2 text-xs text-danger">{saveError}</p>
        {/if}
      {:else if !currentDoc}
        {#if isEditable}
          <div class="mb-4 flex items-center justify-between">
            <h3 class="text-base font-semibold text-text">{label(selectedSlug)}</h3>
            <button onclick={startEdit} class="text-xs text-accent hover:underline">Create</button>
          </div>
          <EmptyState message="No email template yet. This is the body template the outbound run uses — click “Create” then “Load default” to start from the standard template." />
        {:else}
          <EmptyState message="Document not found" />
        {/if}
      {:else}
        <div class="mb-4 flex items-center justify-between gap-2">
          <div>
            <h3 class="text-base font-semibold text-text">{label(selectedSlug)}</h3>
            <p class="text-xs text-text-muted mt-0.5">Last updated: {formatDate(currentDoc.createdAt)}</p>
          </div>
          <div class="flex items-center gap-3">
            <button onclick={startEdit} class="text-xs text-accent hover:underline">Edit</button>
            <button
              onclick={() => (showHistory ? (showHistory = false) : loadHistory())}
              class="text-xs text-accent hover:underline"
            >
              {showHistory ? 'Hide history' : 'Show history'}
            </button>
          </div>
        </div>

        <div class="rounded border border-border bg-page p-4 overflow-x-auto">
          <pre class="text-sm text-text whitespace-pre-wrap font-mono leading-relaxed">{currentDoc.content}</pre>
        </div>

        {#if showHistory && history.length > 0}
          <div class="mt-6">
            <h4 class="text-xs font-medium text-text-muted uppercase tracking-wider mb-3">
              Version History ({history.length})
            </h4>
            <div class="space-y-3">
              {#each history as ver, i}
                <details class="border border-border rounded">
                  <summary class="px-3 py-2 text-xs cursor-pointer hover:bg-surface transition-colors">
                    <span class="font-mono text-text-muted">{formatDate(ver.createdAt)}</span>
                    {#if i === 0}
                      <span class="ml-2 text-accent font-medium">current</span>
                    {/if}
                  </summary>
                  <div class="px-3 py-2 border-t border-border bg-surface">
                    <pre class="text-xs text-text whitespace-pre-wrap font-mono leading-relaxed">{ver.content}</pre>
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
