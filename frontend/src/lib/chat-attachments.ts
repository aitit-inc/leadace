// The file types Ace can read. Mirrors backend domain/chat-attachment.ts; the
// backend refuses anything else.
const ACCEPTED_EXTENSIONS = [
  'pdf', 'txt', 'md', 'csv', 'tsv', 'json', 'html', 'doc', 'docx', 'rtf', 'odt', 'ppt', 'pptx', 'xls', 'xlsx',
  'png', 'jpg', 'jpeg', 'webp', 'gif',
];

export const ACCEPTED_FILE_TYPES = ACCEPTED_EXTENSIONS.map((ext) => `.${ext}`).join(',');

// A drop has no picker to filter it, and a dropped folder arrives as a file.
export function canAttach(filename: string): boolean {
  return ACCEPTED_EXTENSIONS.includes(filename.toLowerCase().split('.').pop() ?? '');
}

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
