import { z } from 'zod'

// A rewrite names only the sections it changes, so what it leaves out stays.
// A section is a `## ` heading and all under it, `###` included; the text
// above the first one is the section ''.
const HEADING_DESCRIPTION = "The section of the current document it replaces, by its ## heading; '' is the title and text above the first one"
export const sectionEditSchema = z.object({
  heading: z.string().describe(HEADING_DESCRIPTION),
  content: z.string().describe("The section's whole new text, its ## heading line first; a ## section written after it is added there. '' removes it"),
})
export type SectionEdit = z.infer<typeof sectionEditSchema>

export function sectionEditSchemaFor(doc: string) {
  return sectionEditSchema.extend({ heading: z.enum([...new Set(sectionsOf(doc).map((s) => s.heading))]).describe(HEADING_DESCRIPTION) })
}

export type SectionEditResult = { ok: true; content: string } | { ok: false; why: string }

type Section = { heading: string; text: string; edited: boolean }

const HEADING = /^## +(.*?)\s*$/
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/

const keyOf = (heading: string): string => heading.trim().replace(/^#{1,6}\s+/, '')
const listed = (sections: Section[]): string => sections.map((s) => JSON.stringify(s.heading)).join(', ')

// Each section keeps its exact text, so the sections joined are the document.
function sectionsOf(doc: string): Section[] {
  const sections: Section[] = [{ heading: '', text: '', edited: false }]
  // A fence closes only on its own marker, at least as long, with nothing after it.
  let fence = ''
  for (const line of doc.split(/(?<=\n)/)) {
    const heading = fence === '' ? HEADING.exec(line) : null
    const mark = FENCE.exec(line.trimEnd())
    if (mark && fence === '') fence = mark[1]!
    else if (mark && mark[1]![0] === fence[0] && mark[1]!.length >= fence.length && mark[2]!.trim() === '') fence = ''
    if (heading) sections.push({ heading: heading[1]!, text: line, edited: false })
    else sections[sections.length - 1]!.text += line
  }
  return sections
}

const repeated = (sections: Section[]): Map<string, number> => {
  const counts = new Map<string, number>()
  for (const s of sections.slice(1)) counts.set(s.heading, (counts.get(s.heading) ?? 0) + 1)
  return new Map([...counts].filter(([, n]) => n > 1))
}

// A section the edits leave alone keeps every character. Refused whole, never
// in part.
export function applySectionEdits(doc: string, edits: SectionEdit[]): SectionEditResult {
  const sections = sectionsOf(doc)
  const keys = edits.map((e) => keyOf(e.heading))
  const twice = keys.find((k, i) => keys.indexOf(k) !== i)
  if (twice !== undefined) return { ok: false, why: `the section "${twice}" is edited twice` }
  let changed = false
  for (const [i, edit] of edits.entries()) {
    const key = keys[i]!
    const content = edit.content.trim()
    if (key !== '' && content !== '' && !HEADING.test(content.split('\n')[0]!)) {
      return { ok: false, why: `the new "${key}" section does not open with its ## heading` }
    }
    const at = sections.filter((s) => s.heading === key)
    if (at.length === 0) return { ok: false, why: `the document has no "${key}" section; its sections are ${listed(sections)}` }
    if (at.length > 1) return { ok: false, why: `the document has ${at.length} "${key}" sections` }
    const section = at[0]!
    if (content === section.text.trim()) continue
    section.text = content === '' ? '' : `${content}\n\n`
    section.edited = true
    changed = true
  }
  if (!changed) return { ok: true, content: doc }
  const kept = sections.filter((s) => s.text !== '')
  const out = kept.map((s) => s.text).join('')
  if (out.trim() === '') return { ok: false, why: 'it would leave the document empty' }
  const content = kept[kept.length - 1]!.edited ? `${out.trimEnd()}\n` : out
  const before = repeated(sections)
  const doubled = [...repeated(sectionsOf(content))].find(([k, n]) => n > (before.get(k) ?? 1))
  if (doubled) return { ok: false, why: `it would leave ${doubled[1]} "${doubled[0]}" sections; replace or remove the old one` }
  return { ok: true, content }
}
