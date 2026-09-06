import { readFileSync } from 'node:fs'

// An MCP tool answers with a text block, never a JSON object: the handler reads
// the API's JSON and then formats a string. So a description that says
// `Returns { connected, email? }` names fields that exist in the HTTP response
// and never reach the model. Checking the description against the service does
// not catch this — the fields are all there. Only the handler's output string
// tells the truth.
//
// A description may therefore use JSON-shape notation only for the part of the
// payload its handler actually JSON.stringify's. Naming a label that appears
// verbatim in the emitted text (`legalName: …`) is prose, not a shape claim,
// and is fine.
//
// Two checks, then two blind spots.
//
// 1. A tool whose handler never JSON.stringify's must not use JSON-shape
//    notation at all.
// 2. A tool that stringifies a property must not wrap it back up: emitting
//    `JSON.stringify(result.variants)` and promising `{ variants: [...] }`
//    describes an object the model never receives.
//
// Blind spots, left to review and to CLAUDE.md:
//   - a handler that stringifies one field and narrates the rest. In
//     get_outbound_targets, `cycle {kind, touchNumber}` is a real key inside the
//     stringified prospects while `byChannel {…}` is a prose label — and nothing
//     here can tell them apart.
//   - naming a value the string never carries. discard_drafts advertised
//     `deletedIds` while emitting only `${result.deletedIds.length}` — no JSON
//     shape, so nothing to match on. What matters is whether the agent can
//     recover the value, which is not decidable by a regex.

const SRC = new URL('../../backend/src/tools/registry.ts', import.meta.url)
const src = readFileSync(SRC, 'utf8')
const lines = src.split('\n')

const starts = []
for (let i = 0; i < lines.length; i++) {
  if (lines[i].trim() === 'defineTool(') starts.push(i)
}
if (starts.length === 0) {
  console.error('found no defineTool( blocks — has backend/src/tools/registry.ts been restructured?')
  process.exit(1)
}

// `{ a, b }` / `{ ready }` / `{kind: 'fresh'}` / `decisions[]`
const OBJECT_SHAPE = /\{\s*\w+\s*\??\s*[,:}]/
const ARRAY_SHAPE = /\b\w+\[\]/

const shapeOffenders = []
const wrapperOffenders = []

for (let k = 0; k < starts.length; k++) {
  const start = starts[k]
  const end = k + 1 < starts.length ? starts[k + 1] : lines.length
  const name = lines[start + 1].trim().replace(/^'|',$/g, '')
  const description = lines[start + 2].trim().replace(/^'/, '').replace(/',$/, '')
  const block = lines.slice(start, end).join('\n')
  const line = start + 3

  // {{org}} style placeholders are templates, not shape claims.
  const claim = description.replace(/\{\{[^}]*\}\}/g, '')

  if (!/JSON\.stringify/.test(block)) {
    const hit = OBJECT_SHAPE.exec(claim)?.[0] ?? ARRAY_SHAPE.exec(claim)?.[0]
    if (hit) shapeOffenders.push({ name, line, hit })
    continue
  }

  // Only a stringified *property* can be falsely re-wrapped. An object literal
  // argument — JSON.stringify({ serverVersion, minPluginVersion }) — is exactly
  // the shape the model receives, so there is nothing to check.
  const stringified = [...block.matchAll(/JSON\.stringify\(\s*([\w.]+)/g)].map((m) => m[1])
  for (const expr of stringified) {
    const key = expr.split('.').pop()
    if (new RegExp(`\\{\\s*${key}\\s*:`).test(claim)) {
      wrapperOffenders.push({ name, line, key, expr })
    }
  }
}

if (shapeOffenders.length === 0 && wrapperOffenders.length === 0) {
  console.log(`ok: every description matches what its handler emits (${starts.length} tools checked)`)
  process.exit(0)
}

if (shapeOffenders.length > 0) {
  console.error('These tools format a string — their handler never JSON.stringify()s — yet their')
  console.error('description promises a JSON shape the model will never receive:\n')
  for (const o of shapeOffenders) {
    console.error(`  backend/src/tools/registry.ts:${o.line}  ${o.name}  →  ${o.hit}`)
  }
  console.error('\nDescribe the information the tool reports instead. Naming a label that appears')
  console.error('verbatim in the emitted text is fine; JSON-shape notation is not.\n')
}

if (wrapperOffenders.length > 0) {
  console.error('These tools stringify a property but describe it wrapped back inside an object')
  console.error('the model never receives:\n')
  for (const o of wrapperOffenders) {
    console.error(`  backend/src/tools/registry.ts:${o.line}  ${o.name}  →  emits JSON.stringify(${o.expr}), claims { ${o.key}: … }`)
  }
  console.error('\nDescribe the stringified value itself, not a wrapper around it.\n')
}

process.exit(1)
