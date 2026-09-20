// The file types Ace can read, for the picker's filter. Mirrors backend
// domain/chat-attachment.ts; the backend refuses anything else.
export const ACCEPTED_FILE_TYPES =
  '.pdf,.txt,.md,.csv,.tsv,.json,.html,.doc,.docx,.rtf,.odt,.ppt,.pptx,.xls,.xlsx,.png,.jpg,.jpeg,.webp,.gif';

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
