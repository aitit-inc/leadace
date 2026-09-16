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
  class="card my-3 max-w-2xl space-y-4 p-5 ring-1 ring-accent/50"
  onsubmit={(e) => {
    e.preventDefault();
    void save();
  }}
>
  <div class="flex items-start gap-3">
    <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent-strong">
      <BadgeCheck size={18} />
    </span>
    <div class="min-w-0">
      <h3 class="font-display text-lg font-semibold leading-snug text-text">Confirm your sender identity</h3>
      <p class="mt-0.5 text-sm text-text-secondary">
        Every email's footer carries this by law. Ace filled in what your site shows; fix anything that is off.
      </p>
    </div>
  </div>
  <label class="block space-y-1.5">
    <span class="text-sm font-medium text-text">Legal name</span>
    <input type="text" maxlength="200" bind:value={legalName} disabled={saving} class="field" />
  </label>
  <label class="block space-y-1.5">
    <span class="text-sm font-medium text-text">Postal address</span>
    <textarea rows={2} maxlength="500" bind:value={physicalAddress} disabled={saving} class="field resize-none"></textarea>
  </label>
  <label class="block space-y-1.5">
    <span class="text-sm font-medium text-text">Sender country</span>
    <select
      bind:value={defaultSenderCountry}
      disabled={saving}
      class="field"
    >
      <option value={null}>— Select —</option>
      {#each SUPPORTED_COUNTRIES as { code, label } (code)}
        <option value={code}>{label}</option>
      {/each}
    </select>
  </label>
  {#if error}
    <p class="text-sm text-danger">{error}</p>
  {/if}
  <button type="submit" disabled={!complete || saving} class="btn btn-primary">
    {saving ? 'Saving…' : 'Save and continue'}
  </button>
</form>
