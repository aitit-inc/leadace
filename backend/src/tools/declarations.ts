// The registry as the model sees it. One zod shape per tool is the single
// definition: it validates arguments at execution and, converted here, tells
// the model what to send.
import type { FunctionTool } from 'openai/resources/responses/responses'
import { z } from 'zod'
import type { ToolDef } from './registry'

// Not strict: strict mode requires every property, and the schemas have
// optional ones. parseToolArgs validates what the model sends.
export function toFunctionDeclaration(tool: ToolDef): FunctionTool {
  const json = z.toJSONSchema(z.object(tool.schema), { target: 'draft-7', io: 'input' }) as Record<string, unknown>
  delete json['$schema']
  return { type: 'function', name: tool.name, description: tool.description, parameters: json, strict: false }
}

export function buildFunctionDeclarations(tools: readonly ToolDef[]): FunctionTool[] {
  return tools.map(toFunctionDeclaration)
}

export function parseToolArgs(tool: ToolDef, args: Record<string, unknown>): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const parsed = z.object(tool.schema).safeParse(args)
  if (parsed.success) return { ok: true, value: parsed.data }
  return { ok: false, error: JSON.stringify(z.flattenError(parsed.error)) }
}
