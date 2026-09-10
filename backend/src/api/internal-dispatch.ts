// The chat agent re-enters the API in-process (app.fetch) as the signed-in
// person. This header marks those requests; its value is minted once per
// isolate — on first use, since Workers forbid randomness in module scope —
// so a client outside the Worker cannot present it and be taken for the chat.
export const INTERNAL_DISPATCH_HEADER = 'X-LeadAce-Internal'
// Which in-process caller it is: the chat by default, 'cron' for a schedule's
// unattended run. Read only when the header above proves the request came
// from inside this Worker.
export const INTERNAL_ORIGIN_HEADER = 'X-LeadAce-Internal-Origin'

let token: string | null = null
export function internalDispatchToken(): string {
  token ??= crypto.randomUUID()
  return token
}
