import { z } from 'zod'

// Build-time identity of a LeadAce install. Threaded from `LEADACE_EDITION`
// in env vars. Determines whether billing-related surfaces (Stripe checkout,
// portal, webhook) and plan-cap enforcement are active.
//
// 'cloud'       — the hosted SurpassOne LeadAce service. Stripe is wired up,
//                 plan tiers are enforced as defined in services/plan-limits.ts.
// 'self-hosted' — every other deploy (local dev, public-repo self-hosters).
//                 Billing endpoints 404; every tenant resolves to 'unlimited'.

export const editionSchema = z.union([z.literal('cloud'), z.literal('self-hosted')])
export type Edition = z.infer<typeof editionSchema>

// Default is 'self-hosted'. A misconfigured cloud install loses billing UI
// (loud, visible, fixable). A misconfigured self-host falsely flipped into
// 'cloud' would silently expose Stripe endpoints — much worse failure mode,
// so the default has to fail closed.
export function parseEdition(raw: string | undefined | null): Edition {
  const parsed = editionSchema.safeParse(raw)
  return parsed.success ? parsed.data : 'self-hosted'
}

// Capability witness: holding a CloudEdition value is the type-level proof
// that the caller already checked edition === 'cloud'. Stripe service
// functions accept this as a leading argument so the type system rejects
// any code path that calls them without first passing the guard.
//
// The unique-symbol brand is purely compile-time; at runtime any object
// satisfies the structural type, but the only exported way to obtain one is
// `requireCloudEdition` (in services/runtime-guards.ts), which fails on
// self-hosted installs.
declare const CloudEditionBrand: unique symbol
export type CloudEdition = { readonly [CloudEditionBrand]: true }

// Internal constructor. Module-private so it can't be forged outside the
// guard. Exported via `services/runtime-guards.ts` only.
export const __cloudEditionWitness: CloudEdition = {} as CloudEdition
