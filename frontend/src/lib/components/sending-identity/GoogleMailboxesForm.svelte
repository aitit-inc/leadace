<script lang="ts">
  import { connectGoogleMailbox } from '$lib/gmail-oauth';
  import { deleteSendingIdentity } from '$lib/api/sending-identities';
  import GmailAliasesForm from './GmailAliasesForm.svelte';
  import type { SendingIdentity } from '$lib/types/sending-identity';
  import type { PlanTier } from '$lib/types/plan';

  let {
    identities,
    planTier,
    session,
    onChanged,
  }: {
    identities: SendingIdentity[];
    planTier: PlanTier | undefined;
    session: { access_token: string; user: { id: string } } | null;
    onChanged: () => void | Promise<void>;
  } = $props();
  let token = $derived(session?.access_token);

  // The sign-in Gmail has its own section above; these are the other Google accounts.
  let mailboxes = $derived(identities.filter((i) => i.kind === 'gmail' && !i.signInAccount));
  let freeBlocked = $derived(planTier === 'free');

  let connecting = $state<string | null>(null);
  let connectError = $state('');
  let deletingId = $state<string | null>(null);
  let listError = $state('');

  async function connect(loginHint?: string) {
    connecting = loginHint ?? 'new';
    connectError = '';
    const err = await connectGoogleMailbox(session, loginHint);
    if (err) {
      connectError = err;
      connecting = null;
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

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString();
  }
</script>

<p class="text-sm text-text">
  Connect any Google account — a Google Workspace mailbox on another domain, a second Gmail — as a
  mailbox of its own. LeadAce sends from it and reads its inbox (read-only) for replies, the same
  way as your sign-in account. Assign it to a project in its Project settings.
</p>

{#if mailboxes.length > 0}
  <ul class="mt-4 space-y-4">
    {#each mailboxes as m (m.identityId)}
      <li class="rounded-md border border-border p-4">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="truncate font-mono text-sm text-text">{m.fromEmail}</p>
            <p class="mt-0.5 text-xs text-text-muted">Connected {formatDate(m.grantedAt)}</p>
          </div>
          <div class="flex shrink-0 gap-2">
            <button
              type="button"
              onclick={() => connect(m.fromEmail)}
              disabled={connecting !== null}
              class="rounded border border-border bg-page px-2 py-1 text-xs text-text hover:bg-surface disabled:opacity-50"
            >
              {connecting === m.fromEmail ? 'Connecting…' : 'Reconnect'}
            </button>
            <button
              type="button"
              onclick={() => remove(m.identityId, m.fromEmail)}
              disabled={deletingId !== null}
              class="rounded border border-border bg-page px-2 py-1 text-xs text-text hover:bg-surface disabled:opacity-50"
            >
              {deletingId === m.identityId ? 'Removing…' : 'Remove'}
            </button>
          </div>
        </div>
        <GmailAliasesForm parent={m} {identities} {planTier} {token} {onChanged} />
      </li>
    {/each}
  </ul>
  {#if listError}
    <p class="mt-2 text-xs text-danger">{listError}</p>
  {/if}
{/if}

{#if freeBlocked}
  <p class="mt-4 rounded border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
    Additional sending mailboxes require a paid plan. Upgrade to Starter or higher to connect another
    Google account.
  </p>
{:else}
  <div class="mt-4 flex flex-wrap items-center gap-2">
    <button
      type="button"
      onclick={() => connect()}
      disabled={connecting !== null}
      class="rounded bg-accent px-3 py-1.5 text-xs font-medium text-page transition-colors hover:bg-accent-strong disabled:opacity-50"
    >
      {connecting === 'new' ? 'Connecting…' : 'Connect a Google account'}
    </button>
    {#if connectError}
      <span class="text-xs text-danger">{connectError}</span>
    {/if}
  </div>
{/if}
