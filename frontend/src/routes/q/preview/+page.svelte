<script lang="ts">
  import { goto } from '$app/navigation';
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

  function onProspectChange(e: Event & { currentTarget: HTMLSelectElement }) {
    if (!data.projectId) return;
    const value = e.currentTarget.value;
    const params = new URLSearchParams({ project: data.projectId });
    if (value) params.set('prospect', value);
    void goto(`?${params}`, { replaceState: true, keepFocus: true, noScroll: true });
  }

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
  {#if data.prospects.length > 0}
    <div class="border-b border-border bg-surface px-4 py-2">
      <div class="mx-auto flex max-w-2xl items-center gap-2 text-xs text-text-secondary">
        <label for="preview-prospect" class="shrink-0 font-medium text-text">Preview as</label>
        <select
          id="preview-prospect"
          value={data.selectedProspectId === null ? '' : String(data.selectedProspectId)}
          onchange={onProspectChange}
          class="min-w-0 flex-1 rounded border border-border bg-page px-2 py-1 text-xs text-text focus:border-text/40 focus:outline-none"
        >
          <option value="">Generic recipient (no prospect)</option>
          {#each data.prospects as p (p.prospectId)}
            <option value={String(p.prospectId)}>
              {p.contactName ?? 'No contact name'} · {p.organizationName}
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
