import { describe, it, expect } from 'vitest'
import { detectDiscoverySourcesFormat, playbookStrategySlug } from './discovery-sources'

const named = (slug: string) =>
  `### ${slug}\n- Status: active\n- How: search X for Y\n- Why: good fit\n`

describe('detectDiscoverySourcesFormat', () => {
  it('returns named for the template shape (preamble prose + slug entries)', () => {
    const doc = [
      '# Sales Strategy',
      '## Prospect Discovery Sources',
      '(Named discovery strategies — each is one repeatable way to find prospects.)',
      named('github-trending'),
      named('vc-portfolio-directories'),
      '## Search Keywords',
      '- b2b saas',
    ].join('\n')
    expect(detectDiscoverySourcesFormat(doc)).toBe('named')
  })

  it('returns absent when the section heading is missing', () => {
    expect(detectDiscoverySourcesFormat('# Sales Strategy\n## Target\n- SMBs')).toBe('absent')
  })

  it('returns legacy for prose bullets with no slug entries', () => {
    const doc = [
      '## Prospect Discovery Sources',
      '- Search startup databases for recently funded companies',
      '- Walk industry association member lists',
    ].join('\n')
    expect(detectDiscoverySourcesFormat(doc)).toBe('legacy')
  })

  it('returns legacy for an empty section', () => {
    const doc = '## Prospect Discovery Sources\n\n## Target\n- SMBs'
    expect(detectDiscoverySourcesFormat(doc)).toBe('legacy')
  })

  it('returns mixed when stray bullets sit next to slug entries', () => {
    const doc = [
      '## Prospect Discovery Sources',
      '- leftover legacy bullet',
      named('github-trending'),
    ].join('\n')
    expect(detectDiscoverySourcesFormat(doc)).toBe('mixed')
  })

  it('returns mixed when a subsection heading is not a valid strategy slug', () => {
    const doc = [
      '## Prospect Discovery Sources',
      named('github-trending'),
      '### My Cool Strategy',
      '- Status: active',
    ].join('\n')
    expect(detectDiscoverySourcesFormat(doc)).toBe('mixed')
  })

  it('does not treat Status/How/Why bullets inside an entry as stray', () => {
    const doc = `## Prospect Discovery Sources\n${named('press-release-sites')}`
    expect(detectDiscoverySourcesFormat(doc)).toBe('named')
  })

  it('ignores slug-shaped subsections in other sections', () => {
    const doc = [
      '## Prospect Discovery Sources',
      '- prose bullet only',
      '## Other Section',
      '### looks-like-a-slug',
    ].join('\n')
    expect(detectDiscoverySourcesFormat(doc)).toBe('legacy')
  })

  it('parses a section that runs to end of document', () => {
    const doc = `## Prospect Discovery Sources\n${named('job-boards')}`
    expect(detectDiscoverySourcesFormat(doc)).toBe('named')
  })
})

describe('playbookStrategySlug', () => {
  it('extracts the strategy slug from a playbook doc slug', () => {
    expect(playbookStrategySlug('playbook_upwork-web-dev')).toBe('upwork-web-dev')
  })

  it('returns null for non-playbook doc slugs', () => {
    expect(playbookStrategySlug('sales_strategy')).toBeNull()
    expect(playbookStrategySlug('learnings')).toBeNull()
  })

  it('returns null when the suffix is not a valid strategy slug', () => {
    expect(playbookStrategySlug('playbook_')).toBeNull()
    expect(playbookStrategySlug('playbook_Bad_Slug')).toBeNull()
  })
})
