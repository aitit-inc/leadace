import {
  smtpReplyEnd,
  smtpReplyCode,
  encodeAuthPlain,
  encodeBase64,
  parseAuthMechanisms,
  dotStuffAndTerminate,
  ehloDomainFor,
} from '../domain/smtp'

// Only 465 implicit TLS is supported: workerd blocks port 25 and handles STARTTLS
// poorly, so a 587/STARTTLS-only mailbox can't connect (rejected at registration).
export type SmtpConnection = {
  host: string
  port: number
  username: string
  appPassword: string
}

export type SmtpSendResult = { ok: true } | { ok: false; detail: string }

// Verify runs inside the request's RLS DB transaction, so its tighter ceiling
// bounds how long a hung mailbox can pin the pooled connection.
const SEND_TIMEOUT_MS = 20_000
const VERIFY_TIMEOUT_MS = 10_000
const enc = new TextEncoder()
const dec = new TextDecoder()

class SmtpError extends Error {}

async function runSession(
  conn: SmtpConnection,
  msg: { from: string; recipients: string[]; rfc822: string } | null,
  timeoutMs: number,
): Promise<void> {
  // Dynamic import: cloudflare:sockets exists only in the Workers runtime, so this
  // keeps the module loadable under Vitest's node environment.
  const { connect } = await import('cloudflare:sockets')
  const socket = connect(
    { hostname: conn.host, port: conn.port },
    { secureTransport: 'on', allowHalfOpen: false },
  )
  // Close on timeout so the pending read rejects and the TLS session never dangles.
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    void socket.close().catch(() => {})
  }, timeoutMs)

  try {
    await socket.opened
    const reader = socket.readable.getReader()
    const writer = socket.writable.getWriter()
    let buf = ''

    const readReply = async (): Promise<string> => {
      for (;;) {
        const end = smtpReplyEnd(buf)
        if (end !== null) {
          const reply = buf.slice(0, end)
          buf = buf.slice(end)
          return reply.trimEnd()
        }
        const { value, done } = await reader.read()
        if (done) throw new SmtpError('SMTP server closed the connection unexpectedly')
        buf += dec.decode(value, { stream: true })
      }
    }
    const send = async (line: string): Promise<void> => {
      await writer.write(enc.encode(line + '\r\n'))
    }
    const expect = async (cmd: string | null, codes: number[]): Promise<string> => {
      if (cmd !== null) await send(cmd)
      const reply = await readReply()
      if (!codes.includes(smtpReplyCode(reply))) throw new SmtpError(reply)
      return reply
    }

    await expect(null, [220])
    const ehlo = await expect(`EHLO ${ehloDomainFor(msg?.from ?? conn.username)}`, [250])

    const mechs = parseAuthMechanisms(ehlo)
    if (mechs.plain) {
      await expect(`AUTH PLAIN ${encodeAuthPlain(conn.username, conn.appPassword)}`, [235])
    } else if (mechs.login) {
      await expect('AUTH LOGIN', [334])
      await expect(encodeBase64(conn.username), [334])
      await expect(encodeBase64(conn.appPassword), [235])
    } else {
      throw new SmtpError('Server offers no supported AUTH mechanism (need PLAIN or LOGIN)')
    }

    if (msg) {
      // Body is quoted-printable (7-bit-clean), so plain MAIL FROM needs no 8BITMIME.
      await expect(`MAIL FROM:<${msg.from}>`, [250])
      // All-or-nothing: a refused recipient aborts before DATA so we never half-deliver.
      for (const rcpt of msg.recipients) {
        await expect(`RCPT TO:<${rcpt}>`, [250, 251])
      }
      await expect('DATA', [354])
      await writer.write(enc.encode(dotStuffAndTerminate(msg.rfc822)))
      await expect(null, [250])
    }

    await send('QUIT')
  } catch (e) {
    if (timedOut) throw new SmtpError(`SMTP timed out after ${timeoutMs}ms`)
    throw e
  } finally {
    clearTimeout(timer)
    try {
      await socket.close()
    } catch {
      /* already closing */
    }
  }
}

export async function sendViaSmtp(
  conn: SmtpConnection,
  msg: { from: string; recipients: string[]; rfc822: string },
): Promise<SmtpSendResult> {
  try {
    await runSession(conn, msg, SEND_TIMEOUT_MS)
    return { ok: true }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) }
  }
}

// Connect + AUTH only (no message) to reject bad credentials at registration
// rather than on the first real send.
export async function verifySmtpCredentials(
  conn: SmtpConnection,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  try {
    await runSession(conn, null, VERIFY_TIMEOUT_MS)
    return { ok: true }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) }
  }
}
