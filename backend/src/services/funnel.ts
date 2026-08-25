import type { ProjectId, SendingIdentityId, TenantId } from '../domain/ids'

// One line per activation step, logged as a single JSON object so Workers
// Logs indexes every top-level key (event, tenantId, …) for filter/group-by;
// `message` keeps free-text search working. Fields are tenant/entity ids
// only — no user ids, emails, or free text.
export type FunnelEvent =
  | { event: 'tenant_created'; tenantId: TenantId; caller: 'browser' | 'mcp' }
  | { event: 'gmail_connected'; tenantId: TenantId; signupCta: boolean }
  | { event: 'gmail_scope_rejected'; tenantId: TenantId }
  | { event: 'project_created'; tenantId: TenantId; projectId: ProjectId }
  | { event: 'mcp_connected'; tenantId: TenantId }
  | { event: 'mailbox_first_send'; tenantId: TenantId; identityId: SendingIdentityId }

export function logFunnel(e: FunnelEvent): void {
  console.log({ message: `[funnel] ${e.event}`, ...e })
}
