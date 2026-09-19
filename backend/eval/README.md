# List-quality evaluation harness

Grades what the reply-rate loop cannot grade in time: does discover collect
organizations that meet the criteria the project wrote down, and does its route
reach a source that makes such organizations enumerable.

Two questions, deliberately kept apart:

- **Precision** — conformance to the frozen spec. Needs no sends, no replies.
  Answerable in an afternoon, so a pipeline change can be graded before it ships.
- **Coverage** — how much of a reference list, built by hand from an enumerable
  source for the same spec, the pipeline's own route reaches. The reference
  doubles as the inventory of collection methods worth codifying.

Coverage is deliberately not called recall. A reference list is one source's
sample, never the whole population, so a candidate outside it is not an error,
and an entry the pipeline missed is not proof it chose something worse. A miss
says the source is unexploited — nothing more.

Whether the criteria themselves predict interest is a different question, and
this harness does not answer it — that loop closes on replies and rejection
reasons, over months.

## What it deliberately does not measure

`collect` runs every pass cold: `searchNotes` is null and nothing dedups against
the tenant's existing pool, so one pass is comparable with the next. The price is
that precision here is the first batch from a blank slate, never the twentieth,
and the harness is silent on supply durability, on novelty against what is
already held, and on portfolio breadth.

Those are not nice-to-haves. Checked against the live pool afterwards
(`supply.ts`), a third of what a cold pass returns is already held, and the
re-finds are the fits: precision fell from 61% to 46% once they were removed.
And a pass that ran zero searches — answering from the model's memory, which
the design forbids — scored mid-pack on precision, so precision alone would
have passed it. Read this number beside the rest of the criteria, never on its
own.

A warning about the obvious substitute: fresh rate is not a durability metric.
A seam that has been mined out keeps returning domains nobody has seen, they
are simply worse — on the same run the strategy with the highest fresh rate
(80%) had the lowest fit among those fresh domains (18%). The quantity that
means anything is fresh ∩ fit.

The subjects under test are the production prompts in
`src/services/pipeline/discover.ts`, imported directly. Non-deploy asset like
`sim/` and `scripts/probe-*.ts`: outside the Worker bundle and the main `tsc`
project. CI compiles `eval/` and `sim/` but never runs them — every run here
is by hand.

## Running

```bash
cd backend
npx tsx eval/run.ts collect  <target>   # production discover → candidates.json
npx tsx eval/run.ts snapshot <target>   # freeze page text for candidates + reference
npx tsx eval/run.ts hits     <target>   # qualifying-term hits per snapshot, read before labelling
npx tsx eval/run.ts score    <target>   # precision, coverage, verdict counts
npx tsc --noEmit -p eval

# read out of production (read-only, one tenant)
npx tsx --env-file=.env.production eval/supply.ts   --tenant <id> [--project <id>] --out <dir>
npx tsx --env-file=.env.production eval/learning.ts --tenant <id> [--project <id>] --out <dir>
```

`supply.ts` answers how long a discovery strategy keeps yielding; `learning.ts`
counts every signal a send came back with, including the ones the reward
function weights at zero.

`collect` runs the production discover calls (`discover.search` and
`discover.extract` as `services/llm/routes.ts` configures them) and spends what
a production cycle spends.

Every command takes `--provider gemini|openai` (default `openai`). `collect`
only runs `openai`, what production runs; `gemini` names the runs collected
before the switch, which `snapshot`, `hits` and `score` still read. Each writes
beside the other (`passes/` + `candidates.json` for Gemini, `passes.openai/` +
`candidates.openai.json` for OpenAI), so both score against one set of labels.
`--extractor <model>` extracts with that model instead of the route's and
writes `passes.openai.<model>/` + `candidates.openai.<model>.json`. `collect`
takes a comma list (`--extractor gpt-5.6-terra,gpt-5.6-luna`) and extracts
every model from the same search, so the difference is the model's alone —
only for passes collected in that one call, since an existing pass is skipped.
Snapshots and `labels.json` are keyed by domain and shared: a verdict is about
the organization, not about which provider surfaced it. `passes.openai/`
records no extractor model: it holds whatever the route used when each pass
was collected (Luna for the passes of 2026-09-17). Pass `--extractor` to pin
the model.

`collect` records the tokens, cached tokens, reasoning tokens, search calls and
unique queries each call reported, and the pass's list-price cost by model;
`score` sums them. The two search bills are not the same unit: Gemini charged
per unique grounded query, OpenAI per `web_search` call with the retrieved
content billed as input tokens, so `score` prints both counts beside the
money.

## Target data

Lives in `eval/data.local/<target>/`, gitignored: reference lists and third-party
page text stay on the machine that built them.

| File | Written by | What it is |
| --- | --- | --- |
| `spec.json` | hand | The frozen input: `business`, `salesStrategy`, `targetCountries`, `strategies[]`, and the `frozenAt` date every later run is scored against |
| `candidates.json` | `collect` | What discover returned per strategy, with the search text and query count behind it |
| `snapshots/<domain>.md` | `snapshot` | Front page plus up to 3 linked about / news / careers pages, decoded by the declared charset |
| `reference.json` | hand | The reference list, each entry carrying `why` it qualifies and `foundVia` which source |
| `signals.json` | hand | `{ "terms": [...] }` — the qualifying observables of the spec, what `hits` counts |
| `labels.json` | hand | `{ "<apex-domain>": { verdict, basis, reason, evidenceUrl, quote, by } }` |

A verdict judges the candidate against the frozen spec, on the frozen snapshot:

| Verdict | Meaning |
| --- | --- |
| `fit` | Meets the Target and its Prerequisites, does not match Not a fit |
| `unreachable` | Fits, but the site publishes no usable contact channel — an enrich-stage loss, counted apart so it never flatters precision |
| `not_an_org` | Not an organization at all (an article, a directory, a product page) |
| `url_dead` | The official URL does not resolve, or belongs to someone else |
| `prereq_unmet` | A Prerequisite is contradicted by the page, or nowhere observable on a page that was read |
| `not_a_fit` | Matches the spec's Not a fit |
| `fabricated_reason` | `matchReason` or a signal states something its cited page does not |
| `duplicate` | The same organization already counted under another domain |
| `unknown` | The snapshot could not be taken — a bot check, a 429, a JS shell, an empty body. Record which in `reason` |

The line between the last two carries no discretion: a page that froze with
real body text and no qualifying signal is `prereq_unmet`, never `unknown`.
`unknown` names a failure of this harness's fetch layer, not a property of the
candidate. Run `hits` first and label from its output: an audit of this
harness's own labels found three that asserted an absence the frozen page
contradicted, the same mistake the `fabricated_reason` verdict exists to catch.

`basis` records how much of a verdict is opinion: `page-fact` when the frozen
snapshot states it outright, so a second adjudicator lands on the same verdict;
`judgment` when it took weighing. Precision is `fit / settled` (`unknown` leaves
the denominator and is reported beside it) and is also reported split by basis,
because a number built mostly on judgment is a different kind of number — and it
points an audit at the rows worth re-reading.

Coverage counts only reference entries labelled `fit` or `unreachable`: an entry
the adjudication rejected was our own mistake, not a miss.

What `hits` counts, so a number in its output is read for what it is: literal,
case-insensitive substring matches, non-overlapping per term but counted per
term, so `mcp` and `.mcp.json` both score the same text; three excerpts at most;
a term broken across a line break does not match; and the URLs `snapshot` writes
as page headings are excluded, because they are this harness's text rather than
the page's.

## Adding a target

1. Write `spec.json`. For a real project, freeze what its `business` and
   `sales_strategy` documents said on `frozenAt` — never a cleaned-up version,
   or precision measures a spec production never ran.
2. `collect`, then `snapshot`.
3. Build `reference.json` by hand against the same spec, researching sources
   properly rather than repeating the pipeline's searches. Snapshot again to
   freeze the entries discover missed.
4. Write `signals.json`: the spec's qualifying observables, as terms a page
   states. Run `hits` and label every domain from its output, reading the
   snapshot rather than the live site.
5. `score`.
