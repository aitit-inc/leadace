<script lang="ts">
  import { invalidate } from '$app/navigation';
  import { page } from '$app/state';
  import { revokeMcpSession } from '$lib/api/mcp';
  import Hint from '$lib/components/Hint.svelte';
  import MailboxList from '$lib/components/mailbox/MailboxList.svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  let token = $derived(data.session?.access_token);

  let revokingFamilyId = $state<string | null>(null);
  let mcpSessionMessage = $state('');

  // /auth/google-mailbox/callback lands here with the outcome in the query string.
  const connectedMailbox = page.url.searchParams.get('mailbox_connected');
  const mailboxError = page.url.searchParams.get('mailbox_error');
  const mailboxNotice = connectedMailbox
    ? ({ kind: 'connected', email: connectedMailbox } as const)
    : mailboxError
      ? ({ kind: 'error', message: mailboxError } as const)
      : null;

  // Google OAuth populates user_metadata with avatar_url/picture and full_name;
  // fields may be missing on a non-Google identity, hence the fallbacks.
  let profile = $derived.by(() => {
    const meta = (data.user?.user_metadata ?? {}) as Record<string, unknown>;
    const get = (k: string): string | null => (typeof meta[k] === 'string' ? (meta[k] as string) : null);
    return {
      avatarUrl: get('avatar_url') ?? get('picture'),
      name: get('full_name') ?? get('name') ?? data.user?.email ?? '',
      email: data.user?.email ?? '',
    };
  });

  async function refreshMailboxes() {
    await Promise.all([invalidate('app:sending-identities'), invalidate('app:attention')]);
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
  <h3 class="text-xs font-medium text-text-muted uppercase tracking-wider mb-3">Google account</h3>
  <div class="flex items-center gap-4 rounded-md border border-border px-5 py-4">
    {#if profile.avatarUrl}
      <img
        src={profile.avatarUrl}
        alt=""
        class="h-10 w-10 rounded-full border border-border"
        referrerpolicy="no-referrer"
      />
    {:else}
      <div
        class="h-10 w-10 rounded-full border border-border bg-surface flex items-center justify-center text-sm text-text-muted"
      >
        {profile.name.charAt(0).toUpperCase()}
      </div>
    {/if}
    <div class="min-w-0">
      <p class="text-sm text-text truncate">{profile.name}</p>
      <p class="text-xs text-text-muted font-mono truncate">{profile.email}</p>
    </div>
  </div>
</section>

<section class="mb-10">
  <MailboxList
    identities={data.sendingIdentities}
    identitiesError={data.sendingIdentitiesError}
    gmailStatus={data.gmailStatus}
    planTier={data.plan?.plan}
    session={data.session}
    supabase={data.supabase}
    notice={mailboxNotice}
    onChanged={refreshMailboxes}
  />
</section>

<section class="mb-10">
  <div class="mb-3 flex items-center gap-1.5">
    <h3 class="text-xs font-medium text-text-muted uppercase tracking-wider">Connected MCP clients</h3>
    <Hint label="About MCP clients">
      Tools you authorized to act on LeadAce for you, such as Claude Code's
      <span class="font-mono">/leadace</span>. Each holds a token with full API access. Revoke any
      you no longer use or trust; running <span class="font-mono">/leadace</span> again creates a
      new one.
    </Hint>
  </div>
  <div class="rounded-md border border-border">
    {#if data.mcpSessions.error}
      <p class="px-4 py-3 text-sm text-danger">{data.mcpSessions.error}</p>
    {:else if data.mcpSessions.sessions.length === 0}
      <p class="px-4 py-3 text-sm text-text-muted">
        No active MCP sessions. Run <span class="font-mono">/leadace</span> in Claude Code to create
        one.
      </p>
    {:else}
      <ul class="divide-y divide-border">
        {#each data.mcpSessions.sessions as session (session.familyId)}
          {@const label = session.clientName?.trim() || 'Unnamed MCP client'}
          <li class="flex items-center justify-between gap-4 px-4 py-3">
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
  </div>
  {#if mcpSessionMessage}
    <p class="mt-2 text-xs {mcpSessionMessage.startsWith('Error') ? 'text-danger' : 'text-text-muted'}">
      {mcpSessionMessage}
    </p>
  {/if}
</section>

<div class="mt-12 text-xs text-text-muted">
  <a href="/account-settings/delete" class="underline hover:text-danger transition-colors">
    Delete account
  </a>
</div>
