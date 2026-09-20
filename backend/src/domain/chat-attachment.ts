// Files a person attaches to a chat message. What we accept is what the model
// provider can read, keyed on the extension.
import { z } from 'zod'

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
export const MAX_ATTACHMENTS_PER_MESSAGE = 5

// The provider drops its copy after this, so an older message's attachment is
// no longer readable; ours stays in the bucket.
export const ATTACHMENT_TTL_DAYS = 30

export type AttachmentKind = 'document' | 'image'

const DOCUMENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  html: 'text/html',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  rtf: 'application/rtf',
  odt: 'application/vnd.oasis.opendocument.text',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

export const ACCEPTED_EXTENSIONS = [...Object.keys(DOCUMENT_TYPES), ...Object.keys(IMAGE_TYPES)]

export function attachmentType(filename: string): { kind: AttachmentKind; mimeType: string } | null {
  const ext = filename.toLowerCase().split('.').pop() ?? ''
  const document = DOCUMENT_TYPES[ext]
  if (document) return { kind: 'document', mimeType: document }
  const image = IMAGE_TYPES[ext]
  return image ? { kind: 'image', mimeType: image } : null
}

export const attachmentIdSchema = z.string().regex(/^[A-Za-z0-9]{21}$/)
export const attachmentIdsSchema = z.array(attachmentIdSchema).max(MAX_ATTACHMENTS_PER_MESSAGE)

export const fileRefSchema = z.object({
  id: attachmentIdSchema,
  // The provider's copy, which the model reads, and when it drops it.
  fileId: z.string().min(1).max(120),
  expiresAt: z.iso.datetime(),
  name: z.string().min(1).max(200),
  kind: z.enum(['document', 'image']),
  size: z.number().int().nonnegative(),
})
export type FileRef = z.infer<typeof fileRefSchema>

export function attachmentExpired(file: FileRef, now: Date): boolean {
  return new Date(file.expiresAt).getTime() <= now.getTime()
}
