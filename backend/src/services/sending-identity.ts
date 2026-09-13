import { z } from 'zod'
import { and, asc, eq, or, sql } from 'drizzle-orm'
import type { Db } from '../db/connection'
import { projects, sendingIdentities, projectSendingIdentities, type SendingIdentityProvider } from '../db/schema'
import {
  GoogleAuthError,
  exchangeGoogleAuthorizationCode,
  generateSendingIdentityId,
  saveGmailRefreshToken,
  type GoogleCodeExchange,
} from '../auth/google'
import { buildGoogleAuthorizationUrl, parseIdTokenEmail } from '../domain/google-oauth'
import {
  GOOGLE_MAILBOX_SCOPES,
  hasGmailSendScope,
  mailboxKind,
  parseSendingIdentitySecret,
  smtpImapSecretPayloadSchema,
  type MailboxKind,
} from '../domain/sending-identity'
import { verifySmtpCredentials } from './smtp-send'
import { verifyImapCredentials } from './imap-poll'
import { asSendingIdentityId, sendingIdentityIdSchema, type SendingIdentityId, type TenantId } from '../domain/ids'
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

export const registerGmailAliasSchema = z.object({
  fromEmail: z.email(),
  // The connected Gmail the alias sends through.
  parentIdentityId: sendingIdentityIdSchema,
})
export type RegisterGmailAliasInput = z.infer<typeof registerGmailAliasSchema>

// `state` is the browser's CSRF nonce, echoed back by Google; `loginHint`
// preselects the account when reconnecting a revoked mailbox.
export const googleMailboxAuthorizationSchema = z.object({
  state: z.string().min(16).max(128),
  loginHint: z.email().optional(),
})
export type GoogleMailboxAuthorizationInput = z.infer<typeof googleMailboxAuthorizationSchema>

export const registerGoogleMailboxSchema = z.object({ code: z.string().min(1).max(2048) })
export type RegisterGoogleMailboxInput = z.infer<typeof registerGoogleMailboxSchema>

export type GoogleMailboxCtx = {
  encryptionKey: string
  clientId: string
  clientSecret: string
  // The web app's origin: Google sends the browser back to its callback route.
  appUrl: string
}

function googleMailboxRedirectUri(appUrl: string): string {
  return `${appUrl}/auth/google-mailbox/callback`
}

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
  // The Gmail of the account the user signs in with: reconnected by signing in
  // again, never removed here.
  signInAccount: boolean
  fromEmail: string
  warmupStartedAt: Date | null
  dailyCapOverride: number | null
  sendRefusal: MailboxSendRefusal | null
  // Google refused the grant; an alias reports its parent's.
  revokedSince: Date | null
  // Projects listing this mailbox, plus for the sign-in account every project that lists none.
  projects: string[]
  grantedAt: Date
  smtp: SmtpConnectionView | null
} & MailboxDailyStatus &
  MailboxBounceWindow

const summaryColumns = {
  identityId: sendingIdentities.identityId,
  provider: sendingIdentities.provider,
  parentIdentityId: sendingIdentities.parentIdentityId,
  signInAccount: sendingIdentities.signInAccount,
  fromEmail: sendingIdentities.fromEmail,
  warmupStartedAt: sendingIdentities.warmupStartedAt,
  pausedUntil: sendingIdentities.pausedUntil,
  dailyCapOverride: sendingIdentities.dailyCapOverride,
  sendRefusal: sendingIdentities.sendRefusal,
  authRevokedAt: sendingIdentities.authRevokedAt,
  grantedAt: sendingIdentities.grantedAt,
} as const

type SummaryRow = {
  identityId: string
  provider: SendingIdentityProvider
  parentIdentityId: string | null
  signInAccount: boolean
  fromEmail: string
  warmupStartedAt: Date | null
  pausedUntil: Date | null
  dailyCapOverride: number | null
  sendRefusal: MailboxSendRefusal | null
  authRevokedAt: Date | null
  grantedAt: Date
}

function toSummary(
  row: SummaryRow,
  smtp: SmtpConnectionView | null,
  status: MailboxDailyStatus,
  bounce: MailboxBounceWindow,
  revokedSince: Date | null,
  projectNames: string[],
): SendingIdentitySummary {
  return {
    identityId: asSendingIdentityId(row.identityId),
    provider: row.provider,
    kind: mailboxKind(row.provider, row.parentIdentityId),
    parentIdentityId: row.parentIdentityId === null ? null : asSendingIdentityId(row.parentIdentityId),
    signInAccount: row.signInAccount,
    fromEmail: row.fromEmail,
    warmupStartedAt: row.warmupStartedAt,
    dailyCapOverride: row.dailyCapOverride,
    sendRefusal: row.sendRefusal,
    revokedSince,
    projects: projectNames,
    grantedAt: row.grantedAt,
    smtp,
    ...status,
    ...bounce,
  }
}

// A project listing no mailbox sends from the sign-in account, as
// loadProjectMailboxes falls back to it — so it counts as that mailbox's.
async function projectNamesByIdentity(db: Db, tenantId: TenantId): Promise<Map<string, string[]>> {
  const [rows, [signIn]] = await Promise.all([
    db
      .select({ name: projects.name, identityId: projectSendingIdentities.identityId })
      .from(projects)
      .leftJoin(
        projectSendingIdentities,
        and(eq(projectSendingIdentities.projectId, projects.id), eq(projectSendingIdentities.tenantId, tenantId)),
      )
      .where(eq(projects.tenantId, tenantId))
      .orderBy(asc(projects.name)),
    db
      .select({ identityId: sendingIdentities.identityId })
      .from(sendingIdentities)
      .where(and(eq(sendingIdentities.tenantId, tenantId), eq(sendingIdentities.signInAccount, true)))
      .limit(1),
  ])
  const byIdentity = new Map<string, string[]>()
  for (const row of rows) {
    const identityId = row.identityId ?? signIn?.identityId
    if (identityId === undefined) continue
    const names = byIdentity.get(identityId) ?? []
    names.push(row.name)
    byIdentity.set(identityId, names)
  }
  return byIdentity
}

function smtpView(provider: SendingIdentityProvider, decryptedSecret: string | null): SmtpConnectionView | null {
  if (provider !== 'smtp_imap' || decryptedSecret === null) return null
  const s = parseSendingIdentitySecret(provider, decryptedSecret)
  if (s.provider !== 'smtp_imap') return null
  const { smtpHost, smtpPort, imapHost, imapPort, username } = s
  return { smtpHost, smtpPort, imapHost, imapPort, username }
}

// Registration counts the tenant's mailboxes against the plan cap before it
// writes, so two registrations racing each other take the tenant row first.
async function lockTenantMailboxes(db: Db, tenantId: TenantId): Promise<void> {
  await db.execute(sql`SELECT 1 FROM tenants WHERE id = ${tenantId} FOR UPDATE`)
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
  const [usedByIdentity, bounceByIdentity, projectsByIdentity] = await Promise.all([
    countMailboxEmailSendsTodayByIdentity(db, tenantId, now),
    countMailboxBounceWindowByIdentity(db, tenantId, now),
    projectNamesByIdentity(db, tenantId),
  ])
  const byId = new Map(rows.map((r) => [r.identityId, r]))
  return rows.map(({ secret, ...row }) => {
    const status = mailboxDailyStatus(row, usedByIdentity.get(row.identityId) ?? 0, DEFAULT_WARMUP, now)
    const credential = row.parentIdentityId === null ? row : (byId.get(row.parentIdentityId) ?? row)
    return toSummary(
      row,
      smtpView(row.provider, secret),
      status,
      mailboxBounceWindow(bounceByIdentity.get(row.identityId)),
      credential.authRevokedAt,
      projectsByIdentity.get(row.identityId) ?? [],
    )
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
  await lockTenantMailboxes(db, tenantId)
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

  // Verify both connections before storing, so a bad mailbox is rejected here —
  // not on the first real send, nor silently at the first reply poll.
  const [smtpVerified, imapVerified] = await Promise.all([
    verifySmtpCredentials({
      host: input.smtpHost,
      port: input.smtpPort,
      username: input.username,
      appPassword: input.appPassword,
    }),
    verifyImapCredentials({
      host: input.imapHost,
      port: input.imapPort,
      username: input.username,
      appPassword: input.appPassword,
    }),
  ])
  if (!smtpVerified.ok) {
    return err(
      'UNPROCESSABLE',
      'Could not connect to the SMTP mailbox',
      `Check the host, port (use 465), username, and app password. ${smtpVerified.detail}`,
    )
  }
  if (!imapVerified.ok) {
    return err(
      'UNPROCESSABLE',
      'Could not connect to the IMAP mailbox',
      `Check the IMAP host, port (use 993), username, and app password. ${imapVerified.detail}`,
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
      null,
      [],
    ),
  )
}

// A Send-As alias under one of the tenant's connected Gmails: the address must
// already be a verified "Send mail as" entry in that Gmail account — there is
// no scope to check it here, so an unverified one fails at its first send.
export async function registerGmailAlias(
  db: Db,
  tenantId: TenantId,
  userId: string,
  edition: Edition,
  input: RegisterGmailAliasInput,
): Promise<ServiceResult<SendingIdentitySummary>> {
  await lockTenantMailboxes(db, tenantId)
  const existing = await db
    .select({
      identityId: sendingIdentities.identityId,
      provider: sendingIdentities.provider,
      parentIdentityId: sendingIdentities.parentIdentityId,
      fromEmail: sendingIdentities.fromEmail,
      authRevokedAt: sendingIdentities.authRevokedAt,
    })
    .from(sendingIdentities)
    .where(eq(sendingIdentities.tenantId, tenantId))

  const { plan } = await getTenantPlan(db, tenantId, edition)
  const guard = canRegisterMailbox(plan, existing.length)
  if (guard) return guard

  const parent = existing.find(
    (i) => i.identityId === input.parentIdentityId && i.provider === 'gmail_oauth' && i.parentIdentityId === null,
  )
  if (!parent) {
    return err('NOT_FOUND', 'Connected Gmail not found', `No connected Gmail ${input.parentIdentityId} to send the alias through.`)
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
  return ok(
    toSummary(created, null, mailboxDailyStatus(created, 0, DEFAULT_WARMUP, new Date()), mailboxBounceWindow(), parent.authRevokedAt, []),
  )
}

export function googleMailboxAuthorizationUrl(
  ctx: GoogleMailboxCtx,
  input: GoogleMailboxAuthorizationInput,
): { url: string } {
  return {
    url: buildGoogleAuthorizationUrl({
      clientId: ctx.clientId,
      redirectUri: googleMailboxRedirectUri(ctx.appUrl),
      scopes: GOOGLE_MAILBOX_SCOPES,
      state: input.state,
      loginHint: input.loginHint ?? null,
    }),
  }
}

async function exchangeCode(code: string, ctx: GoogleMailboxCtx): Promise<ServiceResult<GoogleCodeExchange>> {
  try {
    return ok(
      await exchangeGoogleAuthorizationCode({
        code,
        clientId: ctx.clientId,
        clientSecret: ctx.clientSecret,
        redirectUri: googleMailboxRedirectUri(ctx.appUrl),
      }),
    )
  } catch (e) {
    if (e instanceof GoogleAuthError && e.status < 500) {
      return err('INVALID_INPUT', 'Google authorization failed', 'The authorization expired or was already used. Start the connection again.')
    }
    throw e
  }
}

// Any Google account, not only the one the user signs in with. Connecting an
// address that is already a mailbox is a reconnect: it refreshes the grant in
// place and is not plan-gated.
export async function registerGoogleMailbox(
  db: Db,
  tenantId: TenantId,
  userId: string,
  edition: Edition,
  ctx: GoogleMailboxCtx,
  input: RegisterGoogleMailboxInput,
): Promise<ServiceResult<SendingIdentitySummary>> {
  const exchanged = await exchangeCode(input.code, ctx)
  if (!exchanged.ok) return exchanged
  const grant = exchanged.value
  if (!hasGmailSendScope(grant.scope)) {
    return err('INVALID_INPUT', 'Missing required scope', `gmail.send scope must be granted. Received: ${grant.scope}`)
  }
  if (!grant.refreshToken) {
    return err('INVALID_INPUT', 'Google returned no refresh token', 'Start the connection again and approve access when asked.')
  }
  const email = grant.idToken === null ? null : parseIdTokenEmail(grant.idToken)
  if (!email) {
    return err('BAD_GATEWAY', 'Google did not return the account email', 'Start the connection again.')
  }

  await lockTenantMailboxes(db, tenantId)
  const existing = await db
    .select({ fromEmail: sendingIdentities.fromEmail })
    .from(sendingIdentities)
    .where(eq(sendingIdentities.tenantId, tenantId))
  if (!existing.some((i) => i.fromEmail === email)) {
    const { plan } = await getTenantPlan(db, tenantId, edition)
    const guard = canRegisterMailbox(plan, existing.length)
    if (guard) return guard
  }

  const saved = await saveGmailRefreshToken(db, {
    tenantId,
    userId,
    refreshToken: grant.refreshToken,
    scope: grant.scope,
    email,
    signIn: false,
    encryptionKey: ctx.encryptionKey,
  })
  if (!saved) {
    return err('CONFLICT', 'Address is a Send-As alias', `${email} is a Send-As alias. Remove the alias before connecting it as a Google account.`)
  }

  const [row] = await db
    .select(summaryColumns)
    .from(sendingIdentities)
    .where(and(eq(sendingIdentities.tenantId, tenantId), eq(sendingIdentities.identityId, saved.identityId)))
  if (!row) return err('INTERNAL_ERROR', 'Failed to load connected Google mailbox')
  const now = new Date()
  const [usedByIdentity, bounceByIdentity, projectsByIdentity] = await Promise.all([
    countMailboxEmailSendsTodayByIdentity(db, tenantId, now),
    countMailboxBounceWindowByIdentity(db, tenantId, now),
    projectNamesByIdentity(db, tenantId),
  ])
  const status = mailboxDailyStatus(row, usedByIdentity.get(row.identityId) ?? 0, DEFAULT_WARMUP, now)
  return ok(
    toSummary(
      row,
      null,
      status,
      mailboxBounceWindow(bounceByIdentity.get(row.identityId)),
      row.authRevokedAt,
      projectsByIdentity.get(row.identityId) ?? [],
    ),
  )
}

export async function deleteSendingIdentity(
  db: Db,
  tenantId: TenantId,
  identityId: SendingIdentityId,
): Promise<ServiceResult<{ deleted: true }>> {
  // The sign-in Gmail is reconnected by signing in, never removed here.
  const [target] = await db
    .select({ signInAccount: sendingIdentities.signInAccount })
    .from(sendingIdentities)
    .where(and(eq(sendingIdentities.tenantId, tenantId), eq(sendingIdentities.identityId, identityId)))
  if (!target || target.signInAccount) return err('NOT_FOUND', 'Sending identity not found')

  // A project still listing it — or one of its Send-As aliases, which go with
  // it — would block the FK delete; surface a clean conflict instead.
  const refs = await db
    .select({ projectId: projectSendingIdentities.projectId })
    .from(projectSendingIdentities)
    .innerJoin(
      sendingIdentities,
      and(
        eq(sendingIdentities.tenantId, projectSendingIdentities.tenantId),
        eq(sendingIdentities.identityId, projectSendingIdentities.identityId),
      ),
    )
    .where(
      and(
        eq(projectSendingIdentities.tenantId, tenantId),
        or(eq(sendingIdentities.identityId, identityId), eq(sendingIdentities.parentIdentityId, identityId)),
      ),
    )
  if (refs.length > 0) {
    return err(
      'CONFLICT',
      'Sending identity is in use',
      `It or one of its aliases is used by ${refs.length} project(s). Remove them from those sending mailboxes first.`,
    )
  }

  await db
    .delete(sendingIdentities)
    .where(and(eq(sendingIdentities.tenantId, tenantId), eq(sendingIdentities.identityId, identityId)))
  return ok({ deleted: true })
}
