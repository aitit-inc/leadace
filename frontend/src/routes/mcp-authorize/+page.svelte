<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { finalizeMcpAuthorize, getMcpAuthorizeSession } from '$lib/api/mcp';
  import Logo from '$lib/components/Logo.svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  let session = $derived(data.session);
  let user = $derived(data.user);

  type Status = 'loading' | 'ready' | 'submitting' | 'success' | 'error';
  let status = $state<Status>('loading');
  let errorMessage = $state('');
  let clientName = $state<string | null>(null);
  let redirectUri = $state('');
  let sessionState = $state('');
  let finalRedirect = $state('');
  let copied = $state(false);

  let sessionId = $derived(page.url.searchParams.get('session') ?? '');

  // Third-layer guard against a same-origin script-execution sink (the
  // server registers + validates schemes at /register and again at
  // /authorize, but the auth code is delivered by assigning the URL to
  // window.location.href — if either upstream layer regresses we don't
  // want javascript: / data: / file: to execute in the user's session).
  function isSafeRedirectScheme(uri: string): boolean {
    try {
      const proto = new URL(uri).protocol;
      return proto === 'http:' || proto === 'https:';
    } catch {
      return false;
    }
  }

  $effect(() => {
    if (status !== 'loading') return;
    if (!sessionId) {
      errorMessage = 'Missing session parameter. Run /setup again to start a fresh authorization.';
      status = 'error';
      return;
    }
    void loadSessionInfo();
  });

  async function loadSessionInfo() {
    try {
      const data = await getMcpAuthorizeSession(sessionId, fetch);
      clientName = data.clientName;
      redirectUri = data.redirectUri;
      sessionState = data.state;
      status = 'ready';
    } catch (e) {
      errorMessage = e instanceof Error ? e.message : 'Failed to load authorization request.';
      status = 'error';
    }
  }

  async function handleApprove() {
    status = 'submitting';
    errorMessage = '';
    const accessToken = session?.access_token;
    if (!accessToken) {
      errorMessage = 'You appear to be signed out. Please sign in and retry.';
      status = 'error';
      return;
    }
    try {
      const body = await finalizeMcpAuthorize(sessionId, accessToken, fetch);
      if (!isSafeRedirectScheme(body.redirect)) {
        throw new Error('Authorization server returned an unsafe redirect URL.');
      }
      finalRedirect = body.redirect;
      status = 'success';
      // Auto-navigate after a short pause so the user can see the success
      // screen and copy the URL if Claude Code's loopback handler doesn't
      // catch it (e.g. when the CLI prompts for a manual paste fallback).
      setTimeout(() => {
        window.location.href = finalRedirect;
      }, 1500);
    } catch (e) {
      errorMessage = e instanceof Error ? e.message : 'Failed to authorize.';
      status = 'error';
    }
  }

  function handleDeny() {
    if (redirectUri && isSafeRedirectScheme(redirectUri)) {
      try {
        const url = new URL(redirectUri);
        url.searchParams.set('error', 'access_denied');
        if (sessionState) url.searchParams.set('state', sessionState);
        window.location.href = url.toString();
        return;
      } catch { /* invalid redirect_uri — go home below */ }
    }
    goto('/');
  }

  let copiedTimer: ReturnType<typeof setTimeout> | null = null;

  async function copyRedirect() {
    try {
      await navigator.clipboard.writeText(finalRedirect);
      copied = true;
      if (copiedTimer) clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => (copied = false), 2000);
    } catch {
      // Clipboard API unavailable — user can still select & copy manually.
    }
  }

  $effect(() => () => {
    if (copiedTimer) clearTimeout(copiedTimer);
  });

  // Don't fall back to a vendor name when the registered client_name is
  // empty — that turns the consent UI into a phishing surface where any
  // anonymous DCR registration inherits a trusted brand label. Anonymous /
  // unnamed clients are surfaced as such.
  let displayClient = $derived(clientName?.trim() || 'an unverified MCP client');

  // The redirect host is the receiver of the authorization code, so it
  // must be visible in the consent UI even when redirect_uri allow-listing
  // is intact — anyone can register an MCP client via DCR (open by spec),
  // and the brand label alone cannot tell the user where their code is
  // being shipped. Show host only, not the full URL: query strings and
  // paths are noise here, and the host is what matters for "should I trust
  // this destination".
  let redirectHost = $derived.by(() => {
    if (!redirectUri) return '';
    try {
      return new URL(redirectUri).host;
    } catch {
      return redirectUri;
    }
  });
</script>

<div class="flex min-h-screen items-center justify-center bg-page">
  <div class="w-full max-w-sm px-6">
    <div class="mb-1 flex items-center gap-2.5">
      <Logo size={32} class="text-accent" />
      <h1 class="font-mono text-2xl font-semibold text-text">LeadAce</h1>
    </div>

    {#if status === 'loading'}
      <p class="mt-8 font-mono text-sm text-text-muted">Loading authorization request…</p>
    {:else if status === 'error'}
      <p class="text-text-muted text-sm mb-2">Authorization error</p>
      <p class="text-danger text-sm mb-6">{errorMessage}</p>
      <a href="/" class="text-text-muted hover:text-text text-xs underline">Back to LeadAce</a>
    {:else if status === 'success'}
      <p class="text-text-muted text-sm mb-2">Authorized</p>
      <p class="text-text text-sm mb-4">
        {displayClient} has access to your LeadAce account.
      </p>
      <p class="text-xs text-text-muted leading-relaxed mb-3">
        Returning you to {displayClient}. You can close this tab once your terminal resumes.
      </p>
      <p class="text-xs text-text-muted leading-relaxed mb-2">
        If your terminal is waiting for a URL instead of resuming automatically, copy this and
        paste it back into the terminal:
      </p>
      <div class="flex items-center gap-2 mb-2">
        <input
          type="text"
          readonly
          value={finalRedirect}
          class="flex-1 min-w-0 rounded border border-border bg-surface px-2 py-1 font-mono text-[11px] text-text"
          onclick={(e) => (e.currentTarget as HTMLInputElement).select()}
        />
        <button
          type="button"
          onclick={copyRedirect}
          class="shrink-0 rounded border border-border bg-page px-2 py-1 text-[11px] text-text hover:bg-surface"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <a
        href={finalRedirect}
        class="block text-xs text-text-muted hover:text-text underline"
      >
        Or click here to return now
      </a>
    {:else}
      <p class="text-text-muted text-sm mb-6">
        Authorize <span class="font-medium text-text">{displayClient}</span> to access your LeadAce account
      </p>

      <p class="text-xs text-text-muted leading-relaxed mb-4">
        Signed in as <span class="font-medium text-text">{user?.email ?? ''}</span>.
        Approving lets {displayClient} call LeadAce on your behalf with the same access your
        own browser session has — including reading, creating, updating, and deleting prospects,
        projects, and outreach data, and sending email through your connected Gmail. Revoke
        access at any time from
        <a href="/account-settings" class="underline hover:text-text">Account → Connected MCP clients</a>;
        signing out of {displayClient} itself does not revoke it.
      </p>

      <div class="mb-6 rounded border border-border bg-surface px-3 py-2">
        <p class="text-[11px] text-text-muted">After approval, your browser will be sent to:</p>
        <p class="font-mono text-xs text-text break-all">{redirectHost}</p>
        <p class="mt-1 text-[11px] text-text-muted">
          Cancel if this host doesn't match the tool you started.
        </p>
      </div>

      <div class="flex flex-col gap-2">
        <button
          type="button"
          onclick={handleApprove}
          disabled={status === 'submitting'}
          class="w-full rounded-md bg-text py-2 text-sm font-medium text-page transition-colors hover:bg-text/90 disabled:opacity-50"
        >
          {status === 'submitting' ? 'Authorizing…' : `Authorize ${displayClient}`}
        </button>
        <button
          type="button"
          onclick={handleDeny}
          disabled={status === 'submitting'}
          class="w-full rounded-md border border-border bg-page py-2 text-sm font-medium text-text transition-colors hover:bg-surface disabled:opacity-50"
        >
          Cancel
        </button>
      </div>

      {#if errorMessage}
        <p class="text-danger text-xs mt-4">{errorMessage}</p>
      {/if}
    {/if}
  </div>
</div>
