import { describe, expect, it } from 'vitest'
import { buildToolRegistry } from './registry'
import { buildFunctionDeclarations, parseToolArgs } from './declarations'

describe('function declarations', () => {
  const registry = buildToolRegistry()

  it('converts every tool schema without throwing and keeps names unique', () => {
    const decls = buildFunctionDeclarations(registry)
    expect(decls).toHaveLength(registry.length)
    expect(new Set(decls.map((d) => d.name)).size).toBe(registry.length)
    for (const d of decls) {
      const schema = d.parametersJsonSchema as Record<string, unknown>
      expect(schema['type']).toBe('object')
      expect(schema['$schema']).toBeUndefined()
    }
  })

  it('validates arguments against the same shape the model was shown', () => {
    const startJob = registry.find((t) => t.name === 'start_job')!
    expect(parseToolArgs(startJob, { projectId: 'p', params: { kind: 'discover', count: 10 } }).ok).toBe(true)
    expect(parseToolArgs(startJob, { projectId: 'p', params: { kind: 'nope' } }).ok).toBe(false)
  })
})
