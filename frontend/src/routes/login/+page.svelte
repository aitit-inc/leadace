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

<div class="flex min-h-screen items-center justify-center bg-page px-6 py-12">
  <div class="w-full max-w-md">
    <div class="flex animate-rise items-center gap-2.5">
      <Logo size={32} class="text-accent" />
      <span class="font-display text-2xl font-semibold tracking-tight text-text">LeadAce</span>
    </div>
    <h1 class="mt-10 animate-rise font-display text-3xl font-semibold leading-tight tracking-tight text-balance text-text">
      {fromSignupCta ? 'See who it emails and what it says, before anything is sent.' : 'Welcome back'}
    </h1>
    <p class="mt-3 animate-rise text-base text-text-secondary">
      {fromSignupCta
        ? 'Start free: sign in with Google and your account is created. No card, no separate form.'
        : 'Sign in with your Google account'}
    </p>

    {#if deletedNotice}
      <p class="mt-6 rounded-xl bg-surface px-4 py-3 text-sm text-text">
        Your account has been deleted.
      </p>
    {/if}

    <button
      type="button"
      onclick={handleGoogle}
      disabled={loading}
      class="btn btn-secondary mt-8 h-12 w-full animate-rise [--btn-fs:var(--text-base)]"
    >
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
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
      <p class="mt-4 text-sm text-danger">{error}</p>
    {/if}

    {#if fromSignupCta}
      <ol class="mt-8 space-y-3 text-sm text-text-secondary" aria-label="What happens next">
        {#each ['Sign in with Google', 'Paste your website in the chat', 'Read the first drafts — nothing goes out until you approve'] as step, i (step)}
          <li class="flex items-center gap-3">
            <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold tabular-nums text-text">
              {i + 1}
            </span>
            {step}
          </li>
        {/each}
      </ol>
    {/if}

    <p class="mt-8 text-xs leading-relaxed text-text-muted">
      LeadAce will request permission to send email on your behalf and to read your Gmail inbox
      (read-only) to detect and classify replies to your outreach. We never modify or delete your
      messages. See our <a href="/privacy" class="underline hover:text-text">Privacy Policy</a> for
      how this data is used.
    </p>

    {#if EDITION === 'cloud'}
      <p class="mt-6 text-xs text-text-muted">
        By continuing, you agree to the
        <a href="/terms" class="underline hover:text-text">Terms</a>
        and
        <a href="/privacy" class="underline hover:text-text">Privacy Policy</a>.
      </p>
    {:else}
      <p class="mt-6 text-xs text-text-muted">
        This is a self-hosted LeadAce instance. Your use is governed by whatever terms the
        operator of this site provides.
      </p>
    {/if}
  </div>
</div>
