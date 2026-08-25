<script lang="ts">
  import { page } from '$app/state';
  import { dev } from '$app/environment';
  import { isSafeRelativePath } from '$lib/redirect';
  import Logo from '$lib/components/Logo.svelte';
  import { EDITION } from '$lib/config';
  import { GOOGLE_OAUTH_SCOPES } from '$lib/gmail-oauth';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  let supabase = $derived(data.supabase);

  // Unknown /auth/callback ?error= reasons pass through so they don't disappear silently.
  function describeCallbackError(reason: string): string {
    if (reason === 'gmail_scope_required') {
      return "Gmail send permission wasn't granted. LeadAce needs gmail.send to send outbound email — please continue with Google again and approve all requested scopes.";
    }
    if (reason === 'missing_code') {
      return 'Sign-in was interrupted before completing. Please try again.';
    }
    return reason;
  }

  let error = $state(
    page.url.searchParams.get('error')
      ? describeCallbackError(page.url.searchParams.get('error') ?? '')
      : '',
  );
  let deletedNotice = $state(page.url.searchParams.get('deleted') === '1');
  // Landing-page signup CTAs link here with ?signup=1; the callback forwards it
  // to the backend for funnel attribution.
  const fromSignupCta = page.url.searchParams.get('signup') === '1';
  let loading = $state(false);

  async function handleGoogle() {
    error = '';
    loading = true;
    // Persist `next` in a short-lived cookie instead of sessionStorage so the
    // server-side /auth/callback handler (a +server.ts) can read it after the
    // OAuth redirect. Routing it through the OAuth redirectTo URL is brittle
    // — Supabase's allowlist-based validation can strip query params and
    // silently break deep-link returns.
    const next = page.url.searchParams.get('next');
    const cookieAttrs = `Path=/; SameSite=Lax; Max-Age=600${
      dev ? '' : '; Secure'
    }`;
    const expiredAttrs = `Path=/; SameSite=Lax; Max-Age=0${dev ? '' : '; Secure'}`;
    if (next && isSafeRelativePath(next)) {
      document.cookie = `lp-next=${encodeURIComponent(next)}; ${cookieAttrs}`;
    } else {
      document.cookie = `lp-next=; ${expiredAttrs}`;
    }
    document.cookie = fromSignupCta
      ? `lp-signup=1; ${cookieAttrs}`
      : `lp-signup=; ${expiredAttrs}`;
    const { error: err } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
        scopes: GOOGLE_OAUTH_SCOPES,
        queryParams: {
          // access_type=offline + prompt=consent forces Google to issue a
          // refresh_token that the backend can use to mint short-lived access
          // tokens for Gmail API calls.
          access_type: 'offline',
          prompt: 'consent',
        },
      },
    });
    if (err) {
      error = err.message;
      loading = false;
    }
  }
</script>

<div class="flex min-h-screen items-center justify-center bg-page">
  <div class="w-full max-w-sm px-6">
    <div class="flex items-center gap-2.5 mb-1">
      <Logo size={32} class="text-accent" />
      <h1 class="font-mono text-2xl font-semibold text-text">LeadAce</h1>
    </div>
    <p class="text-text-muted text-sm mb-8">
      {fromSignupCta
        ? 'Start free: sign in with Google and your account is created. No card, no separate form.'
        : 'Sign in with your Google account'}
    </p>

    {#if deletedNotice}
      <p class="text-text text-xs mb-4 rounded-md border border-border bg-surface px-3 py-2">
        Your account has been deleted.
      </p>
    {/if}

    <button
      type="button"
      onclick={handleGoogle}
      disabled={loading}
      class="w-full rounded-md border border-border bg-page py-2 text-sm font-medium text-text transition-colors hover:bg-surface disabled:opacity-50 flex items-center justify-center gap-2"
    >
      <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true">
        <path
          fill="#4285F4"
          d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"
        />
        <path
          fill="#34A853"
          d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.32A9 9 0 0 0 9 18z"
        />
        <path
          fill="#FBBC05"
          d="M3.97 10.72A5.41 5.41 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.96H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.04l3.01-2.32z"
        />
        <path
          fill="#EA4335"
          d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 9 0 9 9 0 0 0 .96 4.96l3.01 2.32C4.68 5.16 6.66 3.58 9 3.58z"
        />
      </svg>
      {loading ? 'Redirecting…' : 'Continue with Google'}
    </button>

    {#if error}
      <p class="text-danger text-xs mt-4">{error}</p>
    {/if}

    <p class="mt-6 text-[11px] text-text-muted">
      LeadAce will request permission to send email on your behalf and to read your Gmail inbox
      (read-only) to detect and classify replies to your outreach. We never modify or delete your
      messages. See our <a href="/privacy" class="underline hover:text-text">Privacy Policy</a> for
      how this data is used.
    </p>

    {#if EDITION === 'cloud'}
      <p class="mt-10 text-[11px] text-text-muted text-center">
        By continuing, you agree to the
        <a href="/terms" class="underline hover:text-text">Terms</a>
        and
        <a href="/privacy" class="underline hover:text-text">Privacy Policy</a>.
      </p>
    {:else}
      <p class="mt-10 text-[11px] text-text-muted text-center">
        This is a self-hosted LeadAce instance. Your use is governed by whatever terms the
        operator of this site provides.
      </p>
    {/if}
  </div>
</div>
