// Shared plumbing for the hosted-agent stages: the env slice they need, the
// caller identity they write documents as, and small loaders every stage
// repeats. Stages are services — they take (db, tenantId, …) and return
// ServiceResult — and never know whether a Workflow or a chat turn invoked them.
import type { Db } from '../../db/connection'
import type { ProjectId, TenantId } from '../../domain/ids'
import { parseEdition, type Edition } from '../../domain/edition'
import type { GeminiEnv } from '../gemini'
import type { OpenAIEnv } from '../openai'
import type { SendContext } from '../outreach'
import type { GoogleCtx } from '../google-auth'
import { getDocument } from '../documents'
import { getMasterDocument } from '../master-documents'
import { ok, err, type ServiceResult } from '../result'

export type HostedEnv = GeminiEnv &
  OpenAIEnv & {
    DATABASE_URL: string
    APP_URL: string
    API_URL: string
    LEADACE_EDITION: string
    GMAIL_TOKEN_ENCRYPTION_KEY: string
    GOOGLE_CLIENT_ID: string
    GOOGLE_CLIENT_SECRET: string
    UNSUBSCRIBE_TOKEN_SECRET: string
    E2E_RECIPIENT_OVERRIDE?: string
    EMAILABLE_API_KEY?: string
  }

// Every write a stage makes is an agent write: playbooks it reads must be
// approved, and documents it saves wait for a person where the slug requires.
export const STAGE_CALLER = 'agent' as const

export function editionOf(env: HostedEnv): Edition {
  return parseEdition(env.LEADACE_EDITION)
}

export function sendContextOf(env: HostedEnv): SendContext {
  return {
    encryptionKey: env.GMAIL_TOKEN_ENCRYPTION_KEY,
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    appUrl: env.APP_URL,
    apiUrl: env.API_URL,
    unsubscribeSecret: env.UNSUBSCRIBE_TOKEN_SECRET,
    e2eRecipientOverride: env.E2E_RECIPIENT_OVERRIDE ?? null,
    emailVerifyApiKey: env.EMAILABLE_API_KEY ?? null,
  }
}

export function googleCtxOf(env: HostedEnv): GoogleCtx {
  return {
    encryptionKey: env.GMAIL_TOKEN_ENCRYPTION_KEY,
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    e2eRecipientOverride: env.E2E_RECIPIENT_OVERRIDE ?? null,
  }
}

// Progress a stage reports while it runs; the job layer persists it.
export type ProgressFn = (step: string, done: number, total: number | null) => Promise<void>
export const noProgress: ProgressFn = async () => {}

// A missing optional document is an empty string; a missing required one is
// the stage's precondition failure.
export async function loadDoc(db: Db, tenantId: TenantId, projectId: ProjectId, slug: string): Promise<string | null> {
  const doc = await getDocument(db, tenantId, STAGE_CALLER, { id: projectId, slug })
  return doc.ok ? doc.value.content : null
}

export async function requireStrategyDocs(
  db: Db,
  tenantId: TenantId,
  projectId: ProjectId,
): Promise<ServiceResult<{ business: string; salesStrategy: string }>> {
  const [business, salesStrategy] = await Promise.all([
    loadDoc(db, tenantId, projectId, 'business'),
    loadDoc(db, tenantId, projectId, 'sales_strategy'),
  ])
  if (business === null || salesStrategy === null) {
    return err(
      'PRECONDITION_FAILED',
      'Project strategy not set up',
      'The business and sales_strategy documents are missing — finish onboarding (paste the company URL in chat) first.',
    )
  }
  return ok({ business, salesStrategy })
}

export async function loadMasterDoc(db: Db, slug: string): Promise<string> {
  const doc = await getMasterDocument(db, slug)
  if (!doc.ok) throw new Error(`master document ${slug} is not seeded`)
  return doc.value.content
}

// The industry vocabulary is the backticked items of tpl_industries.
export function parseIndustryVocabulary(markdown: string): string[] {
  return [...markdown.matchAll(/^- `([^`]+)`$/gm)].map((m) => m[1]!)
}

export function apexDomainOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return null
  }
}

