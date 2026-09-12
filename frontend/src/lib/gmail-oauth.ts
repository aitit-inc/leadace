import type { SupabaseClient } from '@supabase/supabase-js';
import { dev } from '$app/environment';
import { googleMailboxAuthorizationUrl } from '$lib/api/sending-identities';

// The Google OAuth scopes we request, and the callback's persisted-scope fallback.
// These exact strings must match backend domain/sending-identity.ts.
//
// gmail.send (Sensitive) sends outbound mail, incl. from a verified Send-As
// alias, so we avoid the Restricted gmail.settings.* scopes. gmail.readonly
// powers server-side reply collection (the reply-ingest cron); it's Restricted,
// so the consent screen shows an "unverified app" warning until Google's CASA
// verification of this OAuth app completes.
export const GOOGLE_OAUTH_SCOPES =
  'openid profile email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly';

// On successful initiation the browser navigates away to Google, so this never
// resolves to `null` on the success path — only error returns mean the redirect
// did not start.
export async function connectGmail(supabase: SupabaseClient): Promise<string | null> {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: `${window.location.origin}/auth/callback`,
      scopes: GOOGLE_OAUTH_SCOPES,
      queryParams: { access_type: 'offline', prompt: 'consent' },
    },
  });
  return error ? error.message : null;
}

// Ties the Google redirect back to this browser and to the account that
// started it: `<nonce>.<user id>`. The callback compares the nonce with the
// `state` Google echoes and the user id with the session finishing the flow.
export const GOOGLE_MAILBOX_STATE_COOKIE = 'lp-gmail-state';

// Connect a Google account as a mailbox of its own (any account — not the one
// signed in with). On success the browser navigates away to Google, so a
// returned string is always an error.
export async function connectGoogleMailbox(
  session: { access_token: string; user: { id: string } } | null,
  loginHint?: string,
): Promise<string | null> {
  if (!session) return 'Not signed in.';
  const state = crypto.randomUUID();
  document.cookie = `${GOOGLE_MAILBOX_STATE_COOKIE}=${state}.${session.user.id}; Path=/; SameSite=Lax; Max-Age=600${dev ? '' : '; Secure'}`;
  const token = session.access_token;
  try {
    const url = await googleMailboxAuthorizationUrl({ state, loginHint }, fetch, token);
    window.location.href = url;
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : 'Failed to start the Google connection.';
  }
}
