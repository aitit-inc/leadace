<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import {
    sendPreviewChatMessage,
    type InquiryChatTurn,
    type InquiryLandingPayload,
  } from '$lib/api/inquiry';
  import InquiryLandingView from '$lib/components/inquiry/InquiryLandingView.svelte';
  import Logo from '$lib/components/Logo.svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  let landing = $derived<InquiryLandingPayload | null>(
    data.result.state === 'ready' ? data.result.landing : null,
  );
  let token = $derived(data.session?.access_token);

  let filterQ = $derived(data.q ?? '');
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function updateUrl(next: { prospect?: string | null; q?: string }) {
    const sp = new URLSearchParams(page.url.searchParams);
    if (next.prospect !== undefined) {
      if (next.prospect) sp.set('prospect', next.prospect);
      else sp.delete('prospect');
    }
    if (next.q !== undefined) {
      if (next.q) sp.set('q', next.q);
      else sp.delete('q');
    }
    void goto(`?${sp}`, { replaceState: true, keepFocus: true, noScroll: true });
  }

  function onProspectChange(e: Event & { currentTarget: HTMLSelectElement }) {
    updateUrl({ prospect: e.currentTarget.value || null });
  }

  function onQueryInput(e: Event) {
    const next = (e.currentTarget as HTMLInputElement).value.trim();
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => updateUrl({ q: next }), 200);
  }

  $effect(() => () => {
    if (debounceTimer) clearTimeout(debounceTimer);
  });

  function previewChatHandler(message: string, history: InquiryChatTurn[]) {
    if (!data.projectId) return Promise.reject(new Error('No project'));
    return sendPreviewChatMessage(
      data.projectId,
      data.selectedProspectId,
      history,
      message,
      fetch,
      token,
    );
  }
</script>

<svelte:head>
  <title>Inquiry preview · LeadAce</title>
  <meta name="robots" content="noindex" />
</svelte:head>

{#if data.result.state === 'invalid'}
  <div class="min-h-screen bg-page">
    <div class="mx-auto max-w-2xl px-6 py-10">
      <a href="/" class="inline-flex items-center gap-1.5 text-xs text-text-muted hover:text-text">
        <Logo size={14} class="text-accent" />
        ← LeadAce
      </a>
      <h1 class="mt-4 text-2xl font-semibold text-text">Preview unavailable</h1>
      <p class="mt-3 text-sm leading-relaxed text-text-secondary">{data.result.message}</p>
    </div>
  </div>
{:else if landing}
  {#if data.prospects.length > 0 || filterQ}
    <div class="border-b border-border bg-surface px-4 py-2">
      <div class="mx-auto flex max-w-2xl items-center gap-2 text-xs text-text-secondary">
        <label for="preview-prospect" class="shrink-0 font-medium text-text">Preview as</label>
        <input
          type="text"
          value={filterQ}
          oninput={onQueryInput}
          placeholder="Search…"
          aria-label="Search prospects"
          class="w-28 shrink-0 rounded border border-border bg-page px-2 py-1 text-xs text-text placeholder:text-text-muted focus:border-text/40 focus:outline-none"
        />
        <select
          id="preview-prospect"
          value={data.selectedProspectId === null ? '' : String(data.selectedProspectId)}
          onchange={onProspectChange}
          class="min-w-0 flex-1 rounded border border-border bg-page px-2 py-1 text-xs text-text focus:border-text/40 focus:outline-none"
        >
          <option value="">Generic recipient (no prospect)</option>
          {#each data.prospects as p (p.prospectId)}
            <option value={String(p.prospectId)}>
              {p.contactName ?? '-'} · {p.organizationName}
            </option>
          {/each}
        </select>
      </div>
    </div>
  {/if}
  <!-- Re-mount on prospect switch so the chat resets (no carry-over history). -->
  {#key data.selectedProspectId}
    <InquiryLandingView {landing} mode="preview" onSendChat={previewChatHandler} />
  {/key}
{/if}
