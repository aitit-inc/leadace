export const PAGE_SIZE = 25;

export function parsePageNumber(raw: string | null): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}
