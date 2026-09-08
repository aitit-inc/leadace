<script lang="ts">
  import { BadgeCheck } from '@lucide/svelte';
  import { ApiError } from '$lib/api';
  import { updateWorkspaceSettings } from '$lib/api/workspace-settings';
  import { SUPPORTED_COUNTRIES } from '$lib/countries';

  export type SenderIdentityProposal = {
    callId: string | null;
    legalName: string | null;
    postalAddress: string | null;
    senderCountry: string | null;
  };

  let {
    proposal,
    token,
    onsaved,
  }: { proposal: SenderIdentityProposal; token: string; onsaved: () => void } = $props();

  // svelte-ignore state_referenced_locally
  let legalName = $state(proposal.legalName ?? '');
  // svelte-ignore state_referenced_locally
  let physicalAddress = $state(proposal.postalAddress ?? '');
  // svelte-ignore state_referenced_locally
  let defaultSenderCountry = $state<string | null>(
    SUPPORTED_COUNTRIES.some((c) => c.code === proposal.senderCountry) ? proposal.senderCountry : null,
  );
  let saving = $state(false);
  let error = $state('');

  let complete = $derived(legalName.trim().length > 0 && physicalAddress.trim().length >= 5 && defaultSenderCountry !== null);

  async function save() {
    if (!complete || saving) return;
    saving = true;
    error = '';
    try {
      await updateWorkspaceSettings(
        { legalName: legalName.trim(), physicalAddress: physicalAddress.trim(), defaultSenderCountry },
        fetch,
        token,
      );
      onsaved();
    } catch (e) {
      error = e instanceof ApiError ? e.detail || e.message : 'Could not save. Please try again.';
    } finally {
      saving = false;
    }
  }
</script>

<form
  class="my-2 max-w-[85%] space-y-2 rounded border border-accent/50 bg-accent/10 px-3 py-2 text-xs"
  onsubmit={(e) => {
    e.preventDefault();
    void save();
  }}
>
  <div class="flex items-center gap-2 text-text">
    <BadgeCheck size={14} class="text-accent" />
    <span class="font-medium">Confirm your sender identity</span>
  </div>
  <p class="text-text-muted">
    Every email's footer carries this by law. Ace filled in what your site shows; fix anything that is off.
  </p>
  <label class="block space-y-1">
    <span class="font-medium text-text">Legal name</span>
    <input
      type="text"
      maxlength="200"
      bind:value={legalName}
      disabled={saving}
      class="block w-full rounded border border-border bg-page px-2 py-1 text-sm text-text focus:border-accent focus:outline-none"
    />
  </label>
  <label class="block space-y-1">
    <span class="font-medium text-text">Postal address</span>
    <textarea
      rows={2}
      maxlength="500"
      bind:value={physicalAddress}
      disabled={saving}
      class="block w-full resize-none rounded border border-border bg-page px-2 py-1 text-sm text-text focus:border-accent focus:outline-none"
    ></textarea>
  </label>
  <label class="block space-y-1">
    <span class="font-medium text-text">Sender country</span>
    <select
      bind:value={defaultSenderCountry}
      disabled={saving}
      class="block w-full rounded border border-border bg-page px-2 py-1 text-sm text-text focus:border-accent focus:outline-none"
    >
      <option value={null}>— Select —</option>
      {#each SUPPORTED_COUNTRIES as { code, label } (code)}
        <option value={code}>{label}</option>
      {/each}
    </select>
  </label>
  {#if error}
    <p class="text-danger">{error}</p>
  {/if}
  <div class="flex items-center gap-2">
    <button
      type="submit"
      disabled={!complete || saving}
      class="rounded bg-accent px-3 py-1 font-medium text-page hover:bg-accent-strong disabled:opacity-50"
    >
      {saving ? 'Saving…' : 'Save and continue'}
    </button>
    <a href="/workspace-settings" class="text-text-muted underline hover:text-text">More options</a>
  </div>
</form>
