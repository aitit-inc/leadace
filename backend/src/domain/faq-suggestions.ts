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
  // Multiline regex over the whole brief — `Q:` must start a line (after
  // optional whitespace). Captures everything to end-of-line. Case-sensitive
  // because the operator-facing convention is uppercase Q/A.
  const re = /^[ \t]*Q:[ \t]*(.+?)[ \t]*$/gm
  let match: RegExpExecArray | null
  while ((match = re.exec(brief)) !== null) {
    if (questions.length >= max) break
    const q = match[1]
    if (q && q.length > 0) questions.push(q)
  }
  return questions
}
