import { describe, expect, it } from 'vitest'
import { playbookStrategySlug } from './discovery-sources'

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
