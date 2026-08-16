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

# Calibration report — sweep 2 (2026-08-16): regime survival

Question: can the loop survive a deliverability regime shift (healthy →
incident → repaired) **without manual intervention**? Autonomy is a hard
requirement; the manual `measurementsSince` epoch was the only futile-verdict
reset and cuts every aggregate at once. This sweep covers the epoch-cut
behavior sweep 1 left out of scope.

Conditions: as sweep 1 (bandit 100 / futility 400 seeds, MC 500, 10
sends/day) plus two regime scenarios — `incident-recovery` (futility: healthy
60d → delivery ×0.1 for 120d → repaired, 90d observation) and `regime-shift`
(bandit: clear-winner rates, healthy 60d → ×0.1 for 60d → repaired, 120d
observation). New policies swept: `fwindow=N` (candidate futility window over
mature sends, sim-level param — not yet a lever) and `epoch@repair` (manual
measurementsSince set on the repair day, replayed as a full aggregate wipe).

Revision note: re-measured after the PR #362 review found two calibration
defects — "fired during incident" also counted pre-incident false fires
(now: any futile day inside [incidentStart, repair)), and the simulated
window spanned L+1 mature-day buckets (now: exactly L, matching the
half-open production band). Every conclusion held; numbers moved ≤ 1pt / 1
day.

## Conclusions

| Decision | Verdict | Basis |
|---|---|---|
| Futility aggregation | **switch from all-history to a rolling window; adopt `futilityLookbackDays` = 90 as a real lever** | Incident fire rate 55.0% → 95.5%, autonomous post-repair clear 36.4% → 97.4% at p50 31 days (floor ≈ the 14-day maturity lag); stationary cost is mild (healthy-1% false fire 4.0% → 5.2%, near-dead 91.7% → 86.8%, dead detection unchanged at 630 sends) |
| `rewardLookbackDays` | **keep unset (no forgetting for the bandit)** | The relative bandit self-recovers through the incident (post-repair capture 0.922, best of all variants); lookback=90 premature-kills the true winner in 24% of runs and drops post-repair capture to 0.793; lookback=180 is no-op-to-slightly-worse |
| Manual epoch (`measurementsSince`) | **do not use for regime repair** | Bandit: post-repair capture 0.799 vs 0.922 for doing nothing — the wipe discards still-valid relative knowledge and re-learns from scratch. Futility: clears instantly but only by blinding the sensor (≥ minSends + maturation ≈ 3.5 weeks insufficient; a failed repair goes undetected), and it cannot fix the low incident fire rate. With the window adopted it has no remaining autonomous role |

## Futility under incident-recovery (400 seeds)

| Policy | Fired during incident | Cleared after repair (of fired) | Clear days p50/p90 | Healthy-1% false fire | Dead detection p50 |
|---|---|---|---|---|---|
| all-history (shipped) | 55.0% | 36.4% | 55 / 88 | 4.0% | 630 sends |
| fwindow=120 | 87.5% | 93.1% | 49 / 74 | 4.5% | 630 |
| **fwindow=90** | **95.5%** | **97.4%** | **31 / 59** | 5.2% | 630 |
| fwindow=60 | 86.0% | 99.4% | 16 / 37 | 5.2% | 630 (98.8% rate) |
| epoch@repair | 55.0% | 98.6% | 0 (manual) | 4.0% | 630 |

fwindow=60's thinner evidence (~600 sends) sits closer to the decision
boundary: incident sensitivity and near-dead sensitivity (73.0% vs 86.8% at
90) both drop. 90 is the knee.

## Bandit under regime-shift (100 seeds)

| Policy | Discovered | Capture (whole run) | Capture after repair | True-best killed |
|---|---|---|---|---|
| all-history (shipped) | 0.79 | 0.792 | **0.922** | 2% |
| lookback=180 | 0.60 | 0.786 | 0.912 | 7% |
| lookback=90 | 0.60 | 0.714 | 0.793 | **24%** |
| epoch@repair | 0.75 | 0.717 | 0.799 | 7% |

## Structural findings

1. **All-history futility fails in both directions.** Mid-stream, the healthy
   prefix dilutes the posterior — only 55% of runs fire during a 120-day
   near-total outage, and ~22% fire for the first time *after* the repair
   (the alarm rings once the fire is out). Post-repair, the dead mass keeps
   the verdict lit: 64% of fired runs never clear within 90 days. No
   parameter fixes this; the aggregation is the defect.
2. **An absolute-rate sensor needs bounded memory; a relative comparator does
   not.** A common delivery factor scales every arm alike, so the bandit's
   ranking knowledge survives the regime and dilution merely slows it —
   while any forgetting (window or epoch) destroys discriminative evidence
   the low volume cannot re-earn quickly. Bounded memory for the sensor,
   unbounded for the bandit is the consistent design, not an inconsistency.
3. **The epoch cut is strictly dominated for regime repair**: worse than
   doing nothing on the bandit side, worse than a window on the sensor side,
   and it requires the human intervention the loop must not depend on.
   Scope note: arms *registered during* a dead regime carry damning
   zero-reply history the shift scenario does not model (all arms span both
   regimes here); stagnation rotation and archive-revival bound that damage,
   and modeling mid-run registration was deliberately left out of the
   harness.
4. The 31-day p50 clear time at fwindow=90 decomposes as ~14 days of
   maturation lag (mechanical floor — replies cannot be counted earlier) plus
   window turnover; faster clearing than ~2.5 weeks is unreachable at any
   window length.
