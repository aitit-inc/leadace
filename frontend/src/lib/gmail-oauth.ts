import type { SupabaseClient } from '@supabase/supabase-js';

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
