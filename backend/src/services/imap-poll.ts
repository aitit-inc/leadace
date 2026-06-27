import {
  imapResponseEnd,
  imapTaggedStatus,
  parseUidSearch,
  parseFetchMessages,
  imapSearchDate,
  bytesToBinary,
  binaryToUtf8,
} from '../domain/imap'
import { encodeAuthPlain } from '../domain/smtp'
import { parseEmailMessage, getHeader, flattenMessageParts } from '../domain/email-message'
import { parseDsn } from '../domain/dsn'
import type { CapturedReply } from '../domain/reply'

// Poll-only IMAP over 993 implicit TLS (cloudflare:sockets connect()); smtp_imap
// identities only — gmail goes through the Gmail API.
export type ImapConnection = {
  host: string
  port: number
  username: string
  appPassword: string
}

type RawImapMessage = { uid: number; raw: string }
export type ImapPollResult =
  | { ok: true; replies: CapturedReply[] }
  | { ok: false; detail: string }

function toCaptured(rawBinary: string): CapturedReply {
  const raw = binaryToUtf8(rawBinary)
  const email = parseEmailMessage(raw)
  const dateHeader = getHeader(email.headers, 'date')
  const parsed = dateHeader ? new Date(dateHeader) : null
  const receivedAt = parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date()
  // The partial fetch (BODY.PEEK[]<0.128K>) keeps a DSN's delivery-status and
  // returned-original headers, which sit near the top — enough for parseDsn.
  return { email, receivedAt, dsn: parseDsn(flattenMessageParts(raw)) }
}

const POLL_TIMEOUT_MS = 30_000
// Cap the buffer so one oversized mailbox can't OOM-kill the shared cron isolate
// and starve every other identity; an over-cap poll fails for that identity only.
const MAX_RESPONSE_BYTES = 25 * 1024 * 1024
// Partial-fetch each message's start, not the whole RFC822: a reply's text is
// top-posted, so this skips attachment bloat that otherwise trips MAX_RESPONSE_BYTES.
const MAX_FETCH_OCTETS = 128 * 1024
const enc = new TextEncoder()

class ImapError extends Error {}

async function runPoll(
  conn: ImapConnection,
  since: Date,
  maxMessages: number,
): Promise<RawImapMessage[]> {
  const { connect } = await import('cloudflare:sockets')
  const socket = connect(
    { hostname: conn.host, port: conn.port },
    { secureTransport: 'on', allowHalfOpen: false },
  )
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    void socket.close().catch(() => {})
  }, POLL_TIMEOUT_MS)

  try {
    await socket.opened
    const reader = socket.readable.getReader()
    const writer = socket.writable.getWriter()
    let buf = ''
    let seq = 0

    const pull = async (): Promise<void> => {
      const { value, done } = await reader.read()
      if (done) throw new ImapError('IMAP server closed the connection unexpectedly')
      // latin1 1:1 so literal {n} octet counts line up with framer string offsets.
      buf += bytesToBinary(value)
      if (buf.length > MAX_RESPONSE_BYTES) {
        throw new ImapError(`IMAP response exceeded ${MAX_RESPONSE_BYTES} bytes`)
      }
    }
    const readLine = async (): Promise<string> => {
      for (;;) {
        const nl = buf.indexOf('\r\n')
        if (nl !== -1) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 2)
          return line
        }
        await pull()
      }
    }
    const send = (line: string) => writer.write(enc.encode(line + '\r\n'))
    const command = async (line: string): Promise<{ tag: string; response: string }> => {
      const tag = `a${++seq}`
      await send(`${tag} ${line}`)
      for (;;) {
        const end = imapResponseEnd(buf, tag)
        if (end !== null) {
          const response = buf.slice(0, end)
          buf = buf.slice(end)
          return { tag, response }
        }
        await pull()
      }
    }
    const expectOk = (tag: string, response: string, what: string) => {
      if (imapTaggedStatus(response, tag) !== 'OK') {
        throw new ImapError(`${what} failed: ${response.trim().split('\r\n').pop() ?? response}`)
      }
    }

    const greeting = await readLine()
    const authed = greeting.startsWith('* PREAUTH')

    if (!authed) {
      // AUTHENTICATE PLAIN is two-step: command, "+" continuation, then the blob.
      const tag = `a${++seq}`
      await send(`${tag} AUTHENTICATE PLAIN`)
      let line = await readLine()
      while (!line.startsWith('+') && !line.startsWith(tag + ' ')) line = await readLine()
      if (!line.startsWith('+')) {
        throw new ImapError(`AUTH failed: ${line}`)
      }
      await send(encodeAuthPlain(conn.username, conn.appPassword))
      for (;;) {
        const end = imapResponseEnd(buf, tag)
        if (end !== null) {
          expectOk(tag, buf.slice(0, end), 'AUTH')
          buf = buf.slice(end)
          break
        }
        await pull()
      }
    }

    const sel = await command('SELECT INBOX')
    expectOk(sel.tag, sel.response, 'SELECT')

    const search = await command(`UID SEARCH SINCE ${imapSearchDate(since)}`)
    expectOk(search.tag, search.response, 'SEARCH')
    // SINCE is date-granular and over-returns; take the most-recent maxMessages by
    // UID (dedup is by Message-ID upstream).
    const uids = parseUidSearch(search.response).sort((a, b) => a - b).slice(-maxMessages)
    if (uids.length === 0) {
      await command('LOGOUT').catch(() => {})
      return []
    }

    const fetch = await command(`UID FETCH ${uids.join(',')} (UID BODY.PEEK[]<0.${MAX_FETCH_OCTETS}>)`)
    expectOk(fetch.tag, fetch.response, 'FETCH')
    const messages = parseFetchMessages(fetch.response)

    await command('LOGOUT').catch(() => {})
    return messages
  } catch (e) {
    if (timedOut) throw new ImapError(`IMAP timed out after ${POLL_TIMEOUT_MS}ms`)
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

export async function pollImapInbox(
  conn: ImapConnection,
  since: Date,
  maxMessages: number,
): Promise<ImapPollResult> {
  try {
    const messages = await runPoll(conn, since, maxMessages)
    const replies: CapturedReply[] = []
    for (const m of messages) {
      try {
        replies.push(toCaptured(m.raw))
      } catch (e) {
        // One unparseable message must not drop the whole batch.
        console.error(`[imap-poll] skipping unparseable message uid=${m.uid}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    return { ok: true, replies }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) }
  }
}
