/**
 * Freezes a cycle.ts target from a homepage, by production's own onboarding
 * (`draftStrategyFromUrl`), against the local database: its daily cap and its
 * master documents are the local stack's, so a run spends none of a
 * production workspace's drafts. Keep the local master documents seeded
 * (`npm run db:seed-master-documents`), or the draft follows stale templates.
 *
 * `--notes` is what a person would type beside the URL; production lets it
 * outrank the site, so it is how a target varies only the conditions it
 * states.
 *
 * Usage (from backend/, OPENAI_API_KEY and DATABASE_URL in .dev.vars):
 *   npx tsx eval/draft.ts <target> <url> --tenant <local tenant id> [--notes "..."]
 */

import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createDb } from '../src/db/connection'
import type { TenantId } from '../src/domain/ids'
import { utcDateKey } from '../src/domain/time'
import { draftStrategyFromUrl } from '../src/services/pipeline/strategy-draft'
import type { HostedEnv } from '../src/services/pipeline/context'
import { DATA, envKey, writeJson } from './common'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const option = (name: string): string | null => {
    const at = args.indexOf(name)
    if (at === -1) return null
    const value = args[at + 1] ?? ''
    args.splice(at, 2)
    return value
  }
  const tenant = option('--tenant')
  const notes = option('--notes') ?? ''
  const [target, url] = args
  if (target === undefined || url === undefined || tenant === null) throw new Error('usage: draft.ts <target> <url> --tenant <local tenant id> [--notes "..."]')
  const databaseUrl = envKey('DATABASE_URL')
  if (!/@(127\.0\.0\.1|localhost)[:/]/.test(databaseUrl)) throw new Error('draft.ts runs against the local database only')

  // The draft reads LLM and database settings only; the rest serve sends.
  const env: HostedEnv = {
    OPENAI_API_KEY: envKey('OPENAI_API_KEY'),
    DATABASE_URL: databaseUrl,
    APP_URL: '',
    API_URL: '',
    LEADACE_EDITION: '',
    GMAIL_TOKEN_ENCRYPTION_KEY: '',
    GOOGLE_CLIENT_ID: '',
    GOOGLE_CLIENT_SECRET: '',
    UNSUBSCRIBE_TOKEN_SECRET: '',
  }
  const drafted = await draftStrategyFromUrl(createDb(databaseUrl), tenant as TenantId, env, { url, notes, moreUrls: [], competitors: [] })
  if (!drafted.ok) throw new Error(`${drafted.code}: ${drafted.error}`)
  const draft = drafted.value
  const dir = resolve(DATA, target)
  mkdirSync(dir, { recursive: true })
  writeJson(resolve(dir, 'draft.json'), draft)
  writeJson(resolve(dir, 'spec.json'), {
    slug: target,
    frozenAt: utcDateKey(),
    business: draft.business,
    salesStrategy: draft.salesStrategy,
    // A new project's default: no country restriction.
    targetCountries: [],
    // The per-search floor production asks every strategy for.
    strategies: draft.discoveryStrategies.map((s) => ({ ...s, count: 10 })),
  })
  writeJson(resolve(dir, 'source.json'), { url, notes, draftedAt: new Date().toISOString(), by: 'eval/draft.ts (local database)' })
  console.log(`${target}: ${draft.targetLanguage}, strategies ${draft.discoveryStrategies.map((s) => s.slug).join(', ')}`)
}

main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    console.error(e)
    process.exit(1)
  })
