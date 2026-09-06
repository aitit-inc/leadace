// The registry as Gemini sees it. One zod shape per tool is the single
// definition: it validates arguments at execution and, converted here, tells
// the model what to send.
import type { FunctionDeclaration } from '@google/genai'
import { z } from 'zod'
import type { ToolDef } from './registry'

export function toFunctionDeclaration(tool: ToolDef): FunctionDeclaration {
  const json = z.toJSONSchema(z.object(tool.schema), { target: 'draft-7', io: 'input' }) as Record<string, unknown>
  delete json['$schema']
  return { name: tool.name, description: tool.description, parametersJsonSchema: json }
}

export function buildFunctionDeclarations(tools: readonly ToolDef[]): FunctionDeclaration[] {
  return tools.map(toFunctionDeclaration)
}

export function parseToolArgs(tool: ToolDef, args: Record<string, unknown>): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const parsed = z.object(tool.schema).safeParse(args)
  if (parsed.success) return { ok: true, value: parsed.data }
  return { ok: false, error: JSON.stringify(z.flattenError(parsed.error)) }
}
