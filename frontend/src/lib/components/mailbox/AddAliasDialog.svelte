<script lang="ts">
  import { registerGmailAlias } from '$lib/api/sending-identities';
  import Hint from '$lib/components/Hint.svelte';
  import Modal from '$lib/components/Modal.svelte';
  import type { SendingIdentity } from '$lib/types/sending-identity';

  let {
    parents,
    initialParent,
    token,
    onAdded,
    onclose,
  }: {
    // The connected Google accounts an alias can send through.
    parents: SendingIdentity[];
    initialParent: SendingIdentity;
    token: string | undefined;
    onAdded: () => void | Promise<void>;
    onclose: () => void;
  } = $props();

  // svelte-ignore state_referenced_locally
  let parentId = $state(initialParent.identityId);
  let fromEmail = $state('');
  let saving = $state(false);
  let error = $state('');

  async function submit(e: Event) {
    e.preventDefault();
    const email = fromEmail.trim();
    if (!email) {
      error = 'Enter the alias address.';
      return;
    }
    error = '';
    saving = true;
    try {
      await registerGmailAlias({ fromEmail: email, parentIdentityId: parentId }, fetch, token);
      await onAdded();
      onclose();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to add the alias.';
      saving = false;
    }
  }
</script>

<Modal labelledBy="add-alias-title" closable={!saving} {onclose}>
  <form onsubmit={submit}>
    <h3 id="add-alias-title" class="font-display text-lg font-semibold text-text">Add a Send-As alias</h3>
    <p class="mt-2 text-sm text-text-secondary">
      An address your Google account already sends as. It becomes a mailbox of its own, with its own
      warmup and daily cap. Replies land in the parent inbox.
    </p>

    <div class="mt-5 space-y-4">
      <div>
        <label for="alias-parent" class="block text-sm font-medium text-text">Sends through</label>
        <select
          id="alias-parent"
          bind:value={parentId}
          disabled={saving || parents.length === 1}
          class="field mt-1.5"
        >
          {#each parents as p (p.identityId)}
            <option value={p.identityId}>{p.fromEmail}</option>
          {/each}
        </select>
      </div>
      <div>
        <label for="alias-email" class="flex items-center gap-1.5 text-sm font-medium text-text">
          Alias address
          <Hint label="Alias requirements">
            Must already be verified under
            <a
              href="https://mail.google.com/mail/u/0/#settings/accounts"
              target="_blank"
              rel="noopener"
              class="text-accent-strong hover:underline">Gmail → Settings → Accounts and Import → "Send mail as"</a
            >
            with "Treat as an alias" on; Gmail rejects an unverified one at send time. For a separate
            domain, add it to Google Workspace as a secondary domain with its own DKIM key. A
            Workspace domain alias shares your primary domain's reputation and Return-Path.
          </Hint>
        </label>
        <!-- svelte-ignore a11y_autofocus -->
        <input
          id="alias-email"
          type="email"
          autofocus
          placeholder="sales@yourdomain.com"
          bind:value={fromEmail}
          disabled={saving}
          class="field mt-1.5"
        />
      </div>
    </div>

    {#if error}
      <p class="mt-3 text-sm text-danger">{error}</p>
    {/if}

    <div class="mt-6 flex justify-end gap-2">
      <button type="button" onclick={onclose} disabled={saving} class="btn btn-ghost">
        Cancel
      </button>
      <button type="submit" disabled={saving} class="btn btn-primary">
        {saving ? 'Adding…' : 'Add alias'}
      </button>
    </div>
  </form>
</Modal>
