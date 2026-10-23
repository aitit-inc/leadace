import { dev } from '$app/environment';
import { googleMailboxAuthorizationUrl } from '$lib/api/sending-identities';
import { NEXT_COOKIE } from '$lib/redirect';

// Ties the Google redirect back to this browser and to the account that
// started it: `<nonce>.<user id>`. The callback compares the nonce with the
// `state` Google echoes and the user id with the session finishing the flow.
export const GOOGLE_MAILBOX_STATE_COOKIE = 'lp-gmail-state';

// Set by the callback when it lands back in the chat: proof, which no link can
// forge, that the connection just finished in this browser.
export const GOOGLE_MAILBOX_CONNECTED_COOKIE = 'lp-gmail-connected';

// Connect a Google account as a mailbox: the one signed in with, or any other.
// The callback returns to this page. On success the browser navigates away to
// Google, so a returned string is always an error.
export async function connectGoogleMailbox(
  session: { access_token: string; user: { id: string } } | null,
  loginHint?: string,
): Promise<string | null> {
  if (!session) return 'Not signed in.';
  const state = crypto.randomUUID();
  const attrs = `Path=/; SameSite=Lax; Max-Age=600${dev ? '' : '; Secure'}`;
  const here = new URL(window.location.href);
  here.searchParams.delete('mailbox_connected');
  here.searchParams.delete('mailbox_error');
  document.cookie = `${GOOGLE_MAILBOX_STATE_COOKIE}=${state}.${session.user.id}; ${attrs}`;
  document.cookie = `${NEXT_COOKIE}=${encodeURIComponent(here.pathname + here.search)}; ${attrs}`;
  const token = session.access_token;
  try {
    const url = await googleMailboxAuthorizationUrl({ state, loginHint }, fetch, token);
    window.location.href = url;
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : 'Failed to start the Google connection.';
  }
}
