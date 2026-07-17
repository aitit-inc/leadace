import { z } from 'zod'
import { INQUIRY_SHORT_ID_PATTERN } from '../auth/inquiry-token'

// Only string-shaped IDs carry a brand — it catches "passed a project id where
// a tenant id was expected" at compile time. Number-shaped row PKs are
// deliberately unbranded: low payoff, high `as XxxId` ceremony, and the
// composite (entity_id, tenant_id) FKs + RLS already enforce cross-tenant
// isolation. See `.claude/rules/backend-architecture.md` § "Branded IDs and
// parse-don't-validate".

export type TenantId = string & { readonly __brand: 'TenantId' }
export type ProjectId = string & { readonly __brand: 'ProjectId' }
export type ShortId = string & { readonly __brand: 'ShortId' }
// No shape regex: backfilled ids are 32-char hex, runtime ones 21-char base62 — both must parse.
export type SendingIdentityId = string & { readonly __brand: 'SendingIdentityId' }

// Project name or id, unresolved. The brand union admits ProjectId but not the
// reverse — resolveProject() is the only path from ProjectRef to ProjectId.
export type ProjectRef = string & { readonly __brand: 'ProjectId' | 'ProjectRef' }

// Body / programmatic-input validators: strict — no coercion. JSON is typed
// at the wire, so `{"prospectId": "5"}`, `{"prospectId": true}`, or
// `{"ids": [[1]]}` must be rejected (z.coerce.number() would silently map
// all of those to 1 or NaN). For path / query strings, the *IdParamSchema
// below applies z.coerce because that wire IS `Record<string, string>`.
export const positiveInt = z.number().int().positive()
const coercedPositiveInt = z.coerce.number().int().positive()
const nonEmptyString = z.string().min(1)

export const tenantIdSchema = nonEmptyString.transform((v): TenantId => v as TenantId)
export const projectRefSchema = nonEmptyString.transform((v): ProjectRef => v as ProjectRef)
export const sendingIdentityIdSchema = nonEmptyString.transform((v): SendingIdentityId => v as SendingIdentityId)
// `ShortId` carries the inquiry-token shape invariant — 22-char [A-Za-z0-9_-].
// Bake the regex into the brand parser so any code holding a `ShortId` can
// assume it matches the inquiry-token DB column.
export const shortIdSchema = z
  .string()
  .regex(INQUIRY_SHORT_ID_PATTERN)
  .transform((v): ShortId => v as ShortId)

export const prospectIdSchema = positiveInt
export const outreachLogIdSchema = positiveInt

const variantIdRegex = /^[a-zA-Z0-9_-]{1,32}$/
export const variantIdSchema = z.string().regex(variantIdRegex)

// Strict lowercase kebab-case so the stats GROUP BY bucket can't split on
// case or hyphen variance of the same strategy ('github-' vs 'github').
const discoveryStrategyRegex = /^[a-z0-9]+(-[a-z0-9]+)*$/
export const discoveryStrategySchema = z.string().max(64).regex(discoveryStrategyRegex)
export const suggestionKindSchema = z.string().max(64).regex(discoveryStrategyRegex)

export const projectRefParamSchema = z.object({ id: projectRefSchema })
export const prospectIdParamSchema = z.object({ id: coercedPositiveInt })
export const organizationIdParamSchema = z.object({ id: coercedPositiveInt })
export const outreachLogIdParamSchema = z.object({ id: coercedPositiveInt })
export const suggestionIdParamSchema = z.object({ id: coercedPositiveInt })
export const shortIdParamSchema = z.object({ shortId: shortIdSchema })
export const sendingIdentityIdParamSchema = z.object({ id: sendingIdentityIdSchema })

export const asTenantId = (v: string): TenantId => v as TenantId
export const asProjectId = (v: string): ProjectId => v as ProjectId
export const asShortId = (v: string): ShortId => v as ShortId
export const asSendingIdentityId = (v: string): SendingIdentityId => v as SendingIdentityId
