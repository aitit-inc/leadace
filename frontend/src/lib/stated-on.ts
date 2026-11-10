// A page's own date (YYYY-MM-DD), shown as written: no time zone shifts it.
export function fmtStatedOn(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
