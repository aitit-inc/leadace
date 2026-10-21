import { and, eq, isNull, lte, or, sql } from 'drizzle-orm'
import type { Db } from '../db/connection'
import { runWithRls } from '../db/rls'
import { sendingIdentities } from '../db/schema'
import { sendForIdentity } from '../auth/google'
import { asSendingIdentityId, asTenantId, type SendingIdentityId, type TenantId } from '../domain/ids'
import { getHeader, parseTopHeaders } from '../domain/email-message'
import {
  imapQuoted,
  imapSearchDate,
  imapTaggedStatus,
  parseFetchMessages,
  parseSpecialUseMailboxes,
  parseUidSearch,
} from '../domain/imap'
import { normalizeMessageId } from '../domain/reply'
import {
  CONTENT_CHANGES,
  inboxTestDue,
  inboxTestHolds,
  inboxTestSeedsSchema,
  judgeInboxTest,
  type InboxTestResult,
  type InboxTestSeed,
  type SeedPlacement,
  type SinceInboxTest,
} from '../domain/inbox-test'
import { DEFAULT_WARMUP, mailboxDailyCap, type MailboxSendRefusal } from '../domain/warmup'
import { withImapSession, type ImapSession } from './imap-poll'
import { renderSentEmail, type SendContext } from './outreach'
import { err, ok, type ServiceResult } from './result'

// jobs/inbox-test.ts runs the steps below on a raw connection (no RLS): every
// write filters by tenant_id, and the email is rendered inside the tenant's
// RLS transaction.

const SEED_READ_TIMEOUT_MS = 60_000
const DAY_MS = 24 * 60 * 60 * 1000
// Longer than a test runs, so a claim this recent belongs to a running test.
const RETEST_AFTER_MS = 5 * 60 * 1000

// claimedAt: the inbox_test_sent_at this test set when it claimed the mailbox.
// Its result is written only while the mailbox still holds that claim, so an
// older test never overwrites a newer one.
export type ProbeTarget = {
  tenantId: TenantId
  identityId: SendingIdentityId
  outreachLogId: number
  previous: InboxTestResult | null
  claimedAt: string
}

// messageId: the copy's Message-ID as the provider sent it; null when it was
// not read back, so the copy cannot be found.
export type Probe = {
  target: ProbeTarget
  copies: Array<{ address: string; messageId: string | null }>
}

export type InboxTestParams = { targets: ProbeTarget[] }

// seedReadErrors > 0: a seed could not be read, so its copies did not vote.
export type SeedObservations = { placements: Record<string, SeedPlacement>; seedReadErrors: number }

export function parseInboxTestSeeds(raw: string | undefined): InboxTestSeed[] {
  if (!raw) return []
  try {
    const parsed = inboxTestSeedsSchema.safeParse(JSON.parse(raw))
    if (parsed.success) return parsed.data
  } catch {}
  console.error('[inbox-test] INBOX_TEST_SEEDS is not a valid seed list; no inbox tests run')
  return []
}

// seeds: only whether any are set; the Workflow reads them from its env, so
// their app passwords never enter its saved params.
export async function scheduleInboxTests(
  db: Db,
  tests: Workflow<InboxTestParams>,
  seeds: InboxTestSeed[],
  now: Date,
): Promise<number> {
  if (seeds.length === 0) return 0
  const due = (await probeCandidates(db, null, now)).filter((c) => c.canSend && inboxTestDue(c.since, c.previous))
  return launchInboxTests(db, tests, due)
}

export async function startInboxTest(
  db: Db,
  tests: Workflow<InboxTestParams>,
  seeds: InboxTestSeed[],
  tenantId: TenantId,
  identityId: SendingIdentityId,
): Promise<ServiceResult<{ started: true }>> {
  if (seeds.length === 0) {
    return err('UNPROCESSABLE', 'Inbox tests not set up', 'This server has no test inboxes (INBOX_TEST_SEEDS), so it cannot run an inbox test.')
  }
  const now = new Date()
  const [c] = await probeCandidates(db, { tenantId, identityId }, now)
  if (!c) {
    return err('UNPROCESSABLE', 'Nothing to test', 'This mailbox has sent no cold email to test, or its Google connection needs reconnecting.')
  }
  if (!c.canSend) {
    return err('UNPROCESSABLE', 'Mailbox cannot send', 'This mailbox is paused, capped at 0 or refused by its provider, so it cannot send the test.')
  }
  if ((await launchInboxTests(db, tests, [c])) === 0) {
    return err('CONFLICT', 'Test already running', 'This mailbox was tested in the last few minutes; reload for its result.')
  }
  return ok({ started: true })
}

// The hourly run and Test now both start tests here. One Workflow tests every
// mailbox it claimed, so each seed is read in one session however many there are.
async function launchInboxTests(db: Db, tests: Workflow<InboxTestParams>, candidates: Candidate[]): Promise<number> {
  const targets: ProbeTarget[] = []
  for (const c of candidates) {
    const claimedAt = await claimInboxTest(db, c.tenantId, c.identityId)
    if (!claimedAt) continue
    const { tenantId, identityId, outreachLogId, previous } = c
    targets.push({ tenantId, identityId, outreachLogId, previous, claimedAt: claimedAt.toISOString() })
  }
  if (targets.length === 0) return 0
  await tests.create({ params: { targets } })
  return targets.length
}

// Null: another test holds the mailbox, so a second press or an overlapping run does not test it twice.
// A test that sends nothing keeps its claim, so a mailbox whose sends keep failing is not retried hourly.
async function claimInboxTest(db: Db, tenantId: TenantId, identityId: SendingIdentityId): Promise<Date | null> {
  const at = new Date()
  const claimed = await db
    .update(sendingIdentities)
    .set({ inboxTestSentAt: at })
    .where(
      and(
        eq(sendingIdentities.tenantId, tenantId),
        eq(sendingIdentities.identityId, identityId),
        or(isNull(sendingIdentities.inboxTestSentAt), lte(sendingIdentities.inboxTestSentAt, new Date(at.getTime() - RETEST_AFTER_MS))),
      ),
    )
    .returning({ identityId: sendingIdentities.identityId })
  return claimed.length > 0 ? at : null
}

// One copy per Workflow step, so a step the runtime reruns resends at most one
// copy. Null when it was not sent; the error is logged, not thrown, so one
// mailbox's failure does not stop the others.
export async function sendCopy(
  db: Db,
  ctx: SendContext,
  seed: InboxTestSeed,
  target: ProbeTarget,
): Promise<{ messageId: string | null } | null> {
  const { tenantId, identityId } = target
  try {
    const email = await runWithRls(db, tenantId, (tx) => renderSentEmail(tx, tenantId, ctx, target.outreachLogId))
    if (!email.ok) {
      console.error(`[inbox-test] tenant=${tenantId} identity=${identityId} cannot render outreach ${target.outreachLogId}: ${email.error}`)
      return null
    }
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
      return null
    }
    return { messageId: r.rfc822MessageId }
  } catch (e) {
    console.error(`[inbox-test] tenant=${tenantId} identity=${identityId} probe failed: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

const seedKey = (address: string, messageId: string) => `${address} ${messageId}`

const copiesAt = (probes: Probe[], seed: InboxTestSeed): string[] =>
  probes.flatMap((p) => p.copies.flatMap((c) => (c.address === seed.address && c.messageId !== null ? [c.messageId] : [])))

// Reads only: the copies stay where they are until recordResults has kept what
// this saw, so a rerun of the step sees the same placements.
export async function readSeeds(seeds: InboxTestSeed[], probes: Probe[]): Promise<SeedObservations> {
  const observed: SeedObservations = { placements: {}, seedReadErrors: 0 }
  for (const seed of seeds) {
    const ids = copiesAt(probes, seed)
    if (ids.length === 0) continue
    try {
      await readSeed(seed, ids, (id, placement) => {
        observed.placements[seedKey(seed.address, id)] = placement
      })
    } catch (e) {
      observed.seedReadErrors++
      console.error(`[inbox-test] reading seed ${seed.address} failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return observed
}

// Throws on a failed write, so the step retries before any copy is moved.
export async function recordResults(db: Db, probes: Probe[], observed: SeedObservations): Promise<{ tested: number; held: number }> {
  const summary = { tested: 0, held: 0 }
  const testedAt = new Date()
  for (const { target, copies } of probes) {
    const { tenantId, identityId } = target
    const placements = copies.map((c) => (c.messageId === null ? null : (observed.placements[seedKey(c.address, c.messageId)] ?? null)))
    const result = judgeInboxTest(placements, target.previous, testedAt)
    if (!result) {
      console.log(`[inbox-test] tenant=${tenantId} identity=${identityId} previous result kept: placements=${placements.join(',')}`)
      continue
    }
    const written = await db
      .update(sendingIdentities)
      .set({ inboxTestResult: result })
      .where(
        and(
          eq(sendingIdentities.tenantId, tenantId),
          eq(sendingIdentities.identityId, identityId),
          eq(sendingIdentities.inboxTestSentAt, new Date(target.claimedAt)),
        ),
      )
      .returning({ identityId: sendingIdentities.identityId })
    if (written.length === 0) {
      console.log(`[inbox-test] tenant=${tenantId} identity=${identityId} a newer test claimed the mailbox; this result is dropped`)
      continue
    }
    summary.tested++
    if (inboxTestHolds(result)) summary.held++
    console.log(`[inbox-test] tenant=${tenantId} identity=${identityId} inbox=${result.inbox} spam=${result.spam} missing=${result.missing}`)
  }
  return summary
}

// The copies carry a prospect's name and company; the provider empties its trash.
export async function cleanSeeds(seeds: InboxTestSeed[], probes: Probe[]): Promise<void> {
  for (const seed of seeds) {
    const ids = copiesAt(probes, seed)
    if (ids.length === 0) continue
    try {
      await cleanSeed(seed, ids)
    } catch (e) {
      console.error(`[inbox-test] cleaning seed ${seed.address} failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

const seedConnection = (seed: InboxTestSeed) => ({
  host: seed.imapHost,
  port: seed.imapPort,
  username: seed.address,
  appPassword: seed.appPassword,
})

// A copy is missing only once both folders were read. Without a \Junk mailbox
// nothing is reported: a copy outside the inbox could be either.
async function readSeed(seed: InboxTestSeed, messageIds: string[], onObserved: (messageId: string, placement: SeedPlacement) => void): Promise<void> {
  await withImapSession(seedConnection(seed), SEED_READ_TIMEOUT_MS, async (session) => {
    const { junk } = await seedMailboxes(session)
    if (!junk) {
      console.error(`[inbox-test] seed ${seed.address} names no \\Junk mailbox; it cannot be read`)
      return
    }
    const unfound = new Set(messageIds)
    const folders: Array<[string, SeedPlacement]> = [['INBOX', 'inbox'], [junk, 'spam']]
    for (const [folder, placement] of folders) {
      for (const { id } of await findCopies(session, folder, messageIds)) {
        if (unfound.delete(id)) onObserved(id, placement)
      }
    }
    for (const id of unfound) onObserved(id, 'missing')
    await session.command('LOGOUT').catch(() => {})
  })
}

async function cleanSeed(seed: InboxTestSeed, messageIds: string[]): Promise<void> {
  await withImapSession(seedConnection(seed), SEED_READ_TIMEOUT_MS, async (session) => {
    const { junk, trash } = await seedMailboxes(session)
    if (!trash) {
      console.error(`[inbox-test] seed ${seed.address} names no \\Trash mailbox; read copies stay in place`)
      return
    }
    for (const folder of junk ? ['INBOX', junk] : ['INBOX']) {
      const uids = (await findCopies(session, folder, messageIds)).map((c) => c.uid)
      if (uids.length === 0) continue
      const move = await session.command(`UID MOVE ${uids.join(',')} ${imapQuoted(trash)}`)
      if (imapTaggedStatus(move.response, move.tag) !== 'OK') {
        console.error(`[inbox-test] seed ${seed.address} could not move read copies to ${trash}`)
      }
    }
    await session.command('LOGOUT').catch(() => {})
  })
}

async function seedMailboxes({ command, expectOk }: ImapSession): Promise<{ junk: string | null; trash: string | null }> {
  const list = await command('LIST "" "*"')
  expectOk(list.tag, list.response, 'LIST')
  return parseSpecialUseMailboxes(list.response)
}

// A round trip from the Worker took seconds, so a folder costs the same few
// commands however many copies it holds. Leaves the folder selected.
async function findCopies({ command, expectOk }: ImapSession, folder: string, messageIds: string[]): Promise<Array<{ uid: number; id: string }>> {
  const wanted = new Map(messageIds.map((id) => [normalizeMessageId(id), id]))
  const select = await command(`SELECT ${imapQuoted(folder)}`)
  expectOk(select.tag, select.response, 'SELECT')
  // SINCE is a date in the server's timezone; a day back covers copies sent minutes ago.
  const search = await command(`UID SEARCH SINCE ${imapSearchDate(new Date(Date.now() - DAY_MS))}`)
  expectOk(search.tag, search.response, 'SEARCH')
  const recent = parseUidSearch(search.response)
  if (recent.length === 0) return []
  const fetch = await command(`UID FETCH ${recent.join(',')} (UID BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)])`)
  expectOk(fetch.tag, fetch.response, 'FETCH')
  return parseFetchMessages(fetch.response).flatMap(({ uid, raw }) => {
    const header = getHeader(parseTopHeaders(raw), 'message-id')
    const id = header === null ? undefined : wanted.get(normalizeMessageId(header))
    return id === undefined ? [] : [{ uid, id }]
  })
}

type CandidateRow = {
  tenant_id: string
  identity_id: string
  outreach_log_id: number | string
  test_sent_at: string | Date | null
  first_touches: number | string
  content_changed_at: string | Date | null
  result: string | null
  warmup_started_at: string | Date | null
  daily_cap_override: number | string | null
  paused_until: string | Date | null
  send_refusal: string | null
}

type Candidate = {
  tenantId: TenantId
  identityId: SendingIdentityId
  outreachLogId: number
  previous: InboxTestResult | null
  since: SinceInboxTest
  canSend: boolean
}

const parsed = <T>(text: string | null): T | null => (text === null ? null : (JSON.parse(text) as T))
const dated = (v: string | Date | null): Date | null => (v === null ? null : new Date(v))

async function probeCandidates(
  db: Db,
  only: { tenantId: TenantId; identityId: SendingIdentityId } | null,
  now: Date,
): Promise<Candidate[]> {
  // The probe is the mailbox's latest first touch: what it sends cold.
  const rows = await db.execute<CandidateRow>(sql`
    SELECT si.tenant_id, si.identity_id, latest.id AS outreach_log_id,
      si.inbox_test_sent_at AS test_sent_at, si.inbox_test_result::text AS result,
      (SELECT count(*) FROM outreach_logs ol
        WHERE ol.tenant_id = si.tenant_id AND ol.sending_identity_id = si.identity_id
          AND ol.channel = 'email' AND ol.status = 'sent' AND ol.touch_number = 1
          AND ol.sent_at > si.inbox_test_sent_at) AS first_touches,
      (SELECT max(pc.created_at) FROM policy_changes pc
        WHERE pc.tenant_id = si.tenant_id AND pc.project_id = latest.project_id
          AND pc.target IN (${sql.join(CONTENT_CHANGES.map((t) => sql`${t}`), sql`, `)})
          AND pc.created_at < latest.sent_at) AS content_changed_at,
      si.warmup_started_at, si.daily_cap_override, si.paused_until, si.send_refusal::text AS send_refusal
    FROM sending_identities si
    LEFT JOIN sending_identities parent
      ON parent.tenant_id = si.tenant_id AND parent.identity_id = si.parent_identity_id
    JOIN LATERAL (
      SELECT ol.id, ol.project_id, ol.sent_at FROM outreach_logs ol
      WHERE ol.tenant_id = si.tenant_id AND ol.sending_identity_id = si.identity_id
        AND ol.channel = 'email' AND ol.status = 'sent' AND ol.touch_number = 1
      ORDER BY ol.sent_at DESC
      LIMIT 1
    ) latest ON true
    WHERE COALESCE(parent.auth_revoked_at, si.auth_revoked_at) IS NULL
      ${only ? sql`AND si.tenant_id = ${only.tenantId} AND si.identity_id = ${only.identityId}` : sql``}
  `)
  return rows.map((c) => ({
    tenantId: asTenantId(c.tenant_id),
    identityId: asSendingIdentityId(c.identity_id),
    outreachLogId: Number(c.outreach_log_id),
    previous: parsed<InboxTestResult>(c.result),
    since: { testSentAt: dated(c.test_sent_at), firstTouches: Number(c.first_touches), contentChangedAt: dated(c.content_changed_at) },
    // The person's pause or zero cap and a provider's refusal stop the probe
    // too; only the test's own hold does not.
    canSend:
      mailboxDailyCap(
        {
          warmupStartedAt: dated(c.warmup_started_at),
          dailyCapOverride: c.daily_cap_override === null ? null : Number(c.daily_cap_override),
          pausedUntil: dated(c.paused_until),
          sendRefusal: parsed<MailboxSendRefusal>(c.send_refusal),
          inboxTestResult: null,
        },
        DEFAULT_WARMUP,
        now,
      ) > 0,
  }))
}
