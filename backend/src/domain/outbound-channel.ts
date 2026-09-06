// The channels an outreach can go out on. Owned here so domain rules and the
// schema share one list without domain importing schema runtime.
export const OUTBOUND_CHANNELS = ['email', 'form', 'sns_twitter', 'sns_linkedin', 'platform'] as const
export type OutboundChannel = (typeof OUTBOUND_CHANNELS)[number]
