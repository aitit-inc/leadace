// Each attached file goes to the model provider, which the model reads it from
// by id, and to the workspace bucket under `<tenant>/<thread>/` — the prefix a
// deleted thread or account clears.
import { z } from 'zod'
import { randomFromAlphabet } from '../../auth/random-id'
import {
  ACCEPTED_EXTENSIONS,
  ATTACHMENT_TTL_DAYS,
  MAX_ATTACHMENT_BYTES,
  attachmentIdSchema,
  attachmentType,
  fileRefSchema,
  type FileRef,
} from '../../domain/chat-attachment'
import type { TenantId } from '../../domain/ids'
import type { TenantRun } from '../../db/rls'
import { LlmError, uploadLlmFile, type LlmEnv, type UploadedFile } from '../llm'
import { ATTACHMENT_UPLOADS_PER_TENANT_PER_DAY, takeChatRateSlot } from '../chat-rate-limit'
import { err, ok, type ServiceResult } from '../result'
import { threadIdParamSchema } from './threads'

export type AttachmentEnv = LlmEnv & { ATTACHMENTS: R2Bucket }

export const uploadAttachmentQuerySchema = z.object({ name: z.string().min(1).max(200) }).strict()
export type UploadAttachmentQuery = z.infer<typeof uploadAttachmentQuerySchema>

export const attachmentIdParamSchema = threadIdParamSchema.extend({ attachmentId: attachmentIdSchema })

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

function keyOf(tenantId: TenantId, threadId: string, attachmentId: string): string {
  return `${tenantId}/${threadId}/${attachmentId}`
}

// The body is read under the cap rather than buffered whole: the Worker's
// memory is shared by every request it is serving.
async function readCapped(body: ReadableStream<Uint8Array> | null): Promise<Uint8Array | null> {
  if (!body) return null
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_ATTACHMENT_BYTES) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.byteLength
  }
  return bytes
}

const TOO_LARGE = `Each file must be ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB or smaller`

export async function uploadAttachment(
  run: TenantRun,
  tenantId: TenantId,
  env: AttachmentEnv,
  threadId: string,
  query: UploadAttachmentQuery,
  body: ReadableStream<Uint8Array> | null,
): Promise<ServiceResult<FileRef>> {
  // Reserved before the file is read: an upload costs storage here and at the
  // provider whether or not its message is ever sent.
  const slot = await run((db) => takeChatRateSlot(db, tenantId, 'attachment_upload', tenantId))
  if (!slot) {
    return err('FORBIDDEN', `Daily attachment limit reached (${ATTACHMENT_UPLOADS_PER_TENANT_PER_DAY} files) — resets at midnight UTC.`)
  }
  // The body is read before it is judged: a response sent while the client is
  // still uploading drops the connection instead of carrying the reason.
  const bytes = await readCapped(body)
  if (!bytes) return err('INVALID_INPUT', TOO_LARGE)
  if (bytes.byteLength === 0) return err('INVALID_INPUT', 'The file is empty')
  const type = attachmentType(query.name)
  if (!type) return err('UNPROCESSABLE', `Ace cannot read this file type. Accepted: ${ACCEPTED_EXTENSIONS.join(', ')}`)
  let uploaded: UploadedFile
  try {
    uploaded = await uploadLlmFile(env, {
      filename: query.name,
      mimeType: type.mimeType,
      bytes,
      expiresInSeconds: ATTACHMENT_TTL_DAYS * 24 * 60 * 60,
    })
  } catch (e) {
    if (!(e instanceof LlmError)) throw e
    return err('BAD_GATEWAY', 'The file could not be handed to the model. Try again in a moment.')
  }
  const ref: FileRef = {
    id: randomFromAlphabet(ID_ALPHABET, 21),
    fileId: uploaded.fileId,
    expiresAt: uploaded.expiresAt.toISOString(),
    name: query.name,
    kind: type.kind,
    size: bytes.byteLength,
  }
  await env.ATTACHMENTS.put(keyOf(tenantId, threadId, ref.id), bytes, {
    httpMetadata: { contentType: type.mimeType },
    customMetadata: { fileId: ref.fileId, expiresAt: ref.expiresAt, name: ref.name, kind: ref.kind },
  })
  return ok(ref)
}

// Read from the bucket, never from the caller: the message records the name
// and size we stored, not the ones it was handed.
export async function resolveAttachments(
  env: AttachmentEnv,
  tenantId: TenantId,
  threadId: string,
  ids: string[],
): Promise<ServiceResult<FileRef[]>> {
  const refs: FileRef[] = []
  for (const id of ids) {
    const object = await env.ATTACHMENTS.head(keyOf(tenantId, threadId, id))
    const parsed = fileRefSchema.safeParse({ id, ...object?.customMetadata, size: object?.size })
    if (!parsed.success) return err('NOT_FOUND', 'An attachment is no longer available. Attach it again.')
    refs.push(parsed.data)
  }
  return ok(refs)
}

export function readAttachment(env: AttachmentEnv, tenantId: TenantId, threadId: string, attachmentId: string): Promise<R2ObjectBody | null> {
  return env.ATTACHMENTS.get(keyOf(tenantId, threadId, attachmentId))
}

export function deleteThreadAttachments(env: AttachmentEnv, tenantId: TenantId, threadId: string): Promise<void> {
  return deletePrefix(env.ATTACHMENTS, `${tenantId}/${threadId}/`)
}

export function deleteTenantAttachments(bucket: R2Bucket, tenantId: TenantId): Promise<void> {
  return deletePrefix(bucket, `${tenantId}/`)
}

async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined
  do {
    const listed = await bucket.list({ prefix, cursor })
    if (listed.objects.length > 0) await bucket.delete(listed.objects.map((o) => o.key))
    cursor = listed.truncated ? listed.cursor : undefined
  } while (cursor)
}
