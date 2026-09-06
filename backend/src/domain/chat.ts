// Conversation storage for the hosted chat agent. A message body is stored as
// the Gemini `Content` parts it was exchanged as, so a thread replays into the
// model verbatim; `job` rows are the server's own notices (a job finished) and
// are rendered to the model as text on the next turn.
import { z } from 'zod'

export const CHAT_ROLES = ['user', 'model', 'tool', 'job'] as const
export type ChatRole = (typeof CHAT_ROLES)[number]

const functionCallPartSchema = z.object({
  functionCall: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    args: z.record(z.string(), z.unknown()),
  }),
  thoughtSignature: z.string().optional(),
})
const textPartSchema = z.object({ text: z.string(), thoughtSignature: z.string().optional() })
const functionResponsePartSchema = z.object({
  functionResponse: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    response: z.record(z.string(), z.unknown()),
  }),
})

export const chatContentSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('user'), parts: z.array(textPartSchema).min(1) }),
  z.object({ role: z.literal('model'), parts: z.array(z.union([textPartSchema, functionCallPartSchema])).min(1) }),
  z.object({ role: z.literal('tool'), parts: z.array(functionResponsePartSchema).min(1) }),
  z.object({
    role: z.literal('job'),
    jobId: z.string().min(1),
    kind: z.string().min(1),
    status: z.string().min(1),
    summary: z.string(),
  }),
])
export type ChatContent = z.infer<typeof chatContentSchema>
export type ChatModelPart = Extract<ChatContent, { role: 'model' }>['parts'][number]

// A tool call the agent asked for that waits on the person's approval. The
// thread is blocked on it: approve executes the call, anything else declines.
export type PendingCall = {
  messageId: number
  callId: string
  name: string
  args: Record<string, unknown>
  // Responses of the calls from the same model turn already answered (the
  // ungated ones, and gated ones the person already decided); they travel with
  // this call's answer in one tool message.
  otherResponses: Array<{ id: string; name: string; response: Record<string, unknown> }>
  // Further gated calls from the same turn, each asked about in order.
  remaining: Array<{ callId: string; name: string; args: Record<string, unknown> }>
}

// Tool calls that send, delete, or reshape the workspace wait for the person.
export const CONFIRM_TOOLS: ReadonlySet<string> = new Set([
  'delete_project',
  'delete_prospects',
  'delete_organizations',
  'discard_drafts',
  'send_email_and_record',
  'set_prospect_do_not_contact',
  'update_prospect_status',
  'apply_strategy_draft',
])
// start_job is gated only for kinds that can send real mail.
export const CONFIRM_JOB_KINDS: ReadonlySet<string> = new Set(['send', 'draft', 'daily_cycle'])

export function needsConfirmation(name: string, args: Record<string, unknown>): boolean {
  if (CONFIRM_TOOLS.has(name)) return true
  if (name === 'start_job') {
    const params = args['params']
    const kind = typeof params === 'object' && params !== null ? (params as { kind?: unknown }).kind : undefined
    return typeof kind === 'string' && CONFIRM_JOB_KINDS.has(kind)
  }
  return false
}
