import type { SupabaseClient } from '@supabase/supabase-js';

const GMAIL_SEND_SCOPES = 'openid profile email https://www.googleapis.com/auth/gmail.send';

// Initiate the Google OAuth flow that grants the gmail.send scope. The OAuth
// redirect lands at /auth/callback, where the server persists the refresh
// token and bounces the user back into the app. On successful initiation the
// browser is navigated away to Google, so this never resolves to `null` on
// the success path — only error returns mean the redirect did not start.
export async function connectGmail(supabase: SupabaseClient): Promise<string | null> {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: `${window.location.origin}/auth/callback`,
      scopes: GMAIL_SEND_SCOPES,
      queryParams: { access_type: 'offline', prompt: 'consent' },
    },
  });
  return error ? error.message : null;
}
