# Calibration report — sweep 1 (2026-08-15)

Conditions: bandit 100 seeds / futility 400 seeds, MC 500 samples (production
runs 10k — threshold-adjacent wobble reads slightly larger here), 10 sends/day,
180 days, one-factor-at-a-time around the shipped defaults plus three futility
frontier probes. Reproduce with `npx tsx sim/run.ts` (see README.md).

Revision note: the initial sweep was fully re-measured after the PR #358
review found the exploit lane unfaithful to production ranking (scores are
materialized at tick time, fresh rows sit at 1.0, ties resolve by createdAt).
The fidelity fix withdrew one recommendation: with faithful semantics, newly
registered rows are exploited at neutral score until the next tick, which
feeds starved arms data quickly — premature archives at the default
`archiveThreshold` are already rare, so the initially recommended 0.05 → 0.02
change lost its basis.

Out of scope (by design): absolute calibration against reality, LLM-side
quality, `targetActiveStrategies` / `maxActiveStrategies` (arm counts were
fixed per scenario), epoch-cut behavior.

## Conclusions (defaults)

| Parameter | Shipped | Verdict | Basis |
|---|---|---|---|
| `futilityConfidence` | 0.95 | **raise to 0.99** (adopted 2026-08-16; run.ts OFAT probe swapped to 0.95 accordingly) | Healthy-1% false-fire rate over 180 days 14.0% → 4.0%; dead detection 460 → 630 sends (+2.5 weeks at 10/day); keeps near-dead sensitivity 91.7% and foldered sensitivity 36.5%; dominates lowering the survival rate to 0.0075 (85%/30% at the same FP) |
| `futilitySurvivalRate` | 0.01 | keep | Lowering it trades away sensitivity (frontier below). Structural caveat: the measured healthy reply rate ~1% sits exactly on this line |
| `futilityMinSends` | 100 | keep | Completely inert at this volume band (pDead needs ~300+ mature sends before any tested floor binds); harmless guard |
| `archiveThreshold` | 0.05 | keep (initial 0.02 recommendation withdrawn) | Premature kills already 0–2% at default; 0.02 barely moves them and just slows pruning (clear-winner discovery 0.80 → 0.71); 0.1 speeds discovery but costs 10% premature kills under foldering and archives in ~100% of runs |
| `strategyWeightFloor` | 0.1 | keep | 0.05 / 0.2 show no consistent gain |
| `explorationShare` | 0.2 | keep | 0.1 slows discovery and capture on clear-winner; 0.3 shows no consistent gain |
| `minSamplePerArm` | 30 | keep | Insensitive for discovery/capture; only moves rescue timing (p90 days: 15→20-38, 30→26-52, 60→60-82) and archive eligibility |

Sensitivity ranking at this volume band: futility = survivalRate ≫ confidence
> minSends (inert); bandit = archiveThreshold (churn/discovery-speed trade) >
explorationShare > floor ≈ minSample (near-inert).

## Futility frontier (400 seeds, 180 days, 10 sends/day)

| Config | Healthy-1% false fire | Dead detection p50 | Near-dead 0.3% detection | Foldered 0.57% detection |
|---|---|---|---|---|
| default 0.01/0.95 | **14.0%** | day 45 / 460 sends | 99.0% | 68.5% |
| **0.01/0.99 (recommended)** | 4.0% | day 62 / 630 sends | 91.7% | 36.5% |
| 0.0075/0.95 | 2.5% | day 56 | 85.3% | 30.2% |
| 0.0075/0.99 | 0% | day 78 | 55.2% | 7.7% |
| 0.005/0.95 | 0% | day 77 | 40.3% | 3.5% |
| 0.02/0.95 | 97.8% | day 29 | 100% | 100% |

## Bandit headlines (100 seeds, default config)

| Scenario | Discovered within 180d | Sends to discovery p50/p90 | True-best killed | Any-archive rate | Capture vs oracle |
|---|---|---|---|---|---|
| clear-winner (2×) | 0.80 | 740 / 1500 | 1% | 74% | 0.74 |
| skewed-incumbent (84/98) | 0.93 | 260 / 1250 | 0% | 100% | 0.75 |
| foldered (×0.57) | 0.66 | 1160 / 1640 | 2% | 69% | 0.65 |
| depleting-winner | 0.91 | 340 / 800 | 0% | 91% | 0.66 |
| flat-field (all equal) | — (undefined) | — | — | 70% | 1.00 |

## Structural findings (not fixable by parameters)

1. The default survival line (1%) equals the measured healthy reply rate — at
   a boundary truth, pDead random-walks near the confidence threshold and
   false fires do not vanish with more data (measured as a 180-day rate;
   longer exposure accumulates more). Confidence 0.99 mitigates, not solves.
   The principled placement is "half the healthy rate" — with the sensitivity
   trade shown in the frontier.
2. Discriminating 1% from 0.57% (foldering) is structurally slow at this
   volume (1.75× gap, 10 sends/day). The futility alert is a slow tripwire;
   fast deliverability detection stays with seed tests and Postmaster Tools.
3. Discovering a 2× winner takes ~750 sends (p50) to ~1500 (p90) — 2.5 to 5
   months at 10/day; under foldering only 0.66 of runs discover within 180
   days. Do not expect visible bandit convergence in the first months of a
   fresh epoch.
4. The 84/98-grade skew is not a trap: fresh rows are exploited at neutral
   score until the next tick, so a starved true winner accrues data from the
   day it registers (discovery p50 260 sends, 0% killed).
5. Archive events are routine bandwidth reallocation, not verdicts: at the
   default threshold, 70–100% of runs archive at least one arm within 180
   days — including 70% in the all-equal null field, at zero capture cost.
6. The depletion shortfall signal separates cleanly (5–10× the cumulative
   shortfall of other scenarios) — usable as a Phase 2 replenishment trigger
   input.
7. Verdict flicker from data evolution remains (0.2–1.4 futile→ok transitions
   in threshold-adjacent scenarios); the same-data flicker was already fixed
   by de-dating the vitals seed. Production's 10k-sample MC will show
   slightly less than the sim's 500.
