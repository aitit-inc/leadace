/**
 * Scores an eval-gate.ts run against the send gate's answer key (#1036).
 * Numbers and case ids only: the dataset stays outside the repo.
 *
 * Usage: npx tsx scripts/eval-gate-score.ts --dir <dataset> --run <name> [--split dev|all] [--against <run>]
 *
 * --split dev (the default) is for working on a change. --split all includes the
 * held-out cases: use it only to decide on a change. Each such look is logged to
 * <dataset>/gold/test-looks.log, and the held-out cases are replaced after ten.
 *
 * --against lists the cases whose outcome differs from another run: the rate's
 * margin hides a small change. Held-out cases only add to the counts, never by name.
 */
import { appendFileSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'

function argOf(name: string): string | null {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? null : (process.argv[at + 1] ?? null)
}

const dir = argOf('dir')
const runName = argOf('run')
if (!dir || !runName) throw new Error('--dir <dataset> and --run <name> are required')
const split = z.enum(['dev', 'all']).parse(argOf('split') ?? 'dev')

const caseSchema = z.object({ id: z.string(), split: z.enum(['dev', 'test', 'hard']), sellerKind: z.enum(['internal', 'external']) })
const goldSchema = z.object({
  id: z.string(),
  target: z.enum(['fit', 'not_fit', 'unclear']),
  size_reachable: z.enum(['yes', 'no', 'unclear']),
  site_refuses_sales: z.boolean(),
  addresses: z.array(z.object({ address: z.string(), verdict: z.enum(['ok', 'not_ok', 'unsure']), person: z.string().nullable() })),
  allowed_names: z.array(z.string()),
})
const runSchema = z.object({
  id: z.string(),
  skip: z.string().nullable(),
  email: z.string().nullable(),
  noSolicitation: z.boolean(),
  contactName: z.string().nullable(),
  // Absent on a run recorded before drafting was added.
  draft: z.union([z.object({ subject: z.string() }), z.object({ skipped: z.string() })]).nullable().optional(),
  contentCheck: z.object({ problems: z.array(z.object({ kind: z.string() })) }).nullable().optional(),
  costUsd: z.number(),
})

const jsonl = <T>(path: string, schema: z.ZodType<T>): T[] => readFileSync(resolve(dir, path), 'utf8').trim().split('\n').map((l) => schema.parse(JSON.parse(l)))
const normalize = (s: string) => s.replace(/&amp;/g, '&').trim().toLowerCase()

const cases = jsonl('cases.jsonl', caseSchema)
const gold = new Map(jsonl('gold/gold.jsonl', goldSchema).map((g) => [g.id, g]))
type Run = z.infer<typeof runSchema>
const loadRun = (name: string) => new Map(readdirSync(resolve(dir, 'runs', name)).map((f) => {
  const r = runSchema.parse(JSON.parse(readFileSync(resolve(dir, 'runs', name, f), 'utf8')))
  return [r.id, r]
}))
const runs = loadRun(runName)

const UNSENDABLE = new Set(['refused', 'wrong_mailbox', 'not_target', 'too_big', 'wrong_name'])

function errorsOf(r: Run): string[] {
  const g = gold.get(r.id)!
  const row = g.addresses.find((a) => normalize(a.address) === normalize(r.email!))
  const named = r.contactName === null ? null : normalize(r.contactName)
  return [
    ...(g.site_refuses_sales ? ['refused'] : []),
    ...(row === undefined ? ['address_not_in_key'] : row.verdict === 'not_ok' ? ['wrong_mailbox'] : row.verdict === 'unsure' ? ['address_unsure'] : []),
    ...(g.target === 'not_fit' ? ['not_target'] : g.target === 'unclear' ? ['target_unclear'] : []),
    ...(g.size_reachable === 'no' ? ['too_big'] : []),
    ...(named !== null && row?.person && normalize(row.person) !== named ? ['wrong_name'] : []),
    ...(named !== null && !g.allowed_names.some((n) => normalize(n) === named) ? ['name_not_in_key'] : []),
  ]
}

const wasDrafted = (r: Run | undefined) => {
  const composed = r?.draft === undefined || (r.draft !== null && 'subject' in r.draft)
  return r !== undefined && r.skip === null && r.email !== null && !r.noSolicitation && composed
}
const drafted = (id: string) => wasDrafted(runs.get(id))

function report(label: string, ids: string[]): void {
  const errors = ids.map((id) => errorsOf(runs.get(id)!))
  const unsendable = errors.filter((e) => e.some((x) => UNSENDABLE.has(x))).length
  const unsure = errors.filter((e) => e.length > 0 && !e.some((x) => UNSENDABLE.has(x))).length
  const p = ids.length === 0 ? 0 : unsendable / ids.length
  const margin = ids.length === 0 ? 0 : 1.96 * Math.sqrt((p * (1 - p)) / ids.length)
  const types: Record<string, number> = {}
  for (const x of errors.flat()) types[x] = (types[x] ?? 0) + 1
  console.log(`${label}: drafted ${ids.length}, unsendable ${unsendable} (${(p * 100).toFixed(0)}% ±${(margin * 100).toFixed(0)}), unsure ${unsure}`, types)
}

const measured = cases.filter((c) => (split === 'dev' ? c.split === 'dev' : c.split !== 'hard'))
if (split === 'all') appendFileSync(resolve(dir, 'gold/test-looks.log'), `${new Date().toISOString()} ${runName}\n`)
const draftedIn = (of: typeof cases) => of.map((c) => c.id).filter(drafted)
const ids = draftedIn(measured)
report(split, ids)
for (const kind of ['internal', 'external'] as const) report(kind, draftedIn(measured.filter((c) => c.sellerKind === kind)))
report('hard', draftedIn(cases.filter((c) => c.split === 'hard')))

// A good case is one the key says the seller may write to; the counter metric.
const good = measured.filter((c) => {
  if (!runs.has(c.id)) return false
  const g = gold.get(c.id)!
  return g.target === 'fit' && g.size_reachable !== 'no' && !g.site_refuses_sales && g.addresses.some((a) => a.verdict === 'ok')
})
const goodDrafted = good.filter((c) => drafted(c.id)).length
const costUsd = measured.reduce((sum, c) => sum + (runs.get(c.id)?.costUsd ?? 0), 0)
console.log(`good cases drafted ${goodDrafted}/${good.length}; cost $${costUsd.toFixed(2)}${goodDrafted === 0 ? '' : ` ($${(costUsd / goodDrafted).toFixed(3)} per good draft)`}`)
const flagged = ids.filter((id) => (runs.get(id)!.contentCheck?.problems.length ?? 0) > 0)
console.log(`content flags to confirm: ${flagged.length}/${ids.length}${split === 'dev' ? ` ${flagged.join(' ')}` : ''}`)

const against = argOf('against')
if (against) {
  const base = loadRun(against)
  const outcome = (r: Run) => {
    if (!wasDrafted(r)) return { rank: 0, text: 'not drafted' }
    const errors = errorsOf(r)
    const flags = r.contentCheck?.problems.map((p) => p.kind) ?? []
    const content = flags.length > 0 ? ` content(${flags.join(',')})` : ''
    if (errors.some((x) => UNSENDABLE.has(x))) return { rank: 2, text: `unsendable(${errors.join(',')})${content}` }
    return errors.length > 0 ? { rank: 1, text: `unsure(${errors.join(',')})${content}` } : { rank: 0, text: `ok${content}` }
  }
  const heldOut = new Set(cases.filter((c) => c.split === 'test').map((c) => c.id))
  const scope = cases.filter((c) => split === 'all' || c.split !== 'test').map((c) => c.id)
  const compared = scope.filter((id) => runs.has(id) && base.has(id))
  const missing = scope.filter((id) => !compared.includes(id))
  if (missing.length > 0) console.log(`missing from a run, not compared: ${missing.length} ${missing.filter((id) => !heldOut.has(id)).join(' ')}`)
  const changes = compared.flatMap((id) => {
    const before = outcome(base.get(id)!)
    const after = outcome(runs.get(id)!)
    return before.text === after.text ? [] : [{ id, before, after }]
  })
  const worse = changes.filter((c) => c.after.rank > c.before.rank)
  const better = changes.filter((c) => c.after.rank < c.before.rank)
  const other = changes.filter((c) => c.after.rank === c.before.rank)
  console.log(`against ${against}: ${compared.length} compared, ${worse.length} worse, ${better.length} better, ${other.length} other`)
  for (const [label, list] of Object.entries({ worse, better, other })) {
    for (const c of list) if (!heldOut.has(c.id)) console.log(`  ${label} ${c.id}: ${c.before.text} -> ${c.after.text}`)
  }
}
