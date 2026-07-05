import type { InquiryLocale } from '$lib/api/inquiry';

// Visitor's browser language for the recipient-facing public pages —
// independent of the project's outbound-message language. 'en' during SSR.
export function browserLocale(): InquiryLocale {
  if (typeof navigator === 'undefined') return 'en';
  return navigator.language?.toLowerCase().startsWith('ja') ? 'ja' : 'en';
}
