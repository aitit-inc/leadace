import type { z } from 'zod'
import type { GroundedText, LlmEnv, UrlJsonResult } from './common'
import {
  callOpenAIFollowUpJson,
  callOpenAIGroundedText,
  callOpenAIJson,
  streamOpenAIChat,
  uploadOpenAIFile,
  type ChatRequest,
  type ChatStreamEvent,
  type FileUpload,
  type UploadedFile,
} from './openai'
import { callOpenAIPagesJson } from './pages'
import { OPENAI_ROUTES, type FollowUpJsonOp, type GroundedTextOp, type JsonOp, type PagesJsonOp } from './routes'

export { LlmError, withLlmScope, type Citation, type GroundedText, type LlmEnv, type UrlJsonResult } from './common'
export type { ChatCall, ChatRequest, ChatStreamEvent, UploadedFile } from './openai'

type SchemaPrompt<T> = { prompt: string; schema: z.ZodType<T> }

export function callLlmJson<T>(env: LlmEnv, op: JsonOp, args: SchemaPrompt<T>): Promise<T> {
  return callOpenAIJson({ op, apiKey: env.OPENAI_API_KEY, ...OPENAI_ROUTES[op], ...args })
}

// `retrievedUrls` is what was actually read — callers treat an answer with
// none as invented.
export function callLlmPagesJson<T>(env: LlmEnv, op: PagesJsonOp, args: SchemaPrompt<T> & { urls: string[] }): Promise<UrlJsonResult<T>> {
  return callOpenAIPagesJson({ op, apiKey: env.OPENAI_API_KEY, ...OPENAI_ROUTES[op], ...args })
}

// Search-grounded reading, text out; the caller structures it with
// callLlmFollowUpJson. Citations are the search's own record; a page the model
// names in its text may not exist.
export function callLlmGroundedText(env: LlmEnv, op: GroundedTextOp, args: { prompt: string }): Promise<GroundedText> {
  return callOpenAIGroundedText({ op, apiKey: env.OPENAI_API_KEY, ...OPENAI_ROUTES[op], ...args })
}

// A schema-typed answer that continues from a search: the model sees what the
// search read, not only what the prompt quotes of it.
export function callLlmFollowUpJson<T>(env: LlmEnv, op: FollowUpJsonOp, args: SchemaPrompt<T> & { after: GroundedText }): Promise<T> {
  return callOpenAIFollowUpJson({ op, apiKey: env.OPENAI_API_KEY, ...OPENAI_ROUTES[op], ...args })
}

export function streamLlmChat(env: LlmEnv, args: ChatRequest): AsyncGenerator<ChatStreamEvent> {
  return streamOpenAIChat({ op: 'chat', apiKey: env.OPENAI_API_KEY, ...OPENAI_ROUTES.chat, ...args })
}

export function uploadLlmFile(env: LlmEnv, args: Omit<FileUpload, 'apiKey'>): Promise<UploadedFile> {
  return uploadOpenAIFile({ apiKey: env.OPENAI_API_KEY, ...args })
}
