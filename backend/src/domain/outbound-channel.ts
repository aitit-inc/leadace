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

type ChannelState = 'usable' | 'refused' | null

export function contactDecision(
  found: { email: ChannelState; form: ChannelState; x: boolean; linkedin: boolean },
  channels: readonly OutboundChannel[],
): 'reachable' | 'refusal' | 'channel_not_enabled' | 'none' {
  const on = new Set(channels)
  if (
    (found.email === 'usable' && on.has('email')) ||
    (found.form === 'usable' && on.has('form')) ||
    (found.x && on.has('sns_twitter')) ||
    (found.linkedin && on.has('sns_linkedin'))
  ) return 'reachable'
  if (found.email === 'refused' || found.form === 'refused') return 'refusal'
  return found.email !== null || found.form !== null || found.x || found.linkedin ? 'channel_not_enabled' : 'none'
}
