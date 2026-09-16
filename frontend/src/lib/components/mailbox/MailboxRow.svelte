<script lang="ts">
  import { ChevronDown, CornerDownRight, Mail, Server } from '@lucide/svelte';
  import { deleteSendingIdentity } from '$lib/api/sending-identities';
  import { connectGoogleMailbox } from '$lib/gmail-oauth';
  import { kindLabel, mailboxState, warmupLabel } from '$lib/mailbox-status';
  import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
  import Hint from '$lib/components/Hint.svelte';
  import MailboxWarmupForm from './MailboxWarmupForm.svelte';
  import type { SendingIdentity } from '$lib/types/sending-identity';

  let {
    identity,
    identities,
    freeBlocked,
    session,
    onChanged,
    onReconnectSignIn,
    onAddAlias,
  }: {
    identity: SendingIdentity;
    identities: SendingIdentity[];
    freeBlocked: boolean;
    session: { access_token: string; user: { id: string } } | null;
    onChanged: () => void | Promise<void>;
    onReconnectSignIn: () => void | Promise<void>;
    onAddAlias: (parent: SendingIdentity) => void;
  } = $props();

  let token = $derived(session?.access_token);
  let parent = $derived(identities.find((i) => i.identityId === identity.parentIdentityId));
  let aliases = $derived(identities.filter((i) => i.parentIdentityId === identity.identityId));
  let revoked = $derived(identity.revokedSince !== null);
  // An alias sends through its parent's grant, so it is the parent that reconnects.
  let account = $derived(parent ?? identity);
  let status = $derived(mailboxState(identity));
  let isAlias = $derived(identity.kind === 'gmail_alias');

  // A row that needs action opens on load so the fix is one click away.
  // svelte-ignore state_referenced_locally
  let open = $state(status.tone === 'danger');
  let confirmRemove = $state(false);
  let removing = $state(false);
  let connecting = $state(false);
  let actionError = $state('');

  const TONE: Record<typeof status.tone, string> = {
    ok: 'bg-inbound/10 text-inbound',
    warning: 'bg-warning/15 text-warning',
    danger: 'bg-danger/10 text-danger',
  };

  async function reconnect() {
    connecting = true;
    actionError = '';
    if (account.signInAccount) {
      await onReconnectSignIn();
      connecting = false;
      return;
    }
    const err = await connectGoogleMailbox(session, account.fromEmail);
    if (err) {
      actionError = err;
      connecting = false;
    }
  }

  async function remove() {
    confirmRemove = false;
    removing = true;
    actionError = '';
    try {
      await deleteSendingIdentity(identity.identityId, fetch, token);
      await onChanged();
    } catch (e) {
      actionError = e instanceof Error ? e.message : `Failed to remove ${identity.fromEmail}.`;
    } finally {
      removing = false;
    }
  }
</script>

<div class="border-t border-border first:border-t-0">
  <button
    type="button"
    onclick={() => (open = !open)}
    aria-expanded={open}
    class="grid w-full grid-cols-[1.25rem_minmax(0,1fr)_auto_1rem] items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-surface-2/60 {open
      ? 'bg-surface-2/60'
      : ''} {isAlias ? 'pl-11' : ''}"
  >
    <span class="text-text-muted">
      {#if isAlias}
        <CornerDownRight size={16} />
      {:else if identity.kind === 'smtp'}
        <Server size={16} />
      {:else}
        <Mail size={16} />
      {/if}
    </span>
    <span class="min-w-0">
      <span class="block truncate text-sm font-semibold text-text">{identity.fromEmail}</span>
      <span class="mt-1 flex flex-wrap items-center gap-1.5">
        <span class="chip bg-surface-2 text-text-secondary">
          {kindLabel(identity, parent)}
        </span>
        <span class="chip {TONE[status.tone]}">
          <span class="h-1.5 w-1.5 rounded-full bg-current"></span>
          {status.label}
        </span>
      </span>
    </span>
    <span class="text-right text-sm tabular-nums text-text-secondary">
      <span class="font-semibold text-text">{identity.used}</span> / {identity.cap} today
      <span class="block text-xs text-text-muted">{warmupLabel(identity)}</span>
    </span>
    <span class="text-text-muted transition-transform duration-200 ease-spring {open ? 'rotate-180' : ''}">
      <ChevronDown size={16} />
    </span>
  </button>

  {#if open}
    <div class="border-t border-dashed border-border px-5 pb-4 pt-4 {isAlias ? 'md:pl-19' : 'md:pl-13'}">
      <div class="grid gap-5 md:grid-cols-2 md:gap-x-8">
        <dl class="grid grid-cols-[auto_1fr] content-start gap-x-4 gap-y-1.5 text-sm tabular-nums">
          <dt class="text-text-muted">Today</dt>
          <dd class="text-text">{identity.used} sent · {identity.remaining} left</dd>
          <dt class="flex items-center gap-1.5 text-text-muted">
            Daily cap
            <Hint label="About the daily cap">
              A per-mailbox safety cap that protects the sending domain's reputation. It is separate
              from your plan's outreach quota. A new mailbox starts low and ramps up to
              {identity.steadyStatePerDay}/day over {identity.rampWeeks} weeks.
            </Hint>
          </dt>
          <dd class="text-text">
            {#if identity.dailyCapOverride !== null}
              Fixed at {identity.dailyCapOverride}/day
            {:else if identity.rampWeek >= identity.rampWeeks && identity.warmupStartedAt}
              {identity.cap}/day
            {:else}
              {identity.cap} → {identity.steadyStatePerDay}/day after warmup
            {/if}
          </dd>
          <dt class="flex items-center gap-1.5 text-text-muted">
            Bounces, {identity.bounceWindowDays} days
            <Hint label="About bounces">
              Only bounces that thread back to a sent message are counted, so this is a lower bound.
              If it climbs, review your list sources or pause the mailbox.
            </Hint>
          </dt>
          <dd class="text-text">
            {#if identity.sentInWindow === 0}
              No threadable sends yet
            {:else}
              {identity.bounced} of {identity.sentInWindow} ({identity.bounceRate}%)
            {/if}
          </dd>
          {#if identity.smtp}
            <dt class="text-text-muted">Server</dt>
            <dd class="font-mono text-text">
              {identity.smtp.smtpHost}:{identity.smtp.smtpPort} · {identity.smtp.imapHost}:{identity.smtp.imapPort}
            </dd>
            <dt class="text-text-muted">Username</dt>
            <dd class="font-mono text-text">{identity.smtp.username}</dd>
          {/if}
          {#if parent}
            <dt class="text-text-muted">Replies</dt>
            <dd class="text-text">Land in {parent.fromEmail}</dd>
          {/if}
          <dt class="text-text-muted">Projects</dt>
          <dd class="text-text">
            {#if identity.projects.length === 0}
              <span class="text-text-muted">No project sends from it</span>
            {:else}
              {identity.projects.join(', ')}
            {/if}
          </dd>
          {#if identity.kind === 'gmail' && aliases.length > 0}
            <dt class="text-text-muted">Aliases</dt>
            <dd class="text-text">{aliases.map((a) => a.fromEmail).join(', ')}</dd>
          {/if}
          {#if identity.pausedUntil}
            <dt class="text-text-muted">Paused until</dt>
            <dd class="text-text">{new Date(identity.pausedUntil).toLocaleString()}</dd>
          {/if}
          <dt class="text-text-muted">{identity.kind === 'smtp' ? 'Added' : 'Connected'}</dt>
          <dd class="text-text">{new Date(identity.grantedAt).toLocaleDateString()}</dd>
        </dl>

        <MailboxWarmupForm {identity} {token} onSaved={onChanged} />
      </div>

      <div class="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        <div class="flex flex-wrap items-center gap-2">
          {#if identity.kind === 'gmail' || (isAlias && revoked)}
            <button
              type="button"
              onclick={reconnect}
              disabled={connecting}
              class="btn btn-sm {revoked ? 'btn-primary' : 'btn-secondary'}"
            >
              {connecting ? 'Connecting…' : isAlias ? `Reconnect ${account.fromEmail}` : 'Reconnect'}
            </button>
          {/if}
          {#if identity.kind === 'gmail'}
            <button
              type="button"
              onclick={() => onAddAlias(identity)}
              disabled={freeBlocked}
              title={freeBlocked ? 'Paid plan required' : undefined}
              class="btn btn-ghost btn-sm"
            >
              + Add alias
            </button>
          {/if}
          {#if actionError}
            <span class="text-sm text-danger">{actionError}</span>
          {/if}
        </div>
        {#if !identity.signInAccount}
          <button
            type="button"
            onclick={() => (confirmRemove = true)}
            disabled={removing}
            class="btn btn-danger-ghost btn-sm"
          >
            {removing ? 'Removing…' : isAlias ? 'Remove alias' : 'Remove mailbox'}
          </button>
        {/if}
      </div>
    </div>
  {/if}
</div>

{#if confirmRemove}
  <ConfirmDialog
    title="Remove {identity.fromEmail}?"
    message={aliases.length > 0
      ? `Its ${aliases.length} ${aliases.length === 1 ? 'alias goes' : 'aliases go'} with it. A mailbox a project still lists can't be removed.`
      : "A mailbox a project still lists can't be removed."}
    confirmLabel="Remove"
    danger
    onconfirm={remove}
    oncancel={() => (confirmRemove = false)}
  />
{/if}
