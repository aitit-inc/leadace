import { discoveryStrategySchema } from './ids'

export type DiscoverySourcesFormat = 'named' | 'legacy' | 'mixed' | 'absent'

const SECTION_HEADING = /^##\s+Prospect Discovery Sources\s*$/

// `playbook_<strategy-slug>` is the plugin's doc-slug convention (workspace-conventions.md).
export function playbookStrategySlug(docSlug: string): string | null {
  if (!docSlug.startsWith('playbook_')) return null
  const slug = docSlug.slice('playbook_'.length)
  return discoveryStrategySchema.safeParse(slug).success ? slug : null
}

export function detectDiscoverySourcesFormat(markdown: string): DiscoverySourcesFormat {
  const lines = markdown.split('\n')
  const start = lines.findIndex((line) => SECTION_HEADING.test(line))
  if (start === -1) return 'absent'

  let namedEntries = 0
  let hasStrayContent = false
  let inNamedEntry = false
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!
    if (/^##\s/.test(line)) break
    const subheading = line.match(/^###\s+(.+)$/)
    if (subheading) {
      if (discoveryStrategySchema.safeParse(subheading[1]!.trim()).success) {
        namedEntries++
        inNamedEntry = true
      } else {
        hasStrayContent = true
        inNamedEntry = false
      }
      continue
    }
    if (!inNamedEntry && /^\s*[-*]\s+/.test(line)) hasStrayContent = true
  }

  if (namedEntries === 0) return 'legacy'
  return hasStrayContent ? 'mixed' : 'named'
}
