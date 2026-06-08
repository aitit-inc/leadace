import { z } from 'zod'
import { INQUIRY_SHORT_ID_PATTERN } from '../auth/inquiry-token'

// Branded entity-identity primitives for string-shaped IDs.
//
// Only the string-shaped IDs (TenantId, ProjectId, ShortId) carry a brand.
// They cross tenant/project/inquiry-token boundaries as opaque tokens, and
// the brand catches "passed a project id where a tenant id was expected"
// at compile time — a class of mistake that RLS can only catch at runtime.
//
// Number-shaped row PKs (prospect / outreach_log / response / inquiry_session
// / evaluation / project_document / bug_report) are NOT branded. The
// compile-time payoff for those was small (you'd need to swap two same-shape
// `number` args in the same call) and the ceremony was high (every DB row
// read needed a manual `as XxxId` cast that the compiler couldn't verify
// anyway). The composite (entity_id, tenant_id) FKs + RLS already enforce
// the cross-tenant invariant at the DB level.
//
// See `.claude/rules/backend-architecture.md` § "Branded IDs and
// parse-don't-validate" for the policy.

export type TenantId = string & { readonly __brand: 'TenantId' }
export type ProjectId = string & { readonly __brand: 'ProjectId' }
export type ShortId = string & { readonly __brand: 'ShortId' }

// Body / programmatic-input validators: strict — no coercion. JSON is typed
// at the wire, so `{"prospectId": "5"}`, `{"prospectId": true}`, or
// `{"ids": [[1]]}` must be rejected (z.coerce.number() would silently map
// all of those to 1 or NaN). For path / query strings, the *IdParamSchema
// below applies z.coerce because that wire IS `Record<string, string>`.
export const positiveInt = z.number().int().positive()
const coercedPositiveInt = z.coerce.number().int().positive()
const nonEmptyString = z.string().min(1)

export const tenantIdSchema = nonEmptyString.transform((v): TenantId => v as TenantId)
export const projectIdSchema = nonEmptyString.transform((v): ProjectId => v as ProjectId)
// `ShortId` carries the inquiry-token shape invariant — 8-char [A-Za-z0-9_-].
// Bake the regex into the brand parser so any code holding a `ShortId` can
// assume it matches the inquiry-token DB column.
export const shortIdSchema = z
  .string()
  .regex(INQUIRY_SHORT_ID_PATTERN)
  .transform((v): ShortId => v as ShortId)

export const prospectIdSchema = positiveInt
export const outreachLogIdSchema = positiveInt

// Subject-variant slug, shared by the variants upsert and every variant_id write.
const variantIdRegex = /^[a-zA-Z0-9_-]{1,32}$/
export const variantIdSchema = z.string().regex(variantIdRegex)

// Path / query param wrappers — only for entities with a `:id` route segment.
// The path-string wire format is `Record<string, string>`, so coerce here.
export const projectIdParamSchema = z.object({ id: projectIdSchema })
export const prospectIdParamSchema = z.object({ id: coercedPositiveInt })
export const organizationIdParamSchema = z.object({ id: coercedPositiveInt })
export const outreachLogIdParamSchema = z.object({ id: coercedPositiveInt })
export const shortIdParamSchema = z.object({ shortId: shortIdSchema })

export const asTenantId = (v: string): TenantId => v as TenantId
export const asProjectId = (v: string): ProjectId => v as ProjectId
export const asShortId = (v: string): ShortId => v as ShortId
