import { findLinkOrContact } from '../domain/public-text'
import { callOpenAIResponses, OpenAIError, type OpenAIEnv } from './openai'
import { ok, err, type ServiceResult } from './result'

// Second, independent anonymization pass over the daily cycle's public journal
// entry, run server-side before the version is stored: the agent already
// anonymizes, but a name it missed must never reach the public /live page.
// Names stay an LLM judgment; links, email addresses, domains, and handles are
// checked deterministically on the pass's output, so a missed one or an
// injected one fails the save instead of going public. Upstream failure also
// rejects the save — the previous entry stays published.
const REDACT_MODEL = 'gpt-5.6-terra'
// Reasoning tokens count against this budget; the entry itself is ~100 words.
const REDACT_MAX_OUTPUT_TOKENS = 4000

const REDACT_INSTRUCTIONS = `You are the final privacy editor for a short public journal entry written by an AI sales agent named Ace. The entry is published on a public web page.

Rewrite the entry so that it identifies no third party:
- Every company, product, brand, and organization name that is a prospect or another third party becomes its industry and size ("a 12-person dev tools company", "a mid-size logistics firm").
- Every person becomes a role ("a founder", "a head of sales at a seed-stage fintech"). Remove email addresses, domains, URLs, and social handles entirely — the output must contain none, not even the sender's own.
- A quoted or closely paraphrased prospect message becomes a plain statement of the reason it expresses.
- Keep Ace's own name and the name of the product Ace itself is selling (the sender's product); only third parties are anonymized.
- Keep every number, date, count, and stated fact exactly as written. Do not add, remove, or reorder lines. Do not add commentary.

Output the rewritten entry only, in the same language and markdown as the input. If nothing needs changing, output the entry verbatim.`

export async function redactPublicJournal(
  env: OpenAIEnv,
  content: string,
): Promise<ServiceResult<string>> {
  try {
    const llm = await callOpenAIResponses({
      apiKey: env.OPENAI_API_KEY,
      model: REDACT_MODEL,
      instructions: REDACT_INSTRUCTIONS,
      input: [{ role: 'user', content }],
      maxOutputTokens: REDACT_MAX_OUTPUT_TOKENS,
    })
    const leak = findLinkOrContact(llm.outputText)
    if (leak) {
      return err(
        'UNPROCESSABLE',
        `Public journal still carries a ${leak} after anonymization`,
        'Rewrite the entry without links, email addresses, domains, or social handles and save again.',
      )
    }
    return ok(llm.outputText)
  } catch (e) {
    if (e instanceof OpenAIError) {
      return err(
        'BAD_GATEWAY',
        'Public journal anonymization failed upstream',
        'Nothing was saved; the previous entry stays on /live. Retry the save.',
      )
    }
    throw e
  }
}
