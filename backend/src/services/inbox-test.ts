import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '../db/connection'
import { runWithRls } from '../db/rls'
import { sendingIdentities } from '../db/schema'
import { sendForIdentity } from '../auth/google'
import { asSendingIdentityId, asTenantId, type SendingIdentityId, type TenantId } from '../domain/ids'
import { imapQuoted, imapTaggedStatus, parseSpecialUseMailboxes, parseUidSearch } from '../domain/imap'
import {
  inboxTestDue,
  inboxTestHolds,
  inboxTestSeedsSchema,
  judgeInboxTest,
  type InboxTestResult,
  type InboxTestSeed,
  type SeedPlacement,
} from '../domain/inbox-test'
import { DEFAULT_WARMUP, mailboxDailyCap, type MailboxSendRefusal } from '../domain/warmup'
import { withImapSession } from './imap-poll'
import { renderSentEmail, type SendContext } from './outreach'

// Runs on the hourly cron's raw connection (no RLS): every write filters by
// tenant_id, and the email is rendered inside the tenant's RLS transaction.

// seedReadErrors > 0: a seed could not be read, so its copies did not vote.
export type InboxTestSummary = { tested: number; held: number; sent: number; failed: number; seedReadErrors: number }

// Delivery takes seconds; sending and reading in one run keeps the copies'
// Message-IDs out of the DB. Sending, the wait and the reads (one session per
// seed) stay inside the cron's 15-minute wall time; mailboxes left over are due next tick.
const SEND_BUDGET_MS = 4 * 60 * 1000
const READ_DELAY_MS = 5 * 60 * 1000
const SEED_READ_TIMEOUT_MS = 30_000
// Keeps each seed's session inside its timeout.
const MAX_PROBES_PER_RUN = 40

// messageId: the copy's Message-ID as the provider sent it; null when it was
// not read back, so the copy cannot be found.
type Probe = {
  tenantId: TenantId
  identityId: SendingIdentityId
  previous: InboxTestResult | null
  copies: Array<{ address: string; messageId: string | null }>
}

export function parseInboxTestSeeds(raw: string | undefined): InboxTestSeed[] {
  if (!raw) return []
  try {
    const parsed = inboxTestSeedsSchema.safeParse(JSON.parse(raw))
    if (parsed.success) return parsed.data
  } catch {}
  console.error('[inbox-test] INBOX_TEST_SEEDS is not a valid seed list; no inbox tests run')
  return []
}

export async function runInboxTests(
  db: Db,
  ctx: SendContext,
  seeds: InboxTestSeed[],
  now: Date,
): Promise<InboxTestSummary> {
  const summary: InboxTestSummary = { tested: 0, held: 0, sent: 0, failed: 0, seedReadErrors: 0 }
  if (seeds.length === 0) return summary
  const probes = await sendProbes(db, ctx, seeds, now, summary)
  if (probes.length === 0) return summary
  await new Promise((resolve) => setTimeout(resolve, READ_DELAY_MS))
  const observed = await readSeeds(seeds, probes, summary)

  for (const { tenantId, identityId, previous, copies } of probes) {
    try {
      const placements = copies.map((c) => (c.messageId === null ? null : (observed.get(seedKey(c.address, c.messageId)) ?? null)))
      const result = judgeInboxTest(placements, previous, now)
      if (!result) {
        console.log(`[inbox-test] tenant=${tenantId} identity=${identityId} previous result kept: placements=${placements.join(',')}`)
        continue
      }
      await db
        .update(sendingIdentities)
        .set({ inboxTestResult: result })
        .where(and(eq(sendingIdentities.tenantId, tenantId), eq(sendingIdentities.identityId, identityId)))
      summary.tested++
      if (inboxTestHolds(result)) summary.held++
      console.log(`[inbox-test] tenant=${tenantId} identity=${identityId} inbox=${result.inbox} spam=${result.spam} missing=${result.missing}`)
    } catch (e) {
      console.error(`[inbox-test] tenant=${tenantId} identity=${identityId} recording the result failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return summary
}

const seedKey = (address: string, messageId: string) => `${address} ${messageId}`

async function readSeeds(seeds: InboxTestSeed[], probes: Probe[], summary: InboxTestSummary): Promise<Map<string, SeedPlacement>> {
  const observed = new Map<string, SeedPlacement>()
  for (const seed of seeds) {
    const ids = probes.flatMap((p) => p.copies.flatMap((c) => (c.address === seed.address && c.messageId !== null ? [c.messageId] : [])))
    if (ids.length === 0) continue
    try {
      await readSeed(seed, ids, (id, placement) => observed.set(seedKey(seed.address, id), placement))
    } catch (e) {
      summary.seedReadErrors++
      console.error(`[inbox-test] reading seed ${seed.address} failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return observed
}

// Reports each copy as it is found; a copy is missing only once both folders
// were searched. Without a \Junk mailbox nothing is reported: a copy outside
// the inbox could be either.
async function readSeed(seed: InboxTestSeed, messageIds: string[], onObserved: (messageId: string, placement: SeedPlacement) => void): Promise<void> {
  const conn = { host: seed.imapHost, port: seed.imapPort, username: seed.address, appPassword: seed.appPassword }
  await withImapSession(conn, SEED_READ_TIMEOUT_MS, async ({ command, expectOk }) => {
    const list = await command('LIST "" "*"')
    expectOk(list.tag, list.response, 'LIST')
    const { junk, trash } = parseSpecialUseMailboxes(list.response)
    if (!junk) {
      console.error(`[inbox-test] seed ${seed.address} names no \\Junk mailbox; it cannot be read`)
      return
    }
    if (!trash) console.error(`[inbox-test] seed ${seed.address} names no \\Trash mailbox; read copies stay in place`)

    const unfound = new Set(messageIds)
    const folders: Array<[string, SeedPlacement]> = [['INBOX', 'inbox'], [junk, 'spam']]
    for (const [folder, placement] of folders) {
      const select = await command(`SELECT ${imapQuoted(folder)}`)
      expectOk(select.tag, select.response, 'SELECT')
      for (const id of [...unfound]) {
        const search = await command(`UID SEARCH HEADER Message-ID ${imapQuoted(id)}`)
        expectOk(search.tag, search.response, 'SEARCH')
        const uids = parseUidSearch(search.response)
        if (uids.length === 0) continue
        unfound.delete(id)
        onObserved(id, placement)
        if (!trash) continue
        // The copy carries a prospect's name and company; the provider empties its trash.
        const move = await command(`UID MOVE ${uids.join(',')} ${imapQuoted(trash)}`)
        if (imapTaggedStatus(move.response, move.tag) !== 'OK') {
          console.error(`[inbox-test] seed ${seed.address} could not move a read copy to ${trash}`)
        }
      }
    }
    for (const id of unfound) onObserved(id, 'missing')
    await command('LOGOUT').catch(() => {})
  })
}

type ProbeCandidate = {
  tenant_id: string
  identity_id: string
  outreach_log_id: number | string
  last_sent_at: string | Date
  test_sent_at: string | Date | null
  result: string | null
  warmup_started_at: string | Date | null
  daily_cap_override: number | string | null
  paused_until: string | Date | null
  send_refusal: string | null
}

const parsed = <T>(text: string | null): T | null => (text === null ? null : (JSON.parse(text) as T))
const dated = (v: string | Date | null): Date | null => (v === null ? null : new Date(v))

async function sendProbes(db: Db, ctx: SendContext, seeds: InboxTestSeed[], now: Date, summary: InboxTestSummary): Promise<Probe[]> {
  // The probe is the mailbox's latest first touch: what it sends cold.
  const candidates = await db.execute<ProbeCandidate>(sql`
    SELECT si.tenant_id, si.identity_id, latest.id AS outreach_log_id, latest.sent_at AS last_sent_at,
      si.inbox_test_sent_at AS test_sent_at, si.inbox_test_result::text AS result,
      si.warmup_started_at, si.daily_cap_override, si.paused_until, si.send_refusal::text AS send_refusal
    FROM sending_identities si
    LEFT JOIN sending_identities parent
      ON parent.tenant_id = si.tenant_id AND parent.identity_id = si.parent_identity_id
    JOIN LATERAL (
      SELECT ol.id, ol.sent_at FROM outreach_logs ol
      WHERE ol.tenant_id = si.tenant_id AND ol.sending_identity_id = si.identity_id
        AND ol.channel = 'email' AND ol.status = 'sent' AND ol.touch_number = 1
      ORDER BY ol.sent_at DESC
      LIMIT 1
    ) latest ON true
    WHERE COALESCE(parent.auth_revoked_at, si.auth_revoked_at) IS NULL
    ORDER BY si.inbox_test_sent_at ASC NULLS FIRST
  `)

  const sendUntil = Date.now() + SEND_BUDGET_MS
  const probes: Probe[] = []
  for (const c of candidates) {
    if (probes.length >= MAX_PROBES_PER_RUN || Date.now() > sendUntil) break
    const tenantId = asTenantId(c.tenant_id)
    const identityId = asSendingIdentityId(c.identity_id)
    try {
      const previous = parsed<InboxTestResult>(c.result)
      if (!inboxTestDue(new Date(c.last_sent_at), dated(c.test_sent_at), previous, now)) continue
      // The person's pause or zero cap and a provider's refusal stop the probe
      // too; only the test's own hold does not.
      const capWithoutTest = mailboxDailyCap(
        {
          warmupStartedAt: dated(c.warmup_started_at),
          dailyCapOverride: c.daily_cap_override === null ? null : Number(c.daily_cap_override),
          pausedUntil: dated(c.paused_until),
          sendRefusal: parsed<MailboxSendRefusal>(c.send_refusal),
          inboxTestResult: null,
        },
        DEFAULT_WARMUP,
        now,
      )
      if (capWithoutTest === 0) continue
      const copies = await sendProbe(db, ctx, seeds, tenantId, identityId, Number(c.outreach_log_id))
      if (copies.length === 0) {
        summary.failed++
        continue
      }
      await db
        .update(sendingIdentities)
        .set({ inboxTestSentAt: now })
        .where(and(eq(sendingIdentities.tenantId, tenantId), eq(sendingIdentities.identityId, identityId)))
      probes.push({ tenantId, identityId, previous, copies })
      summary.sent++
    } catch (e) {
      summary.failed++
      console.error(`[inbox-test] tenant=${tenantId} identity=${identityId} probe failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return probes
}

async function sendProbe(
  db: Db,
  ctx: SendContext,
  seeds: InboxTestSeed[],
  tenantId: TenantId,
  identityId: SendingIdentityId,
  outreachLogId: number,
): Promise<Probe['copies']> {
  const email = await runWithRls(db, tenantId, (tx) => renderSentEmail(tx, tenantId, ctx, outreachLogId))
  if (!email.ok) {
    console.error(`[inbox-test] tenant=${tenantId} identity=${identityId} cannot render outreach ${outreachLogId}: ${email.error}`)
    return []
  }
  const copies: Probe['copies'] = []
  for (const seed of seeds) {
    const r = await sendForIdentity(db, {
      tenantId,
      identityId,
      encryptionKey: ctx.encryptionKey,
      clientId: ctx.clientId,
      clientSecret: ctx.clientSecret,
      to: [seed.address],
      subject: email.value.subject,
      body: email.value.body,
      extraHeaders: email.value.headers,
      senderDisplayName: email.value.senderDisplayName,
      e2eRecipientOverride: ctx.e2eRecipientOverride,
    })
    if (!r.ok) {
      console.error(`[inbox-test] tenant=${tenantId} identity=${identityId} send to seed failed: ${r.error} ${r.detail}`)
      break
    }
    copies.push({ address: seed.address, messageId: r.rfc822MessageId })
  }
  return copies
}
