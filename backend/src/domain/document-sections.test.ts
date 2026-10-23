import { describe, it, expect } from 'vitest'
import { applySectionEdits, sectionEditSchemaFor } from './document-sections'

const DOC = `# Sales Strategy

Intro line.

## Target

### Primary
Clinics

## Messaging
Sign off as Uno.
Never promise a price.

## KPI
Positive rate
`

const applied = (doc: string, edits: Parameters<typeof applySectionEdits>[1]): string => {
  const r = applySectionEdits(doc, edits)
  if (!r.ok) throw new Error(r.why)
  return r.content
}

describe('applySectionEdits', () => {
  it('replaces the named section with its subsections and keeps the rest as written', () => {
    expect(applied(DOC, [{ heading: 'Target', content: '## Target\n\n### Primary\nDentists\n\n### Not a fit\nHospitals' }])).toBe(`# Sales Strategy

Intro line.

## Target

### Primary
Dentists

### Not a fit
Hospitals

## Messaging
Sign off as Uno.
Never promise a price.

## KPI
Positive rate
`)
  })

  it('matches the heading with or without its ## marks', () => {
    expect(applied(DOC, [{ heading: '## KPI', content: '## KPI\nMeetings' }])).toBe(DOC.replace('Positive rate', 'Meetings'))
  })

  it('edits the text above the first heading under the empty heading', () => {
    expect(applied(DOC, [{ heading: '', content: '# Sales Strategy\n\nNew intro.' }])).toBe(DOC.replace('Intro line.', 'New intro.'))
  })

  it('adds a section written after the one an edit replaces', () => {
    expect(applied(DOC, [{ heading: 'KPI', content: '## KPI\nPositive rate\n\n## Response Definition\nA meeting request' }]))
      .toBe(`${DOC}\n## Response Definition\nA meeting request\n`)
  })

  it('removes a section whose new content is empty', () => {
    expect(applied(DOC, [{ heading: 'Messaging', content: '' }])).toBe(DOC.replace('## Messaging\nSign off as Uno.\nNever promise a price.\n\n', ''))
  })

  it('applies several edits, a renamed heading included', () => {
    expect(applied(DOC, [
      { heading: 'Target', content: '## Who to reach\nDentists' },
      { heading: 'KPI', content: '## Channels\nEmail' },
    ])).toBe(`# Sales Strategy

Intro line.

## Who to reach
Dentists

## Messaging
Sign off as Uno.
Never promise a price.

## Channels
Email
`)
  })

  it('returns the document untouched when no edit changes a section', () => {
    const doc = 'Intro\n## Target\nClinics'
    expect(applied(doc, [{ heading: 'Target', content: '  ## Target\nClinics\n\n' }, { heading: '', content: 'Intro' }])).toBe(doc)
  })

  it('keeps a neighbour exactly, a missing blank line included', () => {
    expect(applied('## A\none\n## B\ntwo', [{ heading: 'B', content: '## B\n2' }])).toBe('## A\none\n## B\n2\n')
  })

  it('takes a heading that itself starts with #', () => {
    expect(applied('## #1 priority\nold\n', [{ heading: '#1 priority', content: '## #1 priority\nnew' }])).toBe('## #1 priority\nnew\n')
  })

  it('does not take a ## line inside a code fence for a heading', () => {
    const doc = '## Messaging\n```\n## not a heading\n```\n## KPI\nx\n'
    expect(applied(doc, [{ heading: 'Messaging', content: '## Messaging\nShort.' }])).toBe('## Messaging\nShort.\n\n## KPI\nx\n')
  })

  it('closes a fence only on its own marker', () => {
    const doc = '## Target\n````md\n~~~\n```\n## inside\n````\n## Messaging\nKeep\n'
    expect(applied(doc, [{ heading: 'Target', content: '## Target\nNew' }])).toBe('## Target\nNew\n\n## Messaging\nKeep\n')
  })

  it('refuses a section that does not open with its heading', () => {
    expect(applySectionEdits(DOC, [{ heading: 'Target', content: '### Primary\nDentists' }]))
      .toEqual({ ok: false, why: 'the new "Target" section does not open with its ## heading' })
  })

  it('refuses a heading the document has twice, and a section edited twice', () => {
    expect(applySectionEdits('## A\n1\n## A\n2\n', [{ heading: 'A', content: '## A\n3' }]))
      .toEqual({ ok: false, why: 'the document has 2 "A" sections' })
    expect(applySectionEdits(DOC, [{ heading: 'KPI', content: '## KPI\n1' }, { heading: '## KPI', content: '## KPI\n2' }]))
      .toEqual({ ok: false, why: 'the section "KPI" is edited twice' })
  })

  it('refuses a heading the document lacks, naming the ones it has', () => {
    expect(applySectionEdits('# T\n## A\n1\n', [{ heading: '# T', content: '## T\nnew' }]))
      .toEqual({ ok: false, why: 'the document has no "T" section; its sections are "", "A"' })
  })

  it('refuses a section added beside the one it was meant to replace', () => {
    expect(applySectionEdits(DOC, [{ heading: '', content: '# Sales Strategy\n\n## Target\nDentists' }]))
      .toEqual({ ok: false, why: 'it would leave 2 "Target" sections; replace or remove the old one' })
  })

  it('refuses edits that would leave the document empty', () => {
    expect(applySectionEdits('## A\n1\n', [{ heading: 'A', content: '' }])).toEqual({ ok: false, why: 'it would leave the document empty' })
  })
})

describe('sectionEditSchemaFor', () => {
  it('lets a model name only the sections the document has', () => {
    const schema = sectionEditSchemaFor(DOC)
    expect(schema.shape.heading.options).toEqual(['', 'Target', 'Messaging', 'KPI'])
    expect(schema.safeParse({ heading: 'Sales Strategy', content: '' }).success).toBe(false)
  })
})
