// Matches backend/src/domain/country.ts:ALLOWED_SEND_COUNTRIES. Anything
// outside this list is accepted by the backend (the column is free-form
// ISO 3166-1 alpha-2) but the send-time guardrail will block it.
export const SUPPORTED_COUNTRIES: { code: string; label: string }[] = [
  { code: 'US', label: 'United States (US)' },
  { code: 'CA', label: 'Canada (CA)' },
  { code: 'JP', label: 'Japan (JP)' },
];
