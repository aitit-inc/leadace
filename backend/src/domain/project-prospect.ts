import type { Priority } from '../db/schema'
import type { ProjectId, TenantId } from './ids'

// Callers chain their own `.onConflictDo*`.
export function projectProspectInsertValues(args: {
  tenantId: TenantId
  projectId: ProjectId
  prospectId: number
  matchReason: string
  priority: Priority
  now: Date
}) {
  return {
    tenantId: args.tenantId,
    projectId: args.projectId,
    prospectId: args.prospectId,
    matchReason: args.matchReason,
    priority: args.priority,
    status: 'new' as const,
    createdAt: args.now,
    updatedAt: args.now,
  }
}
