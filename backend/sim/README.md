# Parameter-calibration simulation harness

Offline calibration for the learning loop. The subjects under test are the
production domain functions in `src/domain/loop/` (`bandit.ts`, `options.ts`,
`allocation.ts`, `frame.ts`, `decide.ts`) imported directly — no
reimplementation — driven through synthetic markets calibrated to measured
production values. Sweep 1 results (bandit, futility): [REPORT.md](./REPORT.md).

Experiments:
- `bandit`, `futility` (`environment.ts`): the discovery-strategy bandit and the
  futility vitals over a finite prospect pool (sweep 1).
- `options` (`options.ts`): the middle and inner layers of #793 — which options
  run, which are dropped or brought back, how sends split. `current` calls
  `decide()`; `proposed` runs the candidate rules in `proposed.ts`, which move
  into `domain/loop` once their values are chosen.
- `supply` (`supply.ts`): when a discovery strategy counts as exhausted.
- `frame` (`frame-signal.ts`): when the outer layer proposes rethinking the frame.

Non-deploy asset, like `scripts/probe-*.ts`: outside the Worker bundle and
the main `tsc` project. CI compiles it so a rename in `src/` cannot break it
unnoticed, but never runs it — sweeps happen by hand when a calibration
question comes up.

## Running

```bash
cd backend
npx tsx sim/run.ts                # every experiment, full seed counts
npx tsx sim/run.ts --quick        # iteration mode
npx tsx sim/run.ts --experiment=bandit|futility|options|supply|frame --seeds=N --samples=N
npx tsx sim/run.ts --experiment=options --only=current,proposed   # one process per row set
npx tsc --noEmit -p sim           # typecheck
```

Outputs land in `sim/out/` (gitignored). Runs are seeded and deterministic:
identical inputs reproduce identical numbers, so a rerun is only meaningful
when an input changed.

## When to rerun (and what to update first)

1. **A parameter change is under consideration** — add the candidate values
   to the variant lists in `run.ts`, sweep, and compare against REPORT.md
   before touching the defaults in `domain/loop/config.ts` (or a per-project
   `leverConfig` override).
2. **The measured environment moved** — the constants in `scenarios.ts`
   (reply rate, bounce rate, foldering factor, sends/day) are production
   measurements, and every conclusion is conditional on them. Recalibrate
   them first, then re-verify even unchanged defaults. Example: the futility
   survival line currently sits exactly on the measured ~1% healthy reply
   rate; if that rate moves, the futility conclusions must be redrawn.
3. **The mechanism changed** — changes to the imported domain functions
   (`bandit.ts`, `options.ts`, `allocation.ts`, `frame.ts`, `config.ts`) flow in
   automatically, but `environment.ts` mirrors the tick wiring in
   `domain/loop/decide.ts` (seeds, floors, rotation gating) and the
   service-layer orchestration by hand (the contract is listed in its header
   comment). If `domain/loop/decide.ts`, `services/loop/` or `prospects.ts`
   changes, update the mirror first or the numbers are silently wrong.

## What the simulation answers — and what it cannot

It answers structural and relative questions: which parameters matter at a
given volume band, premature-archive probability, detection-delay vs
false-positive frontiers, sensitivity rankings, behavior under skew and
depletion. It cannot calibrate absolute reality, and it says nothing about
LLM-side quality (hypothesis hit-rate, approach text quality) — those belong
to the production journal review below and to scoring against known ground
truth.

## Production-side counterpart: journal review

The online half of the same PDCA loop. Every tick journals its full decision
into `lever_decisions` — weights, P(best), archives with reasons and sample
sizes, per-arm stats, prior-day registrations vs the batch plan, vitals, and
`configUsed` (the effective config snapshot) — with seeded RNG, so any past
decision replays exactly. Periodically (quarterly at ~10 sends/day; the
volume bounds statistical power) pull `get_lever_decisions` and check:

- **Archive regret**: an archived arm's subsequent measured rate vs the
  survivors. History is never deleted, so this stays computable.
- **Futility false fires**: the verdict series vs replies that arrived
  later; REPORT.md carries the simulated expectation to compare against.
- **Plan adherence / depletion**: sustained gaps between journaled
  registrations and the batch plan mark an unexecutable strategy.
- Explore-lane cost can only be approximated (sends carry no lane tag);
  add instrumentation only if a review shows it is actually needed.

When a review surfaces an anomaly, encode the observed situation as a
scenario here and test the fix offline across seeds before applying it.
