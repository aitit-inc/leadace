<script lang="ts">
  import { registerGmailAlias, deleteSendingIdentity } from '$lib/api/sending-identities';
  import type { SendingIdentity } from '$lib/types/sending-identity';
  import type { PlanTier } from '$lib/types/plan';

  let {
    identities,
    planTier,
    token,
    onChanged,
  }: {
    identities: SendingIdentity[];
    planTier: PlanTier | undefined;
    token: string | undefined;
    onChanged: () => void | Promise<void>;
  } = $props();

  let aliases = $derived(identities.filter((i) => i.kind === 'gmail_alias'));
  let freeBlocked = $derived(planTier === 'free');

  let fromEmail = $state('');
  let saving = $state(false);
  let addMessage = $state('');
  let addError = $state('');
  let deletingId = $state<string | null>(null);
  let listError = $state('');

  async function add() {
    const email = fromEmail.trim();
    if (!email) {
      addError = 'Enter the alias address.';
      return;
    }
    addError = '';
    addMessage = '';
    saving = true;
    try {
      await registerGmailAlias({ fromEmail: email }, fetch, token);
      fromEmail = '';
      await onChanged();
      addMessage = 'Alias added.';
    } catch (e) {
      addError = e instanceof Error ? e.message : 'Failed to add the alias.';
    } finally {
      saving = false;
    }
  }

  async function remove(identityId: string, email: string) {
    deletingId = identityId;
    listError = '';
    try {
      await deleteSendingIdentity(identityId, fetch, token);
      await onChanged();
    } catch (e) {
      listError = e instanceof Error ? e.message : `Failed to remove ${email}.`;
    } finally {
      deletingId = null;
    }
  }
</script>

<div class="mt-5 border-t border-border pt-4">
  <p class="text-xs font-medium text-text-secondary">Send-As aliases</p>
  <p class="mt-1 text-xs text-text-muted">
    Each alias is a mailbox of its own — its own From: address, warmup and daily cap — sending
    through this Gmail connection. Replies land in this inbox. Assign aliases to a project in its
    Project settings.
  </p>

  {#if aliases.length > 0}
    <ul class="mt-3 divide-y divide-border">
      {#each aliases as a (a.identityId)}
        <li class="flex items-center justify-between gap-4 py-2">
          <p class="truncate font-mono text-sm text-text">{a.fromEmail}</p>
          <button
            type="button"
            onclick={() => remove(a.identityId, a.fromEmail)}
            disabled={deletingId !== null}
            class="shrink-0 rounded border border-border bg-page px-2 py-1 text-xs text-text hover:bg-surface disabled:opacity-50"
          >
            {deletingId === a.identityId ? 'Removing…' : 'Remove'}
          </button>
        </li>
      {/each}
    </ul>
    {#if listError}
      <p class="mt-2 text-xs text-danger">{listError}</p>
    {/if}
  {/if}

  {#if freeBlocked}
    <p class="mt-3 rounded border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
      Additional sending mailboxes require a paid plan. Upgrade to Starter or higher to add an alias.
    </p>
  {:else}
    <div class="mt-3 flex flex-wrap items-center gap-2">
      <input
        type="email"
        aria-label="Alias address"
        placeholder="sales@yourdomain.com"
        bind:value={fromEmail}
        disabled={saving}
        class="w-full max-w-sm rounded border border-border bg-page px-2 py-1.5 font-mono text-sm text-text disabled:opacity-50"
      />
      <button
        type="button"
        onclick={add}
        disabled={saving}
        class="rounded bg-accent px-3 py-1.5 text-xs font-medium text-page transition-colors hover:bg-accent-strong disabled:opacity-50"
      >
        {saving ? 'Adding…' : 'Add alias'}
      </button>
      {#if addMessage}
        <span class="text-xs text-text-muted">{addMessage}</span>
      {/if}
      {#if addError}
        <span class="text-xs text-danger">{addError}</span>
      {/if}
    </div>
    <p class="mt-2 text-xs text-text-muted">
      The address must already be verified under
      <a
        href="https://mail.google.com/mail/u/0/#settings/accounts"
        target="_blank"
        rel="noopener"
        class="underline hover:text-text">Gmail → Settings → Accounts and Import → "Send mail as"</a
      >
      with "Treat as an alias" on; Gmail rejects an unverified one at send time. To send from a
      separate domain, add it to Google Workspace as a <em>secondary domain</em> with its own DKIM
      key — a Workspace <em>domain alias</em> shares your primary domain's reputation and
      Return-Path, so it does not separate deliverability.
    </p>
  {/if}
</div>
