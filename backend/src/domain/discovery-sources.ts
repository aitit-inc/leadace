import { discoveryStrategySchema } from './ids'

// `playbook_<strategy-slug>` is the plugin's doc-slug convention (workspace-conventions.md).
export function playbookStrategySlug(docSlug: string): string | null {
  if (!docSlug.startsWith('playbook_')) return null
  const slug = docSlug.slice('playbook_'.length)
  return discoveryStrategySchema.safeParse(slug).success ? slug : null
}
