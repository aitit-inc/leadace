<script lang="ts">
  import type { SupabaseClient } from '@supabase/supabase-js';
  import { Mail } from '@lucide/svelte';
  import { connectGmail, connectGoogleMailbox } from '$lib/gmail-oauth';
  import { orderMailboxes } from '$lib/mailbox-status';
  import Hint from '$lib/components/Hint.svelte';
  import AddAliasDialog from './AddAliasDialog.svelte';
  import AddMailboxMenu from './AddMailboxMenu.svelte';
  import AddSmtpDialog from './AddSmtpDialog.svelte';
  import MailboxRow from './MailboxRow.svelte';
  import type { GmailStatus } from '$lib/types/auth-google';
  import type { PlanTier } from '$lib/types/plan';
  import type { SendingIdentity } from '$lib/types/sending-identity';

  let {
    identities,
    identitiesError,
    gmailStatus,
    planTier,
    session,
    supabase,
    notice,
    onChanged,
  }: {
    identities: SendingIdentity[];
    identitiesError: boolean;
    gmailStatus: GmailStatus;
    planTier: PlanTier | undefined;
    session: { access_token: string; user: { id: string } } | null;
    supabase: SupabaseClient;
    // Outcome of a Google connection the callback landed here with.
    notice: { kind: 'connected'; email: string } | { kind: 'error'; message: string } | null;
    onChanged: () => void | Promise<void>;
  } = $props();

  let token = $derived(session?.access_token);
  let rows = $derived(orderMailboxes(identities));
  let googles = $derived(identities.filter((i) => i.kind === 'gmail'));
  let hasSignIn = $derived(identities.some((i) => i.signInAccount));

  let dialog = $state<{ kind: 'alias'; parent: SendingIdentity } | { kind: 'smtp' } | null>(null);
  let connecting = $state(false);
  let connectError = $state('');

  // A started redirect navigates away, so only a failure returns — on success
  // `connecting` is left set on purpose.
  async function connect(start: () => Promise<string | null>) {
    connecting = true;
    connectError = '';
    const err = await start();
    if (err) {
      connectError = err;
      connecting = false;
    }
  }

  const connectSignIn = () => connect(() => connectGmail(supabase));
  const connectGoogle = () => connect(() => connectGoogleMailbox(session));

  function openAlias(parent?: SendingIdentity) {
    const p = parent ?? googles.find((g) => g.signInAccount) ?? googles[0];
    if (p) dialog = { kind: 'alias', parent: p };
  }
</script>

<div class="mb-3 flex flex-wrap items-center justify-between gap-3">
  <div class="flex items-center gap-1.5">
    <h3 class="text-xs font-medium uppercase tracking-wider text-text-muted">Mailboxes</h3>
    <Hint label="About mailboxes">
      LeadAce sends outreach from these mailboxes and reads their inboxes (read-only) for replies.
      It never changes or deletes your mail. Each mailbox has its own warmup and daily cap. Choose
      which ones a project sends from in that project's Settings.
    </Hint>
  </div>
  <AddMailboxMenu
    freeBlocked={planTier === 'free'}
    hasGoogle={googles.length > 0}
    {connecting}
    onGoogle={connectGoogle}
    onAlias={() => openAlias()}
    onSmtp={() => (dialog = { kind: 'smtp' })}
  />
</div>

{#if notice?.kind === 'connected'}
  <p class="mb-3 text-xs text-text-muted">Connected <span class="font-mono">{notice.email}</span>.</p>
{:else if notice?.kind === 'error'}
  <p class="mb-3 text-xs text-danger">{notice.message}</p>
{/if}
{#if identitiesError}
  <p class="mb-3 text-xs text-danger">
    Couldn't load your mailboxes — the list may be incomplete. Reload to retry.
  </p>
{/if}
{#if gmailStatus.state === 'error'}
  <p class="mb-3 text-xs text-danger">{gmailStatus.message}</p>
{/if}
{#if connectError}
  <p class="mb-3 text-xs text-danger">{connectError}</p>
{/if}

<div class="rounded-md border border-border">
  {#if !hasSignIn}
    <div class="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div class="flex min-w-0 items-center gap-3">
        <span class="text-text-muted"><Mail size={16} /></span>
        <div class="min-w-0">
          <p class="truncate font-mono text-sm font-medium text-text">
            {gmailStatus.state === 'revoked' ? gmailStatus.email : 'Sign-in Google account'}
          </p>
          <p class="mt-1 text-[11px] text-danger">
            {gmailStatus.state === 'revoked' ? 'Access revoked' : 'Not connected'} · sending is off
            until you connect it
          </p>
        </div>
      </div>
      <button
        type="button"
        onclick={connectSignIn}
        disabled={connecting}
        class="rounded border border-border bg-page px-3 py-1.5 text-xs font-medium text-text hover:bg-surface disabled:opacity-50"
      >
        {connecting ? 'Connecting…' : gmailStatus.state === 'revoked' ? 'Reconnect' : 'Connect Gmail'}
      </button>
    </div>
  {/if}
  {#each rows as identity (identity.identityId)}
    <MailboxRow
      {identity}
      {identities}
      revoked={identity.signInAccount && gmailStatus.state === 'revoked'}
      freeBlocked={planTier === 'free'}
      {session}
      {onChanged}
      onReconnectSignIn={connectSignIn}
      onAddAlias={openAlias}
    />
  {/each}
</div>

{#if dialog?.kind === 'alias'}
  <AddAliasDialog
    parents={googles}
    initialParent={dialog.parent}
    {token}
    onAdded={onChanged}
    onclose={() => (dialog = null)}
  />
{:else if dialog?.kind === 'smtp'}
  <AddSmtpDialog {token} onAdded={onChanged} onclose={() => (dialog = null)} />
{/if}
