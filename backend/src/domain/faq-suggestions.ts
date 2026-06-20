// Extract user-facing FAQ questions from the project's inquiryChatBrief so
// the inquiry-landing chip strip can offer 1-tap-send suggestions. The brief
// follows the convention shown in the /inquiry-settings placeholder: lines
// of the form `Q: <question>` (paired with one or more `A: ...` lines).
// Anything that doesn't start with `Q:` is ignored — including freeform
// service description text. Max keeps the chip strip readable on mobile.

export const FAQ_SUGGESTIONS_MAX = 4

export function extractFaqQuestions(
  brief: string | null,
  max: number = FAQ_SUGGESTIONS_MAX,
): string[] {
  if (!brief) return []
  const questions: string[] = []
  // `Q:` must start a line (after optional whitespace). The question runs to
  // end-of-line but stops at the first inline `A:` so a single-line `Q: … A: …`
  // entry doesn't leak the answer into the chip. Case-sensitive by convention (Q/A).
  const re = /^[ \t]*Q:[ \t]*(.+?)[ \t]*(?:A:.*)?$/gm
  let match: RegExpExecArray | null
  while ((match = re.exec(brief)) !== null) {
    if (questions.length >= max) break
    const q = match[1]
    if (q && q.length > 0) questions.push(q)
  }
  return questions
}
