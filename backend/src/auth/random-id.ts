// Modulo bias: 0 for the 64-char alphabet (256 % 64 = 0). ~0.4% bias for the
// 62-char alphabet (256 % 62 = 8, so values 0..7 within the alphabet appear
// 5/256 vs 4/256 elsewhere) — acceptable at our 21-char default length where
// the practical entropy loss is well below the security margin.
export function randomFromAlphabet(alphabet: string, length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')
}
