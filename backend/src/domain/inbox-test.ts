import { z } from 'zod'

// The inbox test re-sends a mailbox's latest cold email to seed mailboxes
// LeadAce owns and reads where each copy landed. A recipient's own inbox is
// invisible, and Postmaster Tools reports neither Workspace recipients nor
// small volumes, so seeds are the only placement signal a sender can read.

const INBOX_TEST_INTERVAL_MS = 23 * 60 * 60 * 1000
// Only a mailbox that is sending is worth testing.
const INBOX_TEST_ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

// INBOX_TEST_SEEDS: a JSON array of the seed mailboxes, read over IMAP with an
// app password; the IMAP username is the address.
export const inboxTestSeedsSchema = z.array(
  z.object({
    address: z.email(),
    imapHost: z.string().min(1),
    imapPort: z.number().int().positive().default(993),
    appPassword: z.string().min(1),
  }),
)
export type InboxTestSeed = z.infer<typeof inboxTestSeedsSchema>[number]

export type SeedPlacement = 'inbox' | 'spam' | 'missing'

// The latest test that delivered a copy: one where none arrived judges
// nothing, so it leaves the previous result and its hold in place.
export type InboxTestResult = {
  testedAt: string
  inbox: number
  spam: number
  missing: number
}

export function countPlacements(placements: SeedPlacement[]): Pick<InboxTestResult, 'inbox' | 'spam' | 'missing'> {
  return {
    inbox: placements.filter((p) => p === 'inbox').length,
    spam: placements.filter((p) => p === 'spam').length,
    missing: placements.filter((p) => p === 'missing').length,
  }
}

// A copy that never arrived says nothing about where filtering put it, so
// only delivered copies vote.
export function landedInSpam(result: Pick<InboxTestResult, 'inbox' | 'spam'>): boolean {
  const delivered = result.inbox + result.spam
  return delivered > 0 && result.spam * 2 >= delivered
}

export function inboxTestHolds(result: InboxTestResult | null): boolean {
  return result !== null && landedInSpam(result)
}

// placements: one per copy sent, null where its seed could not be read.
// null: the previous result stands — no copy arrived, or the unread copies
// could still put the test in spam, so they cannot lift the previous hold.
export function judgeInboxTest(
  placements: Array<SeedPlacement | null>,
  previous: InboxTestResult | null,
  testedAt: Date,
): InboxTestResult | null {
  const read = placements.filter((p): p is SeedPlacement => p !== null)
  const counts = countPlacements(read)
  if (counts.inbox + counts.spam === 0) return null
  const unread = placements.length - read.length
  if (inboxTestHolds(previous) && !landedInSpam(counts) && landedInSpam({ inbox: counts.inbox, spam: counts.spam + unread })) return null
  return { testedAt: testedAt.toISOString(), ...counts }
}

// Daily while the mailbox sends; a held one sends nothing new, so only a test
// the person starts can lift its hold.
export function inboxTestDue(lastSentAt: Date, testSentAt: Date | null, result: InboxTestResult | null, now: Date): boolean {
  if (testSentAt && now.getTime() - testSentAt.getTime() < INBOX_TEST_INTERVAL_MS) return false
  return now.getTime() - lastSentAt.getTime() < INBOX_TEST_ACTIVE_WINDOW_MS && !inboxTestHolds(result)
}
