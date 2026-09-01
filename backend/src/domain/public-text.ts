// Deterministic detector for what public-facing generated text must never
// carry: links, email addresses, bare domains, social handles. Both callers
// (the public journal after its anonymization pass, the web preview's email
// contract) sit behind an LLM whose instructions a hostile input can override,
// so this rule is enforced here rather than in a prompt.

export type LinkOrContactKind = 'url' | 'email' | 'domain' | 'handle'

const URL_RE = /\b(?:https?:\/\/|www\.|mailto:)/i
const MARKDOWN_LINK_RE = /\]\(/
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/
// Bare domains on the TLDs that show up in prospect data; a full TLD list would
// start flagging ordinary prose ("Node.js", "index.html").
const DOMAIN_RE =
  /(?<![A-Za-z0-9@.-])[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:com|net|org|io|ai|co|dev|app|so|me|us|uk|jp|de|fr|ca|au|in|tech|cloud|xyz|info|biz)(?![A-Za-z0-9-])/i
const HANDLE_RE = /(?<![A-Za-z0-9._%+-])@[A-Za-z0-9_]{2,}/

export function findLinkOrContact(text: string): LinkOrContactKind | null {
  if (EMAIL_RE.test(text)) return 'email'
  if (URL_RE.test(text) || MARKDOWN_LINK_RE.test(text)) return 'url'
  if (DOMAIN_RE.test(text)) return 'domain'
  if (HANDLE_RE.test(text)) return 'handle'
  return null
}
