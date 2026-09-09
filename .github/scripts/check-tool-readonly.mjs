import { readFileSync } from 'node:fs'

// `readOnly: true` lets the hosted chat agent run a tool alongside its siblings
// in one model turn. That is safe only while the tool writes nothing: a write
// running concurrently loses the ordering the model assumed and can race
// another write past a check it already passed (quota is the sharp case).
//
// The flag is a promise about the handler, and nothing in the type system holds
// the handler to it. This does: a tool that declares itself read-only may reach
// the API with GET and nothing else.
//
// Blind spots:
//   - a handler that writes without going through callApi. There is no such
//     tool today — every one of them reaches the API through ToolCtx.
//   - a write introduced inside the service behind a GET endpoint. Nothing
//     here reads past registry.ts, so the verb stays the whole claim; a GET
//     route that writes is already against the backend rule.

const SRC = new URL('../../backend/src/tools/registry.ts', import.meta.url)
const lines = readFileSync(SRC, 'utf8').split('\n')

const starts = []
for (let i = 0; i < lines.length; i++) {
  if (lines[i].trim() === 'defineTool(') starts.push(i)
}
if (starts.length === 0) {
  console.error('found no defineTool( blocks — has backend/src/tools/registry.ts been restructured?')
  process.exit(1)
}

const offenders = []
let declared = 0

for (let k = 0; k < starts.length; k++) {
  const start = starts[k]
  const end = k + 1 < starts.length ? starts[k + 1] : lines.length
  const block = lines.slice(start, end).join('\n')
  if (!/\breadOnly:\s*true\b/.test(block)) continue
  declared++
  const name = lines[start + 1].trim().replace(/^'|',$/g, '')
  const literal = [...block.matchAll(/callApi\(\s*['"]([A-Z]+)['"]/g)].map((m) => m[1])
  const writes = [...new Set(literal.filter((m) => m !== 'GET'))]
  // A method the handler computes cannot be read here, so it is not a GET
  // until someone proves otherwise.
  const opaque = [...block.matchAll(/callApi\(/g)].length - literal.length
  if (opaque > 0) writes.push(`${opaque} call${opaque === 1 ? '' : 's'} with a method this check cannot read`)
  if (writes.length > 0) offenders.push({ name, line: start + 2, writes })
}

if (offenders.length === 0) {
  console.log(`ok: every read-only tool reaches the API with GET only (${declared} declared)`)
  process.exit(0)
}

console.error('These tools declare `readOnly: true`, which lets the chat agent run them concurrently,')
console.error('yet their handler reaches the API with a writing method:\n')
for (const o of offenders) {
  console.error(`  backend/src/tools/registry.ts:${o.line}  ${o.name}  →  ${o.writes.join(', ')}`)
}
console.error('\nDrop the flag, or move the write out of the tool.\n')
process.exit(1)
