import { z } from 'zod'

// Build-time install identity, threaded from `LEADACE_EDITION`. 'cloud' (the
// hosted SurpassOne service) enables Stripe surfaces and plan-cap enforcement;
// 'self-hosted' (all other deploys) 404s billing endpoints and resolves every
// tenant to 'unlimited'.

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

// Capability witness: a CloudEdition value is compile-time proof the caller
// checked edition === 'cloud'; Stripe service functions take it as a leading
// argument so unguarded call paths fail to compile. The brand is erased at
// runtime — the only legitimate way to obtain one is `requireCloudEdition`
// (services/runtime-guards.ts), which fails on self-hosted installs.
declare const CloudEditionBrand: unique symbol
export type CloudEdition = { readonly [CloudEditionBrand]: true }

// Do not import directly; reach it through `requireCloudEdition` only.
export const __cloudEditionWitness: CloudEdition = {} as CloudEdition
