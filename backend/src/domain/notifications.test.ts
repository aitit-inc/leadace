import { describe, expect, it } from 'vitest'
import { projectLink } from './notifications'

describe('projectLink', () => {
  it('names the project on a path with and without a query', () => {
    expect(projectLink('p 1', '/prospects/7')).toBe('/prospects/7?project=p%201')
    expect(projectLink('p1', '/chat?t=abc')).toBe('/chat?t=abc&project=p1')
  })
})
