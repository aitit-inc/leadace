// The website typed on the landing page, which rides through sign-in as ?site=
// into the chat's input box.
export function typedWebsite(raw: string | null | undefined): string | null {
  const typed = raw?.trim();
  if (!typed || typed.length > 200) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(typed) ? typed : `https://${typed}`);
    if (!url.hostname.includes('.') || url.username || url.password) return null;
    return url.pathname === '/' && !url.search && !url.hash ? url.origin : url.href;
  } catch {
    return null;
  }
}
