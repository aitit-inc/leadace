// Conversation storage for the hosted chat agent. The thread is the record:
// services/chat/agent.ts replays it into the model's input items. `job` rows
// are the server's own notices (a job finished) and are rendered to the model
// as text on the next turn.
import { z } from 'zod'

export const CHAT_ROLES = ['user', 'model', 'tool', 'job'] as const
export type ChatRole = (typeof CHAT_ROLES)[number]

const functionCallPartSchema = z.object({
  functionCall: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    args: z.record(z.string(), z.unknown()),
  }),
})
const textPartSchema = z.object({ text: z.string() })
const functionResponsePartSchema = z.object({
  functionResponse: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    response: z.record(z.string(), z.unknown()),
  }),
})

export const chatContentSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('user'), parts: z.array(textPartSchema).min(1) }),
  z.object({
    role: z.literal('model'),
    parts: z.array(z.union([textPartSchema, functionCallPartSchema])).min(1),
    // The stored response these parts came from, which the next turn
    // continues. Absent when the answer was stopped, or the turn read less
    // than the whole thread (a scheduled run).
    responseId: z.string().optional(),
  }),
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

// What the person is asked to approve: the effect of the call, never its
// arguments. Written where the gate is decided (tools/registry).
export type ConfirmSummary = {
  title: string
  facts: Array<{ label: string; value: string }>
  // The content being committed, shown as written — an email's text.
  body?: string
  // Present when the action cannot be undone; the UI styles on it.
  warning?: string
  confirmLabel: string
}

// A tool call the agent asked for that waits on the person's approval. The
// thread is blocked on it: approve executes the call, anything else declines.
export type PendingCall = {
  messageId: number
  callId: string
  name: string
  args: Record<string, unknown>
  summary: ConfirmSummary
  // Responses of the calls from the same model turn already answered (the
  // ungated ones, and gated ones the person already decided); they travel with
  // this call's answer in one tool message.
  otherResponses: Array<{ id: string; name: string; response: Record<string, unknown> }>
  // Further gated calls from the same turn, each asked about in order.
  remaining: Array<{ callId: string; name: string; args: Record<string, unknown>; summary: ConfirmSummary }>
}

export type ToolEffect =
  | { kind: 'job_started'; jobId: string; jobKind: string }
  | { kind: 'project_created'; projectId: string }
