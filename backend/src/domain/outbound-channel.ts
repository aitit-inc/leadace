import type { OutboundMode } from '../db/schema'

// The channels an outreach can go out on. Owned here so domain rules and the
// schema share one list without domain importing schema runtime.
export const OUTBOUND_CHANNELS = ['email', 'form', 'sns_twitter', 'sns_linkedin', 'platform'] as const
export type OutboundChannel = (typeof OUTBOUND_CHANNELS)[number]

// What the hosted agent acts on by itself: only email in send mode — a form or
// DM needs a browser — and every channel but platform in draft mode, where a
// person submits the form / SNS drafts.
export function hostedChannels(mode: OutboundMode): OutboundChannel[] {
  return mode === 'send' ? ['email'] : ['email', 'form', 'sns_twitter', 'sns_linkedin']
}
