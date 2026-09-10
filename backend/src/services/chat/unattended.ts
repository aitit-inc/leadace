// The tool policy of a run nobody is watching. A schedule's standing
// authorization is "start jobs on this project" and nothing more: every tool
// the attended chat can hold for an approval card is refused, because there is
// no one to answer the card. What a started job may send is still decided by
// the project's outbound mode and the plan quota, neither of which an agent
// can change — so a schedule adds *when* work happens, never *what* it may do.
//
// The rule reads the tool, never its arguments: a gate that opens for some
// arguments (do-not-contact only when it is being lifted, a schedule edit only
// when it stays off) would otherwise let exactly those calls through.
import type { ToolExecutor } from './agent'

// The `send` kind is not part of it: that job delivers drafts a person was
// meant to approve and skips the project's outbound mode on purpose.
function preAuthorized(name: string, args: Record<string, unknown>): boolean {
  if (name !== 'start_job') return false
  const params = args['params']
  const kind = typeof params === 'object' && params !== null ? (params as { kind?: unknown }).kind : undefined
  return kind !== 'send'
}

export function unattendedTools(tools: ToolExecutor): ToolExecutor {
  return {
    ...tools,
    // Nothing is held: a gated call is refused below instead, so the thread
    // never parks on a confirmation no one will answer.
    confirmSummary: () => null,
    execute: (name, args) => {
      if (tools.isGated(name) && !preAuthorized(name, args)) {
        return Promise.resolve({
          ok: false,
          text: `${name} needs a person's approval, so it cannot run in a scheduled run. Report what you would have done and stop; the person can do it from the chat.`,
        })
      }
      return tools.execute(name, args)
    },
  }
}
