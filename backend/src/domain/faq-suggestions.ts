// The brief's `Q:`/`A:` line format follows the convention shown in the
// /inquiry-settings placeholder. Max keeps the inquiry-landing chip strip
// readable on mobile.

export const FAQ_SUGGESTIONS_MAX = 4

export function extractFaqQuestions(
  brief: string | null,
  max: number = FAQ_SUGGESTIONS_MAX,
): string[] {
  if (!brief) return []
  const questions: string[] = []
  // Stops at the first inline `A:` so a single-line `Q: … A: …` entry doesn't
  // leak the answer into the chip. Case-sensitive by convention.
  const re = /^[ \t]*Q:[ \t]*(.+?)[ \t]*(?:A:.*)?$/gm
  let match: RegExpExecArray | null
  while ((match = re.exec(brief)) !== null) {
    if (questions.length >= max) break
    const q = match[1]
    if (q && q.length > 0) questions.push(q)
  }
  return questions
}
