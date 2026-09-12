import { z } from 'zod'
import { and, asc, eq, isNotNull, or, sql } from 'drizzle-orm'
import type { Db } from '../db/connection'
import { sendingIdentities, projectSendingIdentities, type SendingIdentityProvider } from '../db/schema'
import { generateSendingIdentityId } from '../auth/google'
import {
  mailboxKind,
  parseSendingIdentitySecret,
  smtpImapSecretPayloadSchema,
  type MailboxKind,
} from '../domain/sending-identity'
import { verifySmtpCredentials } from './smtp-send'
import { asSendingIdentityId, type SendingIdentityId, type TenantId } from '../domain/ids'
import type { Edition } from '../domain/edition'
import {
  DEFAULT_WARMUP,
  mailboxBounceWindow,
  mailboxDailyStatus,
  type MailboxBounceWindow,
  type MailboxDailyStatus,
  type MailboxSendRefusal,
} from '../domain/warmup'
import {
  canRegisterMailbox,
  countMailboxBounceWindowByIdentity,
  countMailboxEmailSendsTodayByIdentity,
  getTenantPlan,
} from './plan-limits'
import { ok, err, type ServiceResult } from './result'

export const registerSmtpIdentitySchema = z.object({
  fromEmail: z.email(),
  ...smtpImapSecretPayloadSchema.shape,
})
export type RegisterSmtpIdentityInput = z.infer<typeof registerSmtpIdentitySchema>

export const registerGmailAliasSchema = z.object({ fromEmail: z.email() })
export type RegisterGmailAliasInput = z.infer<typeof registerGmailAliasSchema>

// Read-only connection details for display — never the app password.
export type SmtpConnectionView = {
  smtpHost: string
  smtpPort: number
  imapHost: string
  imapPort: number
  username: string
}

export type SendingIdentitySummary = {
  identityId: SendingIdentityId
  provider: SendingIdentityProvider
  kind: MailboxKind
  // The connected Gmail a Send-As alias sends through; null for every other kind.
  parentIdentityId: SendingIdentityId | null
  fromEmail: string
  warmupStartedAt: Date | null
  dailyCapOverride: number | null
  sendRefusal: MailboxSendRefusal | null
  grantedAt: Date
  smtp: SmtpConnectionView | null
} & MailboxDailyStatus &
  MailboxBounceWindow

const summaryColumns = {
  identityId: sendingIdentities.identityId,
  provider: sendingIdentities.provider,
  parentIdentityId: sendingIdentities.parentIdentityId,
  fromEmail: sendingIdentities.fromEmail,
  warmupStartedAt: sendingIdentities.warmupStartedAt,
  pausedUntil: sendingIdentities.pausedUntil,
  dailyCapOverride: sendingIdentities.dailyCapOverride,
  sendRefusal: sendingIdentities.sendRefusal,
  grantedAt: sendingIdentities.grantedAt,
} as const

type SummaryRow = {
  identityId: string
  provider: SendingIdentityProvider
  parentIdentityId: string | null
  fromEmail: string
  warmupStartedAt: Date | null
  pausedUntil: Date | null
  dailyCapOverride: number | null
  sendRefusal: MailboxSendRefusal | null
  grantedAt: Date
}

function toSummary(
  row: SummaryRow,
  smtp: SmtpConnectionView | null,
  status: MailboxDailyStatus,
  bounce: MailboxBounceWindow,
): SendingIdentitySummary {
  return {
    identityId: asSendingIdentityId(row.identityId),
    provider: row.provider,
    kind: mailboxKind(row.provider, row.parentIdentityId),
    parentIdentityId: row.parentIdentityId === null ? null : asSendingIdentityId(row.parentIdentityId),
    fromEmail: row.fromEmail,
    warmupStartedAt: row.warmupStartedAt,
    dailyCapOverride: row.dailyCapOverride,
    sendRefusal: row.sendRefusal,
    grantedAt: row.grantedAt,
    smtp,
    ...status,
    ...bounce,
  }
}

function smtpView(provider: SendingIdentityProvider, decryptedSecret: string | null): SmtpConnectionView | null {
  if (provider !== 'smtp_imap' || decryptedSecret === null) return null
  const s = parseSendingIdentitySecret(provider, decryptedSecret)
  if (s.provider !== 'smtp_imap') return null
  const { smtpHost, smtpPort, imapHost, imapPort, username } = s
  return { smtpHost, smtpPort, imapHost, imapPort, username }
}

export async function listSendingIdentities(
  db: Db,
  tenantId: TenantId,
  encryptionKey: string,
  now: Date = new Date(),
): Promise<SendingIdentitySummary[]> {
  const rows = await db
    .select({
      ...summaryColumns,
      // Decrypt only smtp_imap secrets (for the connection view) — never the gmail
      // refresh token, which this endpoint has no need to touch.
      secret: sql<string | null>`CASE WHEN ${sendingIdentities.provider} = 'smtp_imap' THEN pgp_sym_decrypt(${sendingIdentities.secret}, ${encryptionKey})::text END`,
    })
    .from(sendingIdentities)
    .where(eq(sendingIdentities.tenantId, tenantId))
    .orderBy(asc(sendingIdentities.grantedAt))
  const [usedByIdentity, bounceByIdentity] = await Promise.all([
    countMailboxEmailSendsTodayByIdentity(db, tenantId, now),
    countMailboxBounceWindowByIdentity(db, tenantId, now),
  ])
  return rows.map(({ secret, ...row }) => {
    const status = mailboxDailyStatus(row, usedByIdentity.get(row.identityId) ?? 0, DEFAULT_WARMUP, now)
    return toSummary(row, smtpView(row.provider, secret), status, mailboxBounceWindow(bounceByIdentity.get(row.identityId)))
  })
}

export async function registerSmtpIdentity(
  db: Db,
  tenantId: TenantId,
  userId: string,
  edition: Edition,
  ctx: { encryptionKey: string },
  input: RegisterSmtpIdentityInput,
): Promise<ServiceResult<SendingIdentitySummary>> {
  // Count + dup-check only: select fromEmail without decrypting any secret —
  // register has no need for appPassword / refresh tokens.
  const existing = await db
    .select({ fromEmail: sendingIdentities.fromEmail })
    .from(sendingIdentities)
    .where(eq(sendingIdentities.tenantId, tenantId))

  const { plan } = await getTenantPlan(db, tenantId, edition)
  const guard = canRegisterMailbox(plan, existing.length)
  if (guard) return guard

  if (existing.some((i) => i.fromEmail === input.fromEmail)) {
    return err('CONFLICT', 'Sending address already in use', `An identity already sends from ${input.fromEmail}.`)
  }

  // Verify credentials before storing, so a bad mailbox is rejected here, not on
  // the first real send.
  const verified = await verifySmtpCredentials({
    host: input.smtpHost,
    port: input.smtpPort,
    username: input.username,
    appPassword: input.appPassword,
  })
  if (!verified.ok) {
    return err(
      'UNPROCESSABLE',
      'Could not connect to the SMTP mailbox',
      `Check the host, port (use 465), username, and app password. ${verified.detail}`,
    )
  }

  const identityId = generateSendingIdentityId()
  const payload = JSON.stringify({
    smtpHost: input.smtpHost,
    smtpPort: input.smtpPort,
    imapHost: input.imapHost,
    imapPort: input.imapPort,
    username: input.username,
    appPassword: input.appPassword,
  })

  // ON CONFLICT (not a caught 23505): a unique violation would abort this
  // RLS-wrapped transaction and break the load below. Empty RETURNING = the
  // fromEmail race the pre-check above missed → clean 409, not a raw 500.
  const inserted = await db.execute<{ identity_id: string }>(sql`
    INSERT INTO sending_identities
      (tenant_id, identity_id, user_id, provider, from_email, scope, secret, granted_at, updated_at)
    VALUES (
      ${tenantId}, ${identityId}, ${userId}, 'smtp_imap', ${input.fromEmail}, NULL,
      pgp_sym_encrypt(${payload}::text, ${ctx.encryptionKey}), now(), now()
    )
    ON CONFLICT (tenant_id, from_email) DO NOTHING
    RETURNING identity_id
  `)
  if (inserted.length === 0) {
    return err('CONFLICT', 'Sending address already in use', `An identity already sends from ${input.fromEmail}.`)
  }

  const [created] = await db
    .select(summaryColumns)
    .from(sendingIdentities)
    .where(and(eq(sendingIdentities.tenantId, tenantId), eq(sendingIdentities.identityId, identityId)))
  if (!created) return err('INTERNAL_ERROR', 'Failed to load created sending identity')
  // A just-registered mailbox has no sends at all; its status is the warmup
  // default (week 0, no override) computed from the freshly-inserted columns.
  const status = mailboxDailyStatus(created, 0, DEFAULT_WARMUP, new Date())
  return ok(
    toSummary(
      created,
      {
        smtpHost: input.smtpHost,
        smtpPort: input.smtpPort,
        imapHost: input.imapHost,
        imapPort: input.imapPort,
        username: input.username,
      },
      status,
      mailboxBounceWindow(),
    ),
  )
}

// A Send-As alias under the caller's connected Gmail: the address must already
// be a verified "Send mail as" entry in that Gmail account — there is no scope
// to check it here, so an unverified one fails at its first send.
export async function registerGmailAlias(
  db: Db,
  tenantId: TenantId,
  userId: string,
  edition: Edition,
  input: RegisterGmailAliasInput,
): Promise<ServiceResult<SendingIdentitySummary>> {
  const existing = await db
    .select({
      identityId: sendingIdentities.identityId,
      userId: sendingIdentities.userId,
      provider: sendingIdentities.provider,
      parentIdentityId: sendingIdentities.parentIdentityId,
      fromEmail: sendingIdentities.fromEmail,
    })
    .from(sendingIdentities)
    .where(eq(sendingIdentities.tenantId, tenantId))

  const { plan } = await getTenantPlan(db, tenantId, edition)
  const guard = canRegisterMailbox(plan, existing.length)
  if (guard) return guard

  const parent = existing.find((i) => i.userId === userId && i.provider === 'gmail_oauth' && i.parentIdentityId === null)
  if (!parent) {
    return err('PRECONDITION_FAILED', 'Gmail not connected', 'Connect your Google account in Account settings before adding a Send-As alias.')
  }
  if (existing.some((i) => i.fromEmail === input.fromEmail)) {
    return err('CONFLICT', 'Sending address already in use', `An identity already sends from ${input.fromEmail}.`)
  }

  const identityId = generateSendingIdentityId()
  // ON CONFLICT (not a caught 23505): a unique violation would abort this
  // RLS-wrapped transaction. Empty RETURNING = the fromEmail race the pre-check missed.
  const inserted = await db
    .insert(sendingIdentities)
    .values({
      tenantId,
      identityId,
      userId,
      provider: 'gmail_oauth',
      fromEmail: input.fromEmail,
      parentIdentityId: parent.identityId,
      scope: null,
      secret: null,
    })
    .onConflictDoNothing({ target: [sendingIdentities.tenantId, sendingIdentities.fromEmail] })
    .returning({ identityId: sendingIdentities.identityId })
  if (inserted.length === 0) {
    return err('CONFLICT', 'Sending address already in use', `An identity already sends from ${input.fromEmail}.`)
  }

  const [created] = await db
    .select(summaryColumns)
    .from(sendingIdentities)
    .where(and(eq(sendingIdentities.tenantId, tenantId), eq(sendingIdentities.identityId, identityId)))
  if (!created) return err('INTERNAL_ERROR', 'Failed to load created sending identity')
  return ok(toSummary(created, null, mailboxDailyStatus(created, 0, DEFAULT_WARMUP, new Date()), mailboxBounceWindow()))
}

export async function deleteSendingIdentity(
  db: Db,
  tenantId: TenantId,
  identityId: SendingIdentityId,
): Promise<ServiceResult<{ deleted: true }>> {
  // A project still listing it would block the FK delete — surface a clean conflict.
  const refs = await db
    .select({ projectId: projectSendingIdentities.projectId })
    .from(projectSendingIdentities)
    .where(and(eq(projectSendingIdentities.tenantId, tenantId), eq(projectSendingIdentities.identityId, identityId)))
  if (refs.length > 0) {
    return err(
      'CONFLICT',
      'Sending identity is in use',
      `Used by ${refs.length} project(s). Remove it from their sending mailboxes first.`,
    )
  }

  // The connected Gmail is managed via the Google connect/disconnect flow; SMTP
  // mailboxes and Send-As aliases are deleted here.
  const deleted = await db
    .delete(sendingIdentities)
    .where(
      and(
        eq(sendingIdentities.tenantId, tenantId),
        eq(sendingIdentities.identityId, identityId),
        or(eq(sendingIdentities.provider, 'smtp_imap'), isNotNull(sendingIdentities.parentIdentityId)),
      ),
    )
    .returning({ identityId: sendingIdentities.identityId })
  if (deleted.length === 0) return err('NOT_FOUND', 'Sending identity not found')
  return ok({ deleted: true })
}
