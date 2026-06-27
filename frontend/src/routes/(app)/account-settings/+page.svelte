<script lang="ts">
  import { invalidate } from '$app/navigation';
  import { revokeMcpSession } from '$lib/api/mcp';
  import { connectGmail } from '$lib/gmail-oauth';
  import MailboxWarmupForm from '$lib/components/mailbox/MailboxWarmupForm.svelte';
  import SendingIdentitiesForm from '$lib/components/sending-identity/SendingIdentitiesForm.svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  let token = $derived(data.session?.access_token);
  let supabase = $derived(data.supabase);

  let revokingFamilyId = $state<string | null>(null);
  let mcpSessionMessage = $state('');
  let connectingGmail = $state(false);
  let gmailMessage = $state('');

  // Google OAuth populates user_metadata with avatar_url/picture, full_name,
  // and the verified email. Fall back gracefully if any field is missing
  // (e.g. a non-Google identity).
  let profile = $derived.by(() => {
    const meta = (data.user?.user_metadata ?? {}) as Record<string, unknown>;
    const get = (k: string): string | null => (typeof meta[k] === 'string' ? (meta[k] as string) : null);
    return {
      avatarUrl: get('avatar_url') ?? get('picture'),
      name: get('full_name') ?? get('name') ?? data.user?.email ?? '',
      email: data.user?.email ?? '',
    };
  });

  async function handleConnectGmail() {
    connectingGmail = true;
    gmailMessage = '';
    const err = await connectGmail(supabase);
    if (err) {
      gmailMessage = `Error: ${err}`;
      connectingGmail = false;
    }
  }

  async function handleRevokeMcpSession(familyId: string, displayName: string) {
    revokingFamilyId = familyId;
    mcpSessionMessage = '';
    try {
      await revokeMcpSession(familyId, fetch, token);
      await invalidate('app:mcp-sessions');
      mcpSessionMessage = `Revoked ${displayName}.`;
    } catch (e) {
      mcpSessionMessage = `Error: ${e instanceof Error ? e.message : 'Unknown error'}`;
    } finally {
      revokingFamilyId = null;
    }
  }

  function formatRelativeTime(ts: number): string {
    const diffMs = Date.now() - ts;
    const seconds = Math.round(diffMs / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    if (days < 30) return `${days}d ago`;
    return new Date(ts).toLocaleDateString();
  }
</script>

<svelte:head>
  <title>Account · LeadAce</title>
</svelte:head>

<h2 class="text-lg font-semibold text-text mb-6">Account</h2>

<section class="mb-10">
  <h3 class="text-xs font-medium text-text-muted uppercase tracking-wider mb-4">
    Google account
  </h3>
  <div class="rounded-md border border-border p-5">
    <div class="flex items-center gap-4">
      {#if profile.avatarUrl}
        <img
          src={profile.avatarUrl}
          alt=""
          class="h-12 w-12 rounded-full border border-border"
          referrerpolicy="no-referrer"
        />
      {:else}
        <div
          class="h-12 w-12 rounded-full border border-border bg-surface flex items-center justify-center text-sm text-text-muted"
        >
          {profile.name.charAt(0).toUpperCase()}
        </div>
      {/if}
      <div class="min-w-0">
        <p class="text-sm text-text truncate">{profile.name}</p>
        <p class="text-xs text-text-muted font-mono truncate">{profile.email}</p>
      </div>
    </div>
  </div>
</section>

<section class="mb-10">
  <h3 class="text-xs font-medium text-text-muted uppercase tracking-wider mb-4">
    Gmail permissions
  </h3>
  <div class="rounded-md border border-border p-5">
    {#if data.gmailStatus.state === 'connected'}
      <p class="text-text text-sm">
        Connected as <span class="font-mono">{data.gmailStatus.email}</span>
      </p>
      <p class="text-text-muted text-xs mt-1">
        LeadAce can send email on your behalf and read your Gmail inbox (read-only) to detect and
        classify replies to your outreach. It never modifies or deletes your messages.
      </p>
    {:else if data.gmailStatus.state === 'disconnected'}
      <p class="text-danger text-sm mb-3">Gmail is not connected.</p>
      <p class="text-text-muted text-xs mb-4">
        Outbound email sending is disabled until you grant the gmail.send scope.
      </p>
      <button
        type="button"
        onclick={handleConnectGmail}
        disabled={connectingGmail}
        class="rounded-md border border-border bg-page px-3 py-1.5 text-xs font-medium text-text hover:bg-surface disabled:opacity-50"
      >
        {connectingGmail ? 'Connecting…' : 'Connect Gmail'}
      </button>
    {:else}
      <p class="text-danger text-sm">{data.gmailStatus.message}</p>
    {/if}
    {#if gmailMessage}
      <p class="mt-3 text-xs {gmailMessage.startsWith('Error') ? 'text-danger' : 'text-text-muted'}">
        {gmailMessage}
      </p>
    {/if}
  </div>
</section>

{#if data.sendingIdentities.length > 0}
  <section class="mb-10">
    <h3 class="text-xs font-medium text-text-muted uppercase tracking-wider mb-4">
      Sending warmup
    </h3>
    <div class="space-y-4">
      {#each data.sendingIdentities as identity (identity.identityId)}
        <div class="rounded-md border border-border p-5">
          <p class="mb-3 text-xs font-medium text-text-secondary">
            {identity.provider === 'gmail_oauth' ? 'Connected Gmail' : 'Custom SMTP mailbox'}
          </p>
          <MailboxWarmupForm
            {identity}
            {token}
            onSaved={() => invalidate('app:sending-identities')}
          />
        </div>
      {/each}
    </div>
  </section>
{/if}

<section class="mb-10">
  <h3 class="text-xs font-medium text-text-muted uppercase tracking-wider mb-4">
    Custom sending mailboxes
  </h3>
  <div class="rounded-md border border-border p-5">
    {#if data.sendingIdentitiesError}
      <p class="mb-3 text-xs text-danger">
        Couldn't load your custom mailboxes — the list below may be incomplete. Reload to retry.
      </p>
    {/if}
    <SendingIdentitiesForm
      identities={data.sendingIdentities}
      planTier={data.plan?.plan}
      {token}
      onChanged={() => invalidate('app:sending-identities')}
    />
  </div>
</section>

<section class="mb-10">
  <h3 class="text-xs font-medium text-text-muted uppercase tracking-wider mb-4">
    Connected MCP clients
  </h3>
  <div class="rounded-md border border-border p-5">
    <p class="text-xs text-text-muted mb-4">
      MCP clients (e.g. Claude Code's <span class="font-mono">/leadace</span>) that you've
      authorized to call LeadAce on your behalf. Each entry holds a refresh token with full API
      access — revoke any session you no longer use or trust.
    </p>
    {#if data.mcpSessions.error}
      <p class="text-sm text-danger">{data.mcpSessions.error}</p>
    {:else if data.mcpSessions.sessions.length === 0}
      <p class="text-sm text-text-muted">
        No active MCP sessions. Run <span class="font-mono">/leadace</span> in Claude Code to create
        one.
      </p>
    {:else}
      <ul class="divide-y divide-border -my-3">
        {#each data.mcpSessions.sessions as session (session.familyId)}
          {@const label = session.clientName?.trim() || 'Unnamed MCP client'}
          <li class="flex items-start justify-between gap-4 py-3">
            <div class="min-w-0">
              <p class="text-sm text-text truncate">{label}</p>
              <p class="mt-0.5 text-xs text-text-muted">
                Authorized {formatRelativeTime(session.createdAt)} · last used
                {formatRelativeTime(session.lastSeenAt)}
              </p>
            </div>
            <button
              type="button"
              onclick={() => handleRevokeMcpSession(session.familyId, label)}
              disabled={revokingFamilyId !== null}
              class="shrink-0 rounded border border-border bg-page px-2 py-1 text-xs text-text hover:bg-surface disabled:opacity-50"
            >
              {revokingFamilyId === session.familyId ? 'Revoking…' : 'Revoke'}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
    {#if mcpSessionMessage}
      <p
        class="mt-3 text-xs {mcpSessionMessage.startsWith('Error')
          ? 'text-danger'
          : 'text-text-muted'}"
      >
        {mcpSessionMessage}
      </p>
    {/if}
  </div>
</section>

<div class="mt-12 text-xs text-text-muted">
  <a
    href="/account-settings/delete"
    class="underline hover:text-danger transition-colors"
  >
    Delete account
  </a>
</div>
