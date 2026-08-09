# Decision Log

One dated line-item per significant design decision, with the *why*. This is the
rationale record — SPEC.md says what the rules are; this file says why they were
chosen, so future sessions (human or AI) don't re-litigate or accidentally undo
them. Append new entries at the bottom; never rewrite old ones (correct with a
new dated entry instead).

Format: `## YYYY-MM-DD — short title`, then 1–3 sentences of context/why.

**Scope: engineering only.** This file is committed and the repository is
intended to become a public release, so commercial, legal, personal, and IP
decisions (funding, licensing strategy, third parties) do NOT belong here.
They go in `legal/BUSINESS_DECISIONS.md`, which `.gitignore`
keeps out of git permanently. Anything committed lives in git history forever,
in every clone and fork, so the split is enforced before the fact rather than
scrubbed after it.

---

## 2026-07-09 — Browser-based averaged-EMT, not full switched EMT
The platform targets concept-validation studies (DC-link stability, ride-through,
islanding) where averaged converter models are sufficient. Full switched EMT
would demand µs-scale steps and switching-event handling that don't pay off for
this use case and would kill browser interactivity.

## 2026-07-09 — Trapezoidal nodal solver (EMTP method) with LU factorization
Industry-standard, A-stable, and companion models make every block a
conductance + history current — one uniform interface. LU is refactored only on
topology events (breaker/fault), not every step.

## 2026-07-09 — Probe blocks for voltage; automatic per-element current recording
No separate current-meter block: every element's current is recorded
automatically, and voltage probes wire to any node. Keeps the palette small and
avoids meter-placement busywork.

## 2026-07-09 — Self-contained CSS palette in the widget/shell
The first prototype used host-page CSS variables and rendered black/invisible
outside claude.ai. All colors are self-contained with light/dark awareness —
never rely on host CSS variables.

## 2026-07-09 — File-based project + build.py + smoke_test.js as the handoff shape
Source split into src/{blocks,solver,ui}.js + shell.html, assembled by
`python build.py` into a standalone index.html, validated headlessly by
`node smoke_test.js`. Chosen so routine work can be done by any model/human
against SPEC.md without regenerating the app in chat.

## 2026-07-12 — Synchronous generator as the only block with true inertial dynamics
GFM inverters use algebraic droop; syncgen carries a genuine swing equation.
Multi-machine load sharing validated analytically: Pe_i = Pm0_i − (Kgov_i+D_i)·Δf
with a common Δf (smoke test asserts <0.0001 Hz spread).

## 2026-07-13 — central_ups.json rebuilt from PNNL topology; broken UPS examples removed
`DC_CENTRAL_UPS.json` (hard solver error: AC/DC tied without a converter port) and
`DC_CENTRAL_UPS_1.json` (transformer ratios collapsed buses to ~0 V) were deleted
rather than patched. Rebuilding on the current block set was cheaper and safer
than archaeology on files that never demonstrated anything.

## 2026-07-13 — R loads + rectifier grid-lost trip (tgrid) instead of CPLs in central_ups.json
Constant-power loads behind transformer leakage oscillate, and the PFC's lagged
dead-bus draw (i ∝ v(k−1)/v²) has loop gain ≈1, sustaining a phantom ~476 V bus
that defeats UV tripping. Physical fix, matching PNNL's described protection:
resistive support loads and the rectifier trips with the grid. Third occurrence
of the CPL-instability class in this project — treat CPLs behind impedance as
suspect by default.

## 2026-07-13 — Sag case (central_ups_sag.json) uses PFC UV self-trip, not scripted trip
For the case study the disturbance is physics-driven: a 0.3 Ω
feeder fault sags the bus to ~24 %, and the rectifier's own undervoltage
protection (√v² ≥ 0.5·√2·Vac) trips it — no `tgrid` script. Demonstrates the
protection model rather than bypassing it.

## 2026-07-13 — Integer-cycle RMS windows for measurements
A 20 ms window (1.2 cycles at 60 Hz) beats at a 50 ms period and produced a
phantom ripple in report charts. Any RMS windowing must use integer cycles
(33.33 ms at 60 Hz).

## 2026-07-13 — Probe/bus signals looked up by block ID, never by position
`r.vp` is ordered by the blocks array filtered to probe|bus; adding a probe
shifts every later index. A positional assumption broke the sag regression test.
Always map: `probeIds.indexOf(id)`.

## 2026-07-13 — Log-decrement damping uses ζ = δ/√((2π)² + δ²)
Peaks are one full period apart, so the constant is (2π)², not (4π)² — the wrong
constant halves ζ and was verified numerically before fixing the smoke test.
Cross-check: ωₙ must be invariant across a damping-coefficient sweep.

## 2026-07-14 — Schematic layout conventions (user-defined, learned from central_ups_sag_mod.json)
For presentation-quality example layouts: (1) single-terminal blocks (gnd,
probe, fault) are rotated so their terminal faces the node they attach to —
a source's ground goes on the far outer side at the same horizon, rotated
90°/270°; (2) a tapped branch block (fault) sits on the opposite side of the
line from where it visually exits, terminal toward the wire; (3) bus fan-outs
leave visible wire between bus and block, with each block level with its own
tap (tap pitch ≥72 world units so labels clear the next row); (4) probes sit
directly adjacent to their node, approaching perpendicular to the main run;
(5) nodes with >3 connections get an explicit named Bus block (e.g. the
"380 V DC Link" added to central_ups_sag.json); (6) never let a block lie on
its own wires. Applied to central_ups_sag.json (electrically unchanged —
smoke test numbers identical); downstream figures regenerated from it.

## 2026-07-14 — Auto-layout "Best fit" picks direction, not geometry
Third layout option alongside LR/TB: because the tidy-tree's depth/slot
extents are direction-independent (TB is LR transposed, block rotation
included), "fit" just predicts both bounding boxes and keeps the orientation
fitView() can display more zoomed-in on the live canvas aspect. Deliberately
NOT a crossing-minimizing optimizer — wrong cost/benefit at this tool's
circuit sizes.

## 2026-07-14 — Auto-layout places gnd/probe/fault as terminal satellites
Leaf single-terminal blocks are excluded from the tidy-tree (they no longer
consume a depth step or cross slot) and placed beside the terminal they attach
to, oriented by that terminal's actual post-layout offset from its block's
center — gnd outward on the same axis facing back, probe perpendicular to the
run, fault on the far side. One geometric rule covers LR/TB/fit and rotated
parents with no direction-specific casing. A gnd/probe with tree children
(it bridges subtrees in BFS) stays a tree node — repositioning it would break
the tree it anchors.

## 2026-07-14 — Product renamed Web EMT → OpenEMT
Rejected candidates and why: `DynSim` (hard collision — AVEVA/Schneider's DYNSIM
is an established, decades-old commercial dynamic-simulation brand);
`OpenEMTS`/`OpenETS` (ETS collides with Educational Testing Service; OpenEMTS
pronounces awkwardly); `Voltra`/`GridPilot`/`GridGPT` (all taken). `OpenEMT` is
clean, matches the exact industry shorthand ("EMT tools" — PSCAD/EMTP/ATP),
and keeps the agentic differentiator in the tagline rather than the name
itself ("OpenEMT — the electromagnetic transient simulator built for AI
agents"), matching how OpenDSS/ATP/EMTP are named.
Trademark and IP aspects of this rename are recorded in the private business
log, not here. App UI (`shell.html` title/h1, one `ui.js`
error string) renamed to match; the `webemt: 1` JSON file-format tag was
deliberately left untouched — it is an internal schema version marker, not
user-facing branding, and renaming it would break every saved example file
for zero benefit.

## 2026-07-14 — IEEE 9-bus (WSCC/Anderson-Fouad) added as first large-scale stress test
First example past a dozen blocks (33 blocks, 33 wires, meshed 6-bus 230 kV
network, 3 generators up to 247.5 MVA). Network R/L/C and transformer leakage
were converted from the published per-unit data on a 100 MVA base using
standard Zbase = kV²/MVA; governor droop, damping, and AVR droop aren't part
of that classical dataset and are engineering estimates scaled to machine
rating, documented as such in `examples/README.md` rather than presented as
literal published values.

**Trap hit and worth flagging for any future multi-phase load-power example:**
the `pq` block's P/Q are applied identically per phase (`makeElements` runs
once per phase, each instance reading the same `P.P`/`P.Q`), so total 3-phase
power is 3x the entered value, not the entered value split across phases.
Entering total system MW/Mvar directly caused a ~3x real-power overload and a
~50% network-wide voltage collapse that looked at first like a modeling bug;
per-phase values (total/3) fixed it and all 6 buses settled within 5% of
230 kV nominal with all 3 generator frequencies within 0.03 Hz of 60 Hz.
Confirmed by contrast: `syncgen`'s `Pm0`/`Sbase` ARE total 3-phase quantities
(the swing equation sums `pI` across all 3 phases internally), so the two
block families use opposite conventions — worth checking per-block, not
assumed, whenever a new power-rated block is parameterized from a published
total-power dataset.

Auto-layout's "Best fit" ran cleanly on a meshed (non-tree) topology for the
first time — the BFS-spanning-tree layout doesn't require acyclic graphs, it
just doesn't optimize the one back-edge specially; visually acceptable in
this case. Final block positions were captured from the live auto-layout and
written back into the example file rather than hand-authored.

## 2026-07-14 — Breaker "no reclose" trap; parallel-breaker pattern for a temporary outage
A single `brk` element supports exactly one state transition in its lifetime:
`solver.js`'s close check requires `!e.opened` (never closes if it has ever
opened), so a breaker that starts closed and opens at `topen` latches open
forever — it cannot be given a later `tclose` to bring it back. Discovered
while wiring "take the largest generator out for 50 ms, then restore it" for
`ieee9bus.json`.

Fix: two `brk` blocks in parallel across the same two nodes, each doing its
one allowed transition — block 34 starts closed (`init:1`) and opens once at
`topen`, block 35 starts open (`init:0`) and closes once at `tclose` set to
the restore time. Neither block ever reopens or recloses itself; the outage
window is the gap between the two independent one-time events. Verified
clean: 4 LU refactorizations (per-phase current-zero opening plus the
simultaneous 3-phase close), no singular-island error, G1's own frequency
rises correctly while disconnected (unopposed mechanical power, zero
electrical load) and the other two machines' droop picks up the slack.

## 2026-07-15 — IEEE 39-bus (New England) added; pq load instability found at high power
Second large-scale stress test (147 blocks: 39 buses, 10 generators, 12
transformers, 34 lines, 21 loads — matches the standard 34-line/12-transformer
count exactly). Built from verified primary sources, not memory: MATPOWER's
`case39.m` (bus/branch/dispatch data, fetched directly) and ANDES's
`ieee39_full.xlsx` GENROU sheet (generator H, Ra, Xd' — M=2H per ANDES's own
convention). No new block type was needed; evaluated `syncgen`/`xfmr`/`line`/
`pq`/`bus`/`brk` against the standard dataset's requirements first.

Two real modeling corrections made along the way:
1. **Bus 30-39 (generator buses) are already network-level nodes in this
   per-unit dataset** (case39 lists them at the same 345 kV base as every
   other bus) — the branch table's own transformer entries (e.g. 2-30) ARE
   the complete step-up transformers. Treating them as needing an *additional*
   physical-kV-referred transformer between the generator and its own bus
   (mirroring the 9-bus approach, which used real per-generator kV since that
   dataset's generator buses were genuinely at a different physical voltage)
   double-counted a transformer that doesn't exist and orphaned the bus-30
   block entirely (singular-matrix error). Fixed by wiring generators directly
   to their own numbered bus and converting Ra/Xd' using the NETWORK base
   (345 kV / the machine's own MVA rating), not the machine's physical winding
   voltage — matching how MATPOWER/ANDES/PST all actually use this file.
2. **`pq` (constant-power) loads are numerically unsafe at this power scale
   with the solver's current cold-start behavior.** With loads entered as
   published (up to 226.7 kW/phase at bus 20), several buses diverged to
   multi-million-volt values within the first simulated cycle. Isolated by
   disabling all loads (network alone: stable, ~216-220 kV) then re-enabling
   them (immediate divergence) — confirmed as the cause, not a topology or
   parameter error. Root cause: `pq`'s v² filter (`v2f`) ramps from zero over
   `Tf`, and at this load magnitude the resulting P/v2 transient overwhelms
   the UVLO's own veto before it can suppress it. Worked around at the
   example level (not a solver.js change) by using constant-impedance `load`
   (R) blocks instead, sized at nominal voltage from the same real Pd data —
   R is self-limiting by construction and cannot exhibit this failure mode.
   Trade-off: reactive load (Qd) is not represented. **Flag for a future
   session**: this is a genuine solver limitation worth fixing properly
   (e.g. non-zero v2f initialization or a soft-start ramp) before `pq` is
   trusted at hundreds-of-kW-per-phase scale; third occurrence of a
   load-model instability class in this project (see the two 2026-07-13
   CPL-instability entries) — constant-power load models behind impedance
   are suspect by default, now confirmed true for `pq` too, not just `cpl`.

Auto-layout's "Best fit" handled 147 blocks / 154 wires without incident.

## 2026-07-15 — Bus-aware auto-layout for meshed power networks
The tidy-tree layout (`doHierarchicalLayout`) is built on a BFS spanning tree
and structurally cannot draw the loops a transmission network contains: every
loop-closing line becomes an unpositioned back-edge that cuts across the figure.
On the IEEE 9-bus it produced 3 wire crossings, 5 wires-through-blocks, and 2.2x
the wire length of a hand layout; on the 39-bus, 128 crossings. Added a dedicated
`busAwareLayout()` (plus `placeBusLocals`, `declutterProbes`) in `src/ui.js`,
triggered from `doHierarchicalLayout` when a circuit has >=3 buses (wrapped in
try/catch so any unexpected circuit falls back to the tree; <3-bus radial and
converter circuits like central_ups keep the tidy-tree unchanged).

Approach (chosen with the user over a force-directed alternative, which was
rejected because it produces organic/angled edges that clash with the user's
orthogonal schematic aesthetic): treat BUSES as the backbone. Contract the
circuit to a bus graph (nodes = bus blocks; edges = 2-terminal connector
elements that bridge two buses; single-bus components are local branches). Lay
the bus graph out in columns by BFS layer from the highest-generation bus, with
barycentric within-column ordering to cut crossings. Draw buses vertical
(rot 90) so taps stack and connections leave horizontally. Per bus, assign each
connection a side (connectors toward the neighbour's column, locals outward),
pack two connections per tap (one per side), size the bar at 50 units/tap
(the user's rule of thumb), and rewrite the bus-side wire to the chosen tap
(electrically identical: all taps on a bus are one node, verified by collapsing
taps and diffing connectivity). Local branches extend horizontally away from
the bus, blocks rotated so the bus-side terminal faces the bar, parallel
elements (e.g. the outage/restore breaker pair) stacked vertically by shared
graph depth, grounds tucked beside their parent, probes seated at their tap and
nudged clear if they still overlap. Spacing is adaptive: ROW from the tallest
bus's tap span, COL from the deepest local branch (graph depth, not block count,
so parallels don't inflate it).

Results, verified by metrics (wire length, proper-crossing count, wire-over-block,
block overlap) since the browser screenshot tool was unavailable this session:
9-bus went to 0 crossings / 0 overlaps / 0 wires-through-blocks, wire length
2994-3554 (better than or near the 3242 hand layout); 39-bus from 68076 to
~29089 length (2.3x shorter) and 128 to 12 crossings (10x fewer), with 4 residual
block overlaps in the densest columns. `node smoke_test.js` still passes (layout
touches coordinates/rotations/tap-indices only, never electrical params or the
saved fixture files). The generic layout rules were extracted from the user's
hand-marked `examples/ieee9bus_rearranged.json` plus their per-change notes
(`examples/ieee9bus_layout_notes.md`). Per the agreed "local rules first, then
iterate" plan, the residual 39-bus density issues (12 crossings, 14
wires-over-block, 4 overlaps) are the next iteration target, pending the user's
visual review.

## 2026-07-15 — Bus-aware layout polish: orientation, clustering, adaptive zoom-out
Three refinements to `busAwareLayout()` / camera after IEEE39 review:
(1) New `orientTwoTerminal()` post-pass flips any 2-terminal block 180 degrees
when its wired terminal sits farther from the neighbour than its other terminal
(component lying on its own wire); purely cosmetic (only `b.rot` changes), keeps
the connection side closest to what it connects to. IEEE39: 0/154 backwards.
(2) Local branches (generators, loads) now grow into the LESS-crowded side of
their own bus instead of a fixed global edge, so sources cluster adjacent to
their interconnection bus rather than being flung to the leftmost layer.
(3) Zoom-out and fitView caps were a fixed ZMAX=4000 world units, too small to
frame IEEE39 (4300+ wide). Added `maxViewW()` = circuit extent + ZPAD (1000) on
every side, so the whole network fits with roughly 1000 units of margin; small
circuits still behave as before (floor of ZMAX).

## 2026-07-15 — Interconnection study models a new resource by generator-replacement, not a cold plant on a load bus
For the ERCOT-criteria interconnection study, the first approach (bolt a new
syncgen/gfm plant onto a new bus tied to a load bus, e.g. Bus 16) never
synchronized: a machine started at rotor angle 0 that must find a large load
angle to export its dispatch swings past its (radial, low) pull-out and slips,
collapsing the POI-region voltage; the sagging constant-R loads then spill
surplus and push system frequency up. Root cause: this is a time-domain tool
with no power-flow initializer, so a large resource added cold at a weak bus has
no consistent starting angle. Fix used: model the interconnection by REPLACING
an existing generator (keep its block id, wiring, gnd, E0/P0/Q0) with the
grid-forming inverter of matched dispatch. The incumbent's operating point is
already consistent with angle 0 (that is why the base case settles), so the
replacement inherits it and both A/B cases share an identical pre-fault
operating point. General rule for anyone extending this: to study a new large
machine/inverter, attach it at a stiff (meshed) generator bus or reuse an
incumbent's slot; do not expect a cold plant on a weak load bus to capture
synchronism without a power-flow init step.

## 2026-07-15 — This IEEE39 realization has stiff system frequency (H=50 aggregate)
Gen 210 (Bus 39, Sbase 1199 MVA, H=50) is the aggregate "rest of interconnection"
machine and behaves as a near-slack: it pins system frequency near 60 Hz, so a
self-clearing bus fault or even an N-1 830 MW generator trip moves the COI
frequency only ~0.1 to 0.2 Hz and never approaches UFLS (59.3 Hz). This is a
property of the model, not a solver issue. Consequence for studies: a
self-clearing fault here is a VOLTAGE/angle event, not a frequency event; to
demonstrate a real frequency nadir you would need to lower gen 210's H or model
a permanent generation/load imbalance in a system without a dominant slack.
Never present a fabricated nadir this network does not produce.

## 2026-07-15 — Power flow: positive-sequence Gauss-Seidel solve + machine initializer
Added a SEPARATE steady-state solver (`solvePowerFlow` in solver.js) alongside
the time-domain `simulate()`. One complex voltage phasor per AC node; constant
impedance elements (line, xfmr, cap, load R, pi shunt, and positive-sequence
z1 = zs - zm for coupled lines) fold into a complex Ybus at f0; generators mark
their terminal bus PV or slack (new `pfType`/`Vset` params on syncgen/gfm;
exactly one slack, else the largest machine is promoted); pq blocks are P+Q
injections. Gauss-Seidel with 1.5 acceleration, the simplest robust method at
OpenEMT's bus counts (Newton-Raphson is a future upgrade). After solving, each
machine's internal EMF magnitude and angle are back-computed
(E' = Vt + (Ra + jXd')*I) and stored as `block.pfInit`; makeSyncGens/
makeConverters start th/E/Pf/Qf from it and center their governor/AVR references
on the PF-consistent P/Q/E so Pm = Pe and E = |E'| at t=0.
Why: it removes the cold-start electromechanical swing/slip (see the earlier
2026-07-15 generator-replacement entry): a run initialized from PF is flat.
Measured on IEEE-39, the undisturbed-run frequency swing drops from 110 mHz
(cold) to 3 mHz (initialized); on the small slack-machine circuit guarded in
smoke_test.js it drops from 519 mHz to 1 mHz. UI: a "Power flow" button (`solvePF`) solves and annotates each
bus with |V| pu and angle (green inside 0.95 to 1.05, red outside); an "Init
from PF" checkbox makes Run solve first and carry `pfInit` to the worker (it
serializes as plain numbers, clones fine). The old "Power flow" wire-arrow
toggle was renamed "Flow arrows" to free the name.
Scope/limits (MVP): initializes machine states only, NOT passive-element
histories (line currents, cap voltages still start at 0), so a brief electrical
inrush over the first cycles remains even though the electromechanical swing is
gone; Gauss-Seidel not NR; no Q-limit enforcement, tap changers, or N-1
contingency screening yet. Dense LU still caps overall scale at a few hundred
buses (unchanged).

## 2026-07-16 — Ideas, roadmap, and decisions are three separate artifacts
`IDEAS.md` (new) holds speculative, uncommitted ideas; `SPEC.md` section 5 stays
the committed, prioritized roadmap; `DECISIONS.md` stays the after-the-fact why.
Lifecycle: idea, promote to roadmap when committed to, implement, then log the
why here and mark the roadmap item done. Rationale: a decision log is a
historical record with a deliberate never-rewrite discipline, while a backlog is
mutable and reordered constantly, so merging them would destroy the log's signal
(its whole value across compactions). A separate `plan.md` was rejected because
SPEC section 5 is already the roadmap and a second one would drift. `IDEAS.md` is
tracked, so it is engineering only: commercial and licensing ideas go in the
gitignored business log, same rule as `DECISIONS.md`.

## 2026-07-16 — Repo housekeeping after the git migration
Fixed staleness the move exposed: `.claude/launch.json` hardcoded
`--directory C:/Temp/OpenEMT` (a path that no longer exists, and an absolute
path is unportable anyway, so the flag was dropped in favor of the launcher's
cwd); CLAUDE.md was still titled "WebEMT"; README claimed the roadmap was fully
complete when item 9 (validation suite) is still open; the app subtitle predated
the power flow. Two passing references to private report material were
genericized out of engineering entries. `"webemt": 1` in the example
files was deliberately left alone (internal schema marker, not branding, per the
2026-07-14 rename decision).

## 2026-07-16 — IP screening precedes implementation of any new method
New convention after a full IP and licensing screening of the implemented
method stack: before implementing any new numerical method, solver technique,
or component/control model, check its intellectual-property and licensing
status first, and prefer classical published methods old enough to be public
domain. The current
stack was chosen from (and confirmed to be) decades-old public methods, so the
screening found no exposure; the detailed findings and the areas requiring a
real search before entry are recorded in the private business log (this file
stays engineering-only and name-free per its scope rule).

## 2026-07-16 — examples/ curated; per-block demos to tests/fixtures/; studies/ sandbox
`examples/` is a public product surface, so it now holds only the curated set:
the two IEEE systems, the two central-UPS cases, showcase, syncgen_droop, and
radial_feeder. The eight per-block development demos (bess_soc, dcbus,
dcdc_charger, gfm_bess, grid_export, hybrid, pq_piline, pv_mppt) were NOT
deleted — smoke_test.js loads them and asserts against their exact contents —
but moved to `tests/fixtures/` (paths updated in smoke_test.js and README.md);
they were doing two jobs (showcase + regression fixture) and the split makes
each role explicit. The two layout-derivation artifacts
(ieee9bus_rearranged.json, ieee9bus_layout_notes.md) were deleted outright:
the rules extracted from them live in ui.js and the 2026-07-15 layout entries.
New exploratory cases start in the gitignored `studies/` and are promoted per
the criteria in examples/README.md. Also adopted: short-lived feature branches
for multi-session/risky work, no long-lived per-subsystem branches, main
always green (see CLAUDE.md "Git workflow").

## 2026-07-16 — GFM AC current limiter: EMF backoff by fixed-point tracking, not an integrator
Method chosen: indirect limiting (scale the EMF magnitude by µ) because the
gfm branch is a linear companion inside the nodal solve — the current is an
outcome, not a reference, so direct current-reference saturation doesn't fit,
and scaling E keeps the LU untouched. The control law matters more than the
concept: three converging-on-paper variants failed in simulation before the
one that shipped (integrating attack limit-cycled 2 to 73 A around a 40 A
target through the 5 ms measurement lag; the same law with 2/4 ms taus
limit-cycled at large signal; an open-loop µ = Iacmax/(If/µ) estimate latched
at the floor because a fault's DC-offset natural response is not proportional
to µ). Shipped law: relax µ toward min(1, µ·Iacmax/If) — exact because I is
linear in µ — with T_dn = 2·T_lim for ζ ≈ 0.7 (5/10 ms), slow 100 ms release
only when the target caps at 1. Full derivation and stability analysis in
SPEC §2. Off by default (Iacmax = 0) so every pre-feature file is unchanged;
syncgen deliberately gets no limiter (machines really do deliver multiples of
rated current into faults). Known honest gap, documented §7: the first ~1.5
cycles pass the unlimited transient (outer loop, not sub-cycle hardware).
Method-family IP screening done per the CLAUDE.md rule; finding recorded in
the private business log.

## 2026-07-16 — GFM current limiter law corrected: affine phasor solve replaces the proportional fixed point (grid-tied latch-up)
Corrects the entry above, same day, found in post-implementation review. The
shipped µ* = µ·Iacmax/If law assumed current proportional to µ, which is only
true ISLANDED — and the only smoke test was an islanded one. Grid-tied (the
motivating BESS/interconnection use case) the current follows the µE − Vgrid
phasor difference, so lowering µ RAISES the post-clearing current: the wrong
feedback sign drove µ to the 0.02 floor and latched permanently (214 A held
against a 40 A limit, inverter absorbing 11 kW, 1.8 s after clearing).
Replacement: solve |µÊ − V̂| = Iacmax·|Zf| for the largest feasible µ each
step (quadratic from balanced instantaneous sums, terminal voltage measured
rather than assumed; projection B/A fallback = grid-voltage ride-through when
no µ can hold the limit), same 10/100 ms relaxation. Structurally MORE stable
than the old law (first-order, cannot limit-cycle), at the cost of slower
convergence on stiff lightly-overloaded islands. Two smaller fixes with it:
the GFL anti-windup now keys on an actively-limited flag (tgt < 1) rather
than µ ≥ 1, which floating point made permanently false after any limiting
episode (the release approaches 1 asymptotically and stalls ~1e−13 below it),
and µ snaps to exactly 1 within 1e−4 so release terminates. Lesson recorded:
a limiter validated only in the topology where its core assumption is exact
is not validated; grid-tied droop and GFL recovery are now smoke-tested.

## 2026-07-16: Induction motor (im) uses a QSS current-source interface, not an EMF branch
First block of component batch 1 (SPEC section 5 item 12). Model: classical
single-cage third-order (rotor transient EMF phasor + slip states), chosen to
match the syncgen fidelity tier. The significant decision is the ELECTRICAL
INTERFACE: two syncgen-style EMF-behind-impedance attempts were unstable by
construction (stator dc offsets, then the spinning E-prime transient, both
re-enter the rotor ODE through the instantaneous branch with round-trip gain
up to dX/Rs >> 1; no linear filter covers the whole slip range). Final
design extracts the terminal-voltage phasor with a ONE-CYCLE moving average
(integer-cycle rule), computes the stator current phasor algebraically, and
injects it as a G=0 Norton source (pq/cpl interface family, passive sign
convention, no FLOW_REVERSED entry). Full derivation and both failure
mechanisms recorded in SPEC section 2. Validated against an independent
equivalent-circuit solve: 0.08 percent slip, 0.21 percent current; DOL start
guarded by a physical-band assertion (written because both failed attempts
passed a naive "slip decreased" check while overspeeding to 6x synchronous).

## 2026-07-16: ZIP load (zip) reuses pq machinery; UVLO sheds only the I and P parts
Second block of component batch 1 (SPEC section 5 item 13). Deliberately a
thin extension of pq (same v2f tracker, quarter-period reactive reference,
G=0 injection) rather than new machinery: the only new physics is the
per-part denominator (V0 squared for Z, V0 times Vrms for I, Vrms squared
for P). Separate P and Q coefficient triples, auto-normalized to sum 1.
Undervoltage lockout sheds the constant-I and constant-P parts but keeps
the constant-Z part connected (heaters stay, drives trip), which is also
exactly the numerically safe part at depressed voltage; this differs from
pq, which sheds everything. P/Q params are PER PHASE, matching pq's
convention. Power flow treats a zip bus as a nominal P0/Q0 injection.
Validated against the hand-evaluated polynomial at V0 and 0.8 V0
(0.2 to 2.5 percent, the pq measurement class).

## 2026-07-16: Overcurrent relay (relay) is a sensing element that arms a breaker, not a switch
Third block of component batch 1 (SPEC section 5 item 14). The relay stamps
a FIXED closed-breaker conductance and never switches itself: on trip it
sets the target breaker elements t-open to the present instant, so the
existing arm-and-open-at-current-zero machinery does the actual clearing
(same reuse philosophy as the fault block). Target selection is by block ID
param (standing ID-lookup convention), validated up front with a clear
error. IEEE C37.112-1996 dynamic integral (MI/VI/EI constants) with the
standard disk-flyback reset; per-phase one-cycle sliding RMS (integer-cycle
rule); worst phase drives the trip. A new generic link() hook in simulate()
hands spanning elements the per-phase element lists; the relay is its first
user. Validated: timed trip within 3 ms of the closed-form curve at M=5,
instantaneous element, below-pickup hold, and the validation error.

## 2026-07-16: Vector-group transformer (xfmr3) built on incidence rows + Kron-reduced neutrals
Fourth block of component batch 1 (SPEC section 5 item 15). Three
single-phase ideal-plus-leakage units (the existing xfmr companion,
verbatim) mapped onto the phase nodes by connection incidence rows; wye
neutrals that are not solidly grounded become INTERNAL unknowns eliminated
by Kron reduction at build time, so the global matrix size never changes.
Zero-sequence behavior (delta circulation, ungrounded-wye blocking) falls
out of the incidence structure with no special-casing, and Yy0 solid/solid
reduces exactly to three xfmr blocks (used as the regression anchor).
Ratio param keeps WINDING semantics (a = N1/N2); line-line ratio carries
the sqrt(3) connection factor, stated in the UI subtitle. The clock-number
shift also enters solvePowerFlow via a complex-ratio (Hermitian) Ybus
stamp. Supported: Yy0, Dy1, Dy11, Yd1, Yd11; Dd and zigzag deliberately
out of scope this pass. Validated: Dy11 ratio and +30 degree lead (0.02
percent / 0.02 degree), SLG zero-sequence blocking (source zero-seq 0.000
percent while 630 A flows in the fault), 63x ungrounded-wye suppression,
PF ratio 0.01 percent.

## 2026-07-16: Switched-shunt controller (vsw) is a sensor block; controller-driven reclose allowed
First block of batch 2 (SPEC section 5 item 16). The bank itself stays
composable (cap or load behind a brk); vsw is a one-terminal sensor that
closes/opens the breaker by ID (relay link machinery). Two decisions:
(1) the standalone breaker keeps its no-reclose latch, but the
controller-driven path clears it deliberately, since repeated operation is
a switched shunt's purpose; (2) the controller does not act until its RMS
window has filled once, so the start-up ramp from zero volts cannot cause
a spurious close. Validated against the analytical sagged/compensated
phasor divider (0.11 percent) with dwell-delay timing and a healthy-feeder
hold-off.

## 2026-07-16: Surge arrester (mov) is piecewise-linear with a generic segment-switch hook
Second block of batch 2 (SPEC section 5 item 17). Piecewise-linear
two-segment clamp instead of the exponential MOV law: an alpha ~30
exponential as a lagged Norton injection is unstable without a matrix
stamp, and per-step Newton is out of scope for the LU-once architecture
(same argument class as the pq derivation). Segment changes go through a
NEW generic segCheck() hook in the solver event scan, shared with the
upcoming saturable transformer core, refactorizing exactly like a breaker
event; the clamp law is continuous at the knee so switching causes no
numerical shock. Validated to 0.00 percent against the source/arrester
divider above the knee and leakage-only below it.

## 2026-07-16: Bergeron line (tline) added as its own block, not a line param
Third block of batch 2 (SPEC section 5 item 18). Kept separate from the
lumped line block: the two models have disjoint parameter languages
(R/L/C vs Z/tau) and the traveling-wave companion is structurally
different (diagonal-only decoupled stamps + delay buffers), so overloading
line would have complicated both. Lumped-R Dommel form (R/4-R/2-R/4);
buffers store only on the second CDA half-step so switching events do not
skew the delay clock. Validated to 0.00 percent on open-end doubling and
matched-load pure delay.

## 2026-07-16: Exciter/governor land as opt-in syncgen params, proportional AVR only
Fourth item of batch 2 (SPEC section 5 item 19). Chosen over separate
control blocks (user decision): Te/Tg default to 0 and preserve the
original algebraic laws exactly, so every saved circuit and every prior
smoke assertion is untouched. The AVR is proportional-plus-lag
(ST1-class simplified) DELIBERATELY without an integrator: an integral
AVR would fight the power-flow flat start and the existing Q-droop
convention; the residual voltage error is the textbook proportional fixed
point and is asserted analytically (0.41 percent match). Governor is a
TGOV1-class first-order lag with an optional Pm ceiling; steady frequency
provably unchanged (asserted), only the transient deepens.

## 2026-07-17: SVC/STATCOM (svc) is one block with a mode param; injection is a true susceptance
Fifth item of batch 2 (SPEC section 5 item 20). One block, not two (user
decision): the devices share everything except the ceiling law, so mode
only changes the clamp (B limits for SVC, Q~V^2 at ceiling; I limits for
STATCOM, Q~V). The pq quarter-period trick used WITHOUT the 1/V^2
normalization gives a true susceptance injection, so no division-by-
depressed-voltage pathology exists in this block at all. Pure integral
control with droop slope and hard clamp (no anti-windup machinery
needed). Validated: droop line satisfied to 0.6 V on a sagged weak bus,
mode-specific ceilings to 0.13 and 0.00 percent.

## 2026-07-17: Transformer saturation lands as opt-in xfmr params via a spanning variant
Sixth item of batch 2 (SPEC section 5 item 21). Lm/lknee/Lsat params on
the existing xfmr, default off: Lm=0 keeps the original per-phase element
untouched (legacy invariance by construction). With Lm>0 the block becomes
a spanning element because the generic stamper cannot add an independent
shunt at one terminal (the same constraint that made the pi line
spanning). Flux integrates the terminal voltage; the two-slope lambda-i
map switches segments through the segCheck hook, now also scanned for
spanning elements. Magnetizing branch is lossless, so the energization
flux offset decays only through the external resistance path: that IS the
classical inrush mechanism, documented rather than damped away. Validated:
linear magnetizing RMS 1.2 percent; saturated steady peak 0.23 percent
against the two-slope prediction. Test lesson recorded: plot decimation
(~4 ms) silently hides the ~3.6 ms saturation spikes, so the assertion
keeps every solver sample.

## 2026-07-17: Three-winding transformer (xfmr3w) eliminates the star point analytically
Seventh item of batch 2 (SPEC section 5 item 22). The per-phase 3-port
star of primary-referred leakage companions has its internal star node
eliminated in closed form (Y3 and history mixing formulas in SPEC
section 2), so the matrix only ever sees the 9 phase entries plus Kron
neutrals; the xfmr3 connection-incidence machinery generalizes unchanged
(inv3 reused for the 3-neutral case). Primary-wye connections only this
pass; not in solvePowerFlow yet. Validated: Yy0d1 per-winding ratios and
clock shifts to 0.03 percent; the delta-tertiary zero-sequence sink shown
with an ungrounded primary (SLG fault current exists only through
tertiary circulation, 63x the no-path case).

## 2026-07-17: Type 4 wind (wt4) reuses the QSS current interface; injected phasor gets the 1 ms LPF
Eighth item of batch 2 (SPEC section 5 item 23). Generic textbook AVM only
(screening boundary in the business log): cubic wind curve, rating cap,
converter current limit, UVLO, fixed Q dispatch. Two findings recorded:
(1) a phasor-rebuilt current source excites the trapezoidal Nyquist
ringing of an adjacent undamped RL node (the im block never showed this
because its validation node had a stiff source); the standard cpl/pv/dcdc
1 ms LPF on the injected phasor components is the cure, and the caveat now
lives in SPEC section 7 for the whole current-source family. (2) the
suite's quarter-shift Q estimator leaks real power into Q when P/Q is
large and samples are decimated; wt4 tests keep every sample.

## 2026-07-17: VSC-HVDC (hvdc) is one block with an internal dc-link state, not a dc network node
Ninth item of batch 2 (SPEC section 5 item 24). The link is a pure
internal AVM state (dVdc/dt power balance with lumped efficiency), not a
solver node: keeps the block a drop-in two-terminal element, avoids
AC/DC classification interactions, and matches the concept-level scope
(no dc cable model). Side A PI-regulates the link with anti-windup; side
B dispatches the schedule through a ramp lag; both AC interfaces are
wt4-style QSS phasor injections including the 1 ms LPF. Validated to
0.00 percent against a unity-pf constant-P phasor solve at both source
terminals (after fixing the TEST's measurement plane: the src signal sits
after its internal Rs, and constant-P injection sags/boosts the bus, both
of which the naive expectation missed), link held at VdcRef, reversal
clean.

## 2026-07-17: FD line (fdline) ships minimum-order JMarti, no fitting code
Tenth and final item of batch 2 (SPEC section 5 item 25). One pole each
for Zc(s) and the delayed propagation H(s), Semlyen recursive convolution,
Marti wave companion on the tline stamp/buffer structure. Deliberately NO
vector-fitting code: the fitting is where JMarti implementations get big,
and at concept level user-facing pole/gain params with canned typical
defaults cover the physics the tool exists to show (dispersive attenuated
wavefronts, frequency-dependent Zc). Degenerating the params reproduces
the Bergeron line (asserted, 0.46 percent); the 60 Hz transfer matches an
independent complex two-port solve of the same rationals to 0.04 percent
in magnitude and 0.04 degrees in phase.

## 2026-07-17: Multi-operation breaker (brk nOps) supersedes the standalone-latch limitation from 2026-07-14
SPEC section 5 item 26. The 2026-07-14 entry ("Breaker 'no reclose' trap")
accepted the single-transition latch as a standing limitation and worked
around it with two parallel one-shot brk blocks (still valid, still used by
ieee9bus.json). This entry adds a real fix for the standalone block instead:
nOps (1-5) plus numbered tclose2/topen2..tclose5/topen5 params build a
per-element `sched` array of {tc,to} pairs at circuit-build time (blocks.js);
op 1 is exactly the original tclose/topen pair, so nOps=1 reproduces prior
behavior byte-for-byte and every existing example is unaffected. On a pole's
own current-zero opening, the solver event loop (solver.js) now checks for a
next scheduled op and, if present, advances tc/to/opIdx and resets
armed/opened instead of latching — the identical reset shape vsw.update()
already uses to force a controller-driven reclose on a brk element
(2026-07-16 entry), just schedule-driven instead of controller-driven.
Chose fixed numbered params (capped at 5 total ops) over an array/delimited-
string param: this is the first param that would need array/list semantics
in the schema, and a small utility-realistic cap (recloser practice is
usually <=4 shots before lockout) avoids adding that machinery for no
concrete benefit. The properties panel renders tcloseN/topenN rows only for
N up to the current nOps (ui.js showProps, dynamic post-loop special case),
so a plain single-op breaker's panel is unchanged. Caveat, documented not
coded around: nOps>1 and an external relay/vsw brkId link to the same
breaker both drive the same tc/to/opened state and will conflict if
combined. Validated: close/open/reclose/open/reclose-and-stay-closed
(nOps=3) sequence in smoke_test.js, each operation's opening still clears at
a true current zero (not the raw commanded topen instant), full existing
suite unaffected.

## 2026-07-17: Series RLC block (rlc) — new 2nd-order companion, -1 = absent uniformly across R, L, C
SPEC section 5 item 27. `load` (R), `cap` (C), and `line` (R+L) already
existed but nothing modeled true series R-L-C on one branch; building it out
of three separate blocks exposes two internal nodes for no benefit in the
common case (damped filter/snubber branches). The companion model is
genuinely new derivation work, not a reuse of `line`'s RL Norton form: a
series RLC branch is 2nd order (needs the shared branch current *and* an
independent capacitor-voltage state vC, since vC doesn't collapse to a
function of total branch voltage the way it does for a 1st-order RL leg).
Derived Req = R + 2L/dt + dt/(2C), history Ih = [v_{n-1} - i_{n-1}*k -
2*vC_{n-1}]*G (k = R - 2L/dt + dt/(2C)), and a be/CDA half-step formula for
the post-switching-event damping step, Ih_be = [i_{n-1}*(2L/dt) -
vC_{n-1}]*G — both verified algebraically (not just numerically) to reduce
exactly to `line`'s existing RL formulas when C is absent and to `cap`'s
existing formulas when R and L are absent, which is what makes those two
cases legitimate regression tests rather than independent guesses.

-1 means "component absent" uniformly across all three params, matching the
user's original design ask. R already had an unambiguous "not present" value
(0 = plain wire) so -1 is just accepted as an alias for it; L=-1 also
aliases to 0 (0 H is already "no inductor", a wire, so there's no real
sentinel need there either); C is the one case where a new convention was
required, since C=0 is NOT safe (it means the dt/(2C) term blows up to
infinity, i.e. an open circuit — the opposite of absent) — C=-1 instead
drops that term to 0, as if C -> infinity (a wire). This is the same "-1 vs
0" reasoning already used for `xfmr3`/`xfmr3w`'s Rn (0=solid ground,
-1=ungrounded), extended to a case where 0 has a different, real, dangerous
meaning for two of the three params. If all three are -1, Req would be 0 (G
= infinity); floored to a small epsilon (mirrors `brk`'s goff floor) rather
than letting the stamp blow up, since an all-absent rlc is a numerically-
forced short, not a meaningful circuit.

It's a plain per-phase element (stampPhase-style G/Ih pair), not a spanning
element — `line`'s pi-equivalent (shunt C at each end) needed to become
spanning because stampPhase can't add independent per-terminal shunt
admittances, but a true series RLC has no such shunt; it's still one
reciprocal 2-terminal branch, so no solver.js core-loop or stampPhase
changes were needed, only a new makeElements case (blocks.js) and a matching
power-flow Z-stamp (solver.js). Validated in smoke_test.js: exact (0.00%)
agreement against `load`, `line`, and `cap` in their respective limiting
cases (confirms the algebra, not just plausibility), a full 3-element case
against the analytical steady-state divider, and a switched case (paired
with a brk) confirming the be-branch settles to the correct steady state
with no spurious growth. `load`/`cap`/`line` are unchanged and remain the
right choice for the common single-component case; `rlc` is purely additive.

## 2026-07-18: Parallel RLC (rlcp) — inverted sentinel convention; no Req floor guard needed
SPEC section 5 item 28. The parallel topology inverts the meaning of zero
relative to series `rlc`: in parallel, R=0 or L=0 is a physical short
(infinite conductance), not "no component", so -1 was chosen as the absent
sentinel for R and L. This is the opposite of series `rlc`, where 0 for any
param means "a wire" (no voltage drop) and -1 drops the term from the chain.
For C, both -1 and 0 naturally yield zero contribution: C=-1 would give
GC = 2*(-1)/dt (negative), so it's gated off by the hasC guard, while
C=0 would blow up in series but in parallel GC = 2*C/dt = 0 when C=0, so no
sentinel is needed — C accepts either value. The key structural difference from `rlc` is that all
three components are independent admittances (G = GR + GL + GC), so there is
no Req-style denominator to blow up: when all three are absent, G simply sums
to zero and the branch is an open circuit — no epsilon floor guard was needed,
unlike `rlc` where R=L=C=-1 would give Req=0 (G=infinity), requiring a goff
floor. This makes the parallel case numerically simpler despite being one
order higher (3 states vs 2 for series). Implemented as plain per-phase
element with the same stampPhase/inject/update shape. Validated: exact (0.00%)
against `load`/`line`(R=0)/`cap` in limiting cases, full parallel admittance
divider (1.42%), resonance impedance peak at f0 confirmed, and switched be/CDA
half-step with no spurious growth.

## 2026-07-18: rlcp canvas symbol — two vertical buses, three horizontal branches
The rlcp block shipped registered everywhere except `blockSymbol()` (no
`case 'rlcp'`), so it rendered as bare terminals with nothing between them.
Symbol convention chosen to mirror the series `rlc` glyph: series lays R, L, C
left-to-right along the midline; parallel lays R, L, C top-to-bottom as three
horizontal branches between two short vertical buses, so the three components
visually share the same two nodes (left bus = node 1, right bus = node 2) the
way a parallel branch actually connects, the inverse of the series chain. L
sits on the straight-through middle row so the side terminal leads line up
with it; cap plates are shortened (+/-6 vs series rlc's +/-11) to fit the
bottom row inside the 44-tall box. All three glyphs always drawn regardless of
which params are -1, same "always show all three" rule as series rlc and
line's box+arcs. Purely cosmetic: no DEFS, solver, rotation, or smoke-test
change (the rlcp assertions stayed green).

## 2026-07-18: rlc/rlcp symbols now hide absent components (reverses the "always show all three" rule)
The 2026-07-18 rlcp entry above (and the matching code comment on the series
rlc symbol) said all three glyphs are always drawn regardless of which params
are -1. Reversed: a component whose value is non-positive is now dropped from
the symbol, so the schematic reflects what is actually in the branch. Rule
chosen: a glyph is drawn iff that param is `> 0` (a real, nonzero component).
This treats both the `-1` absent sentinel AND the degenerate `0` (a wire in
series, a short in parallel) as "not a component to draw," uniformly across
both blocks, and it makes the symbol agree with `blockSub` (whose per-part
label filter was aligned to the same `> 0` predicate at the same time, so a
0-value part is hidden in both label and symbol rather than showing "0Ω").
Series rlc fills each dropped slot with a lead so the chain stays continuous
(all three absent -> a plain wire, the numerically-forced short). Parallel
rlcp uses two vertical buses spanning only the present rows; with one part
left it collapses to that single midline glyph (standalone load/line/cap
style, no buses), and with none left it is an open branch (nothing drawn
between the terminals). The `> 0` rule is a cosmetic choice, not a solver
change: the solver's own hasX gating is unchanged (e.g. parallel hasR is
`R >= 0` because R=0 is a real short that contributes Infinite conductance;
the symbol simply chooses not to draw a 0Ω resistor box for that degenerate
case). Verified by headless render of all 8 param combinations per block.
No smoke-test impact (the suite exercises the solver, not the SVG, and no
saved example or fixture uses an rlc/rlcp block).

## 2026-07-18: real API surface (MCP server + CLI) wrapping the pure core
OpenEMT's differentiator is being built for AI agents, but until now there
was no API: agents (and `smoke_test.js`) drove the solver by stubbing the
DOM globals, `eval`-ing `src/blocks.js + src/solver.js` with a prepended
`var S={...}`, calling `runEMT()`/`simulate()`, and parsing the positional
`drawPlots(...)` arguments. That worked only because `simulate()` and
`solvePowerFlow()` are pure and DOM-free (the worker bootstrap relies on the
same), but it was a convention, not a contract. Added `api/` as a Node
package: `api/core.js` is the stable `OpenEMT` class (catalog from `DEFS`,
load/build circuit, run simulation + power flow, query by block ID), with a
thin `api/cli.js` and a stateful `api/mcp-server.js` over stdio on top.
**Why a `vm` sandbox instead of refactoring `src/` to modules:** `src/` is
plain global-scope script concatenated by `build.py` into the browser, so
refactoring it would change the worker and break the byte-identical
`index.html`. Loading the same source as text in a `vm` context with the
minimal DOM stubs keeps `src/` the single source of truth and the build
unchanged (verified: `python build.py` output is byte-identical, `node
smoke_test.js` still green). **Why stateful MCP:** the UI is stateful (build
one circuit, then run it), so a stateful server holding the current circuit
across calls matches that mental model and lets an agent build incrementally
(add block, connect, run, query) instead of resending the whole circuit each
call. **Why MCP + CLI share a core:** the two fronts agree by construction;
no drift between the agent path and the human/CI path. All result lookup is
by block ID (the standing trap), and RMS/P/Q windows are integer cycles.
IP-screening rule does not apply (no new numerical method; MCP is an open
protocol), logged in `legal/BUSINESS_DECISIONS.md`.

## 2026-07-17: aggregation current-scaling coupler (scale) is a Thevenin tap + N-times Norton injection, not a new solver primitive
Batch 3, item 1 (SPEC section 5 item 30 — renumbered at merge time to avoid
colliding with the multi-op breaker/rlc/rlcp/API items added on `main` in
parallel while this branch was out), prompted by reviewing PNNL-38817
and ERCOT's GRIT datacenter model library while auditing studies/datacenter_01
(a local-model session had built a topology at mismatched scale: kW-level
loads under a "30 MW" label, no path to the intended hundreds-of-MW figure).
Both reference docs use a "current scaling" element to represent N identical
parallel units with one simulated reference unit. The coupling is
deliberately asymmetric: term 1 (reference-unit side) tracks term 0's
(network side) voltage, but term 0 receives N times term 1's current. Two
nodes tied by an ordinary conductor cannot do this (KCL forces equal
current through a shared branch), so it needs two electrically distinct
nodes bridged by a matched dependent-source pair, not a transformer-style
symmetric admittance. Implemented as a spanning element reusing existing
machinery: term 1 gets an ordinary shunt-to-ground G=1/Rf stamp (a
`src`-style Thevenin tap) whose reference voltage is last step's measured
V(term 0), the same one-step lag every other Norton-injection block here
already accepts (pq/cpl/pfc/batt/svc), and term 0 receives a pure Norton
injection of N times the current that flowed through that tap. Chosen
over a literal two-network (isolated-island) architecture: no new solver
concept, no second Y-bus, just one more spanning block's stamp/inject/
update against the shared V/I arrays, like gfm/svc/xfmr3. Not
power-conserving at the coupling point by design (there is no real
conductor between term 0 and term 1); represents the N-1 replicas that
are never separately simulated, and assumes them identical/undiversified.
N is real-valued, not required to be an integer count. Validated against
an independent series-divider solve (I_local = Vsrc/(R+Rf+N*Rs)) at an
integer N=100 and a non-integer N=2.5, both within 0.23 percent (the
one-step-lag residual).

## 2026-07-18: scale block's Thevenin-tap design (above) replaced with a same-step admittance stamp; corrects the residual explanation too
The 2026-07-17 entry above shipped as `src/blocks.js`, then was replaced the
same evening (commit "fix: scale block's lagged coupling was unstable for
large N") before merge: the one-step-lag Thevenin tap plus Norton injection
forms a discrete feedback loop whose gain scales with N (inject N*i into
term 0, which is next step's reference for term 1, which sets i the step
after). For the large N this block exists to support (tens of thousands,
needed to reach a hundreds-of-MW facility from a kW-scale reference unit),
that loop gain is far above 1 and the coupling diverges within a handful of
steps, independent of any switching event. Replaced with a same-step
asymmetric admittance stamp, Y = g*[[N,-N],[-1,1]] (g=1/Rf), same family
as `xfmr`'s turns-ratio stamp but non-reciprocal by design, since this
element still doesn't conserve power. Solved simultaneously with the rest
of the network in the same linear system (dense LU, no symmetry
requirement), so there is no delay and no feedback loop to go unstable;
confirmed stable at N up to 1,000,000 in an isolated circuit (vs. N=50000
diverging by step 4 under the old design). Verified algebraically
equivalent to the old design's intended steady-state solution.

This entry also corrects a second, independent error the 2026-07-17 entry
carried over unexamined: the ~0.2-0.23 percent validation residual is NOT
a "one-step-lag residual": the new stamp has no lag at all, and the same
~0.21 percent shows up when a bare `src`-to-`load` resistor circuit is
measured with smoke_test.js's own hand-rolled RMS helper over the same
non-integer-cycle window. It's ordinary RMS-window measurement noise (the
"RMS windows must be integer cycles" trap in CLAUDE.md refers to the
solver's own internal RMS used for plots/exports, which already uses
integer-cycle windows; the ad hoc `rms()` in this one test does not).
Found during a review of this branch before merge: SPEC.md and this file
both still described the discarded lagged design as final and attributed
the residual to it, so a reader (or a future session) would get the wrong
mental model of both the mechanism and the error source. SPEC.md's
Aggregation current-scaling coupler section and roadmap item 30 are
corrected in place to match (that section isn't a dated log, so it
describes current behavior directly); this file keeps the original
2026-07-17 entry and adds this correction on top, per this project's
"correct, don't rewrite" convention for DECISIONS.md.

## 2026-07-18 — MCP server config moved to .mcp.json at repo root

The OpenEMT MCP server was originally registered in `.claude/mcp.json`, which is not a path Claude Code reads for project-scoped MCP config; Claude Code reads project-scoped servers from `.mcp.json` at the repo root, so the original file was silently ignored and the `mcp__openemt__*` tools never appeared. Moved the entry to `.mcp.json` (same relative `api/mcp-server.js` path, which resolves because Claude Code spawns project MCP servers with cwd at the repo root and sets `CLAUDE_PROJECT_DIR`) and deleted the misplaced file. Project-scoped servers still need a one-time approval prompt on first use.

## 2026-07-18 — OpenEMT MCP server registered with Claude Desktop (absolute paths)

The project-scoped `.mcp.json` at the repo root is Claude-Code-only: it relies on
Claude Code spawning project MCP servers with cwd at the repo root, so a
relative `api/mcp-server.js` argument works there. Claude Desktop does not set
cwd or inherit PATH the same way, so the same entry was added to the Desktop
config at `%APPDATA%/Claude/claude_desktop_config.json` (outside the repo, a
user-profile file that is not tracked) with absolute paths: `node.exe` from
`C:/Program Files/nodejs/` and the script at `C:/dev/OpenEMT/api/mcp-server.js`.
This is safe to do because the server is cwd-independent by construction:
`api/core.js` resolves `src/` via `path.resolve(__dirname, "..", "src")` and
`api/mcp-server.js` loads core via `require("./core.js")`, both of which resolve
relative to the module file location, not the process cwd (verified by driving
the MCP handshake from `C:/Windows`). The repo `.mcp.json` keeps the portable
relative path for Claude Code; the Desktop config lives outside the repo and
uses absolute paths. Users must fully quit and relaunch Claude Desktop for the
new server to be loaded (config is read only at startup).

## 2026-07-18 — Removed the standalone R (load) block; rlc/rlcp cover it

The dedicated `load` block (label "R", single R param) was removed. Series RLC
(`rlc`) and Parallel RLC (`rlcp`) with L and C absent (`-1`) reduce exactly to a
pure resistor: same transient companion (G = 1/R, and the redundant L/C history
terms stay identically zero since i = v*R is maintained) and same power-flow
stamp (Z = R + j0). Verified in smoke_test.js (`rlc-as-R` and `rlcp-as-R`,
0.00% vs analytical). All examples, the test fixture, and every inline
smoke_test circuit were migrated to `rlc` with `{R, L:-1, C:-1}`. The two
smoke_test cases that cross-checked rlc/rlcp-as-R against the `load` block were
reworked to analytical-only (the load oracle no longer exists).

Why: a standalone resistor block is redundant once the RLC blocks support the
R-only limit cleanly, and keeping it doubled the surface area (palette slot,
DEFS entry, drawing case, two stamps, a SPEC derivation) for one parameter.

Side fix: `rlc` and `rlcp` were added to the `passive` AC/DC node-type
propagation set in solver.js (load was in it; rlc/rlcp were not, a latent gap
where a DC circuit chaining through an RLC branch would misclassify the far
side as AC). They are passive branches and already sat in the Passive palette
group, so this matches the existing classification rather than introducing a
new one. Catalog drops from 33 to 32 block types; api/test_api.js count
assertions updated accordingly.

## 2026-07-18 — Renamed palette labels CPL Load -> DC CPL, PQ Load -> AC PQ
Both blocks shared an identical arrow-in-box glyph and the generic "___ Load"
suffix, which read as interchangeable; in fact CPL is the DC constant-power
load (instantaneous P/v, 1 ms LPF, instantaneous UVLO, 1-ph only) and PQ is
its AC counterpart (RMS-normalized P+Q with a quarter-period reactive
reference, RMS UVLO). Prefixing the domain makes the AC/DC split the first
thing the eye catches in the palette and signals they are counterparts, not
duplicates. Display-label only: the `type` keys stay `cpl`/`pq`, so saved
examples, fixtures, the `webemt:1` schema, and the SPEC/DECISIONS prose (which
keeps the standard terms "CPL" and "PQ load") are untouched. Considered and
rejected: renaming to "AC Load"/"DC Load" (too generic; ZIP and a plain
resistor are also AC/DC loads respectively, and it erases the constant-power
semantic), and "AC PQL" (coined a non-standard acronym; kept the standard "PQ"
instead). Also considered and deferred: adding AC/DC corner badges to the
shared canvas glyph, rejected as redundant with the renamed labels and
inconsistent (only these two of many domain-bearing blocks would be badged);
revisit only if the confusion persists after the rename.

## 2026-07-18 — Line-to-line voltage entry via a per-circuit `vconv` flag
Power-system users think in line-to-line (LL) voltages (480, 208, 13.8 kV),
but the AC source/bus params were phase RMS (277 V/ph), annoying at entry.
The first instinct was a pure numeric conversion (redefine every param as
LL, bump `webemt` to 2, migrate all files). Investigation killed that: the
smoke tests embed 277 as BOTH the block param AND the analytical phase value
in ~5 entangled spots (ZIP sweep, vsw, svc, syncgen AVR, wt4/hvdc), so
converting means ~40 param edits plus splitting shared constants; and a
v1->v2 auto-migration cannot tell a 1-ph from a 3-ph file (phase mode is not
stored), so 1-ph user files would migrate wrong. Instead: a circuit-level
`vconv` field ('ph' | 'll'), absent => 'ph', so every legacy file, fixture,
example, and test stays byte-identical and unchanged (zero smoke/API edits).
The solver stays per-phase; a boundary helper `vPh(v,nph)` divides by sqrt(3)
only when `vconv='ll'` and `nph=3` (1-ph is untouched: line = phase). New UI
circuits default to 'll' (Clear button); the API defaults to 'ph' and opts
into LL via `setVconv` / the `set_vconv` MCP tool (backward-compatible, so
existing agent scripts using 277 keep working). PF divides Vset/E0/Vrms by
sqrt(3) on input and reports bus Vmag in the circuit's convention; Vpu is
convention-independent. Verified headlessly: 3-ph LL(480) == PH(277.13) same
physics, 1-ph LL == PH, PF Vmag/Vpu correct in both. Footgun documented in
the UI tooltip and SPEC: toggling vconv REINTERPRETS existing values, it does
not convert them, so set it before entering voltages. Deferred (separate
judgment calls): `pq`/`zip` `V0` (ZIP normalization reference, left phase),
`mov.Vc` (peak clamp, not RMS), and a real `webemt:2` schema bump if a
genuinely breaking change ever lands (the migration scaffold was not worth
building now that vconv makes it unnecessary).

## 2026-07-18 — `zip.V0` converted to the vconv convention (same day as above)
The vconv feature initially left `zip.V0` (the ZIP polynomial's nominal
reference voltage) as a phase value even in LL mode, flagged as a deferred
judgment call. Reconsidered the same day: leaving V0 in phase while every
other AC voltage param honors vconv is a consistency footgun (a user in LL
mode enters V0=480 expecting it to mean 480 LL, but it would be read as 480
phase, mismatching the 277-phase bus an LL src=480 produces). V0 is now run
through the same `vPh(v,nph)` boundary as the source voltages, so in LL/3-ph
it divides by sqrt(3) to the per-phase nominal the ZIP polynomial normalizes
against. Verified headlessly: LL(src=480, V0=480) draws the same per-phase P
as PH(src=277, V0=277) at both nominal and 0.8*V0. `pq` has no V0 param, so
this is `zip`-only. `mov.Vc` (peak, not RMS) and the DC voltages remain
unconverted by design.

## 2026-07-18 — vconv toggle converts entered values (not reinterprets)
The vconv toggle is circuit-level, so switching it mid-build reinterpreted
already-entered voltages (a 480 entered as LL, after a switch to PH, would
silently become 480 phase = wrong physics). Fix: toggling in the UI now
CONVERTS the convention-aware params on every placed block by sqrt(3)
(PH->LL multiply, LL->PH divide, rounded to mV so repeated toggles don't
drift), preserving the physical voltage. This makes mid-build convention
switches consistent. Made undoable by adding `vconv` to the undo snapshot
(snapshot/restoreSnapshot in ui.js); undo now reverts both the values and
the convention. Also: a freshly placed block in LL mode now defaults to its
LL equivalent (e.g. src 277 ph default -> 480 LL) instead of a phase number
that would read as LL. The API `setVconv` stays flag-only (agents set it
before building, per the set_vconv tool description), so this conversion is
UI-only. Sentinel 0 values (Vset/Vref "0=auto") are invariant under scaling.

## 2026-07-18 — line block glyph: shunt capacitors + π label, conditional on C>0
The `line` block is a Pi model only when C>0; with the default C=0 it is a
plain series RL line. Renaming it "Pi Line" or stamping π on the default would
mislabel the common case (and the block also has a coupled mode via Rm/Lm),
so the name stays "Line" and the Pi topology is shown only when active. The
glyph now renders the two shunt branches as actual capacitor symbols
(vertical drop to two horizontal plates) instead of bare ground ticks, and
adds a π label above the series branch, so a Pi line reads as a Pi line at a
glance while a series-RL line still reads as series RL. Visual-only; no
solver, schema, file, or test impact.

## 2026-07-18 — validation suite: harness, independent phasor solver, manifest
SPEC §5 item 9 (validation suite) is the one outstanding committed roadmap
item. The suite already existed in substance as smoke_test.js (~60 analytical
checks covering every block), so the work was framing, not building from
scratch: (1) a per-block PASS/FAIL registry with hard/soft gating and an
end-of-run summary, where tolerance gates call `record()` instead of
`process.exit(1)` so one regression no longer masks the rest (catastrophic
solver-error guards still bail immediately, since continuing reads undefined
metadata); (2) `tests/reference/phasor.js`, a self-contained complex nodal
solver with no dependency on src/, generalized out of the pi-line test's
hand-rolled 2-node solve, with the pi-line check and a demo-circuit cross-
check now pointing at it as a genuinely independent code path; (3) standalone
checks for the four blocks that had none (cpl, src, gnd, probe); (4)
VALIDATION.md, the per-block manifest of checks, reference types, and
tolerance bands. The reference-tool (PSCAD-Free) class is still absent and is
the remaining gap before item 9 can be struck.

## 2026-07-19 — educational science panel (per-block physics + equations, im prototype)
A new UI layer: selecting a block shows a collapsible "Physics & equations"
panel with the block's governing equations, live values substituted from its
own params, and an inline equivalent-circuit SVG. The point is pedagogical
differentiation (a power-systems EMT tool that teaches the physics behind each
component, not just a schematic editor), and it doubles as the natural home
for the future tiered-detail feature. Rendered inline with styled HTML/Unicode
and a hand-drawn SVG, no KaTeX or other dependency, so the build stays offline
and byte-clean; a real math renderer is the production path if the concept
lands. Dispatched from showProps via sciencePanel(b) by block type; im is the
only case so far, so adding the next block is one XSciencePanel function plus
one case line. Sourced in ui.js beside the block hints so a block change
forces a doc review, since a wrong formula undermines trust worse than none.

## 2026-07-19 — UI layout: clustered toolbar, overlay-drawer panels, single plot, Wide toggle
Reworked the chrome for scannability and a stable canvas. The flat toolbar is
grouped into labeled clusters (Blocks, Edit, File, Sim, Run). The property
panel split into a params rail (#params, the action side) and a science rail
(#science, the reference side). The first attempt used a 3-column CSS grid
where selecting a block shifted the canvas into the center column; that
resized the canvas on every select/deselect and was annoying, so the rails
became absolute overlay drawers inside .cnvwrap: the canvas is always
full-width and never resizes on selection, and the rails float over its
left/right edges on selection (science inset 48px to clear the zoom control
cluster). Default plot count dropped from 2 to 1 (add-plot still available).
A Wide toggle drops the max-width cap (1400px default) so the app fills wide
monitors, persisted in localStorage. Responsive width steps under 1100 and
760px. showProps is unchanged in logic: it still toggles .sel/.msel on .emt
and writes to #params/#science; only the CSS interpretation changed (overlay
show/hide instead of grid-column shift). Visual/UI only; no solver, schema,
file-format, or test impact.

## 2026-07-19 — detail tiers deferred; "absent tier = full visibility" convention
Considered building three detail tiers (Basic/Standard/Advanced) as a per-block
parameter-exposure system. Deferred all of it, including the scaffold, because there
are no users yet and the feature is not urgent; the per-development tax of
the chosen design (default: an absent tier field reads as Advanced, i.e.
always shown, so a new param needs no tier decision) is near-zero whether the
scaffold is built now or later, and the codebase is already tier-friendly
(declarative DEFS params, a generated property panel, dict-based save), so
waiting does not paint into a corner. The convention held for the future
retrofit: a param with no tier field is full visibility, and tiers are built
as subsets that drop params down (Basic/Standard), not as three identical
copies. The licensing model is a commercial decision, not yet made, and
belongs in legal/BUSINESS_DECISIONS.md when it is.

## 2026-07-19: science panels for the machine family (syncgen, gfm, hvdc, wt4, svc)
Extended the educational science panel (SPEC section 5 item 31, im was the
prototype) to the five dynamic-grid blocks: synchronous generator, GFM
inverter, VSC-HVDC, Type-4 wind, and SVC/STATCOM. Each gets the full IM-style
treatment: a prose intro, the governing equations with live values substituted
from the block's own params, a hand-drawn inline SVG (equivalent circuit for
the EMF-behind-impedance machines via a shared emfBehindZSvg helper; a block
diagram for HVDC; a cubic P(v) curve plus current-source shunt for WT4; a V-Iq
droop characteristic plus shunt for SVC), and a collapsible scope-and-limits
sub-section. syncgen and gfm share the EMF-behind-Z drawing because their
electrical branches are structurally identical (the difference is the theta
update law, which the equations carry). The live values are computed from
params only, so numbers that depend on the network (syncgen Ks/wn, gfm total
tie X/R) are presented as formulas with prose, not fabricated. Caught and fixed
one factual error during review: the GFM panel originally cited the filter-alone
X/R (inductive, the easy case) in the sentence about the slow/poorly-damped
regime, which is actually the resistance-dominated total tie (X/R below 1);
rewritten to distinguish filter-alone from total-tie X/R. UI only, no
solver/schema/example/test impact; smoke_test.js (70 checks) and api/test_api.js
both green, build.py regenerated. Remaining for item 31: the rest of the catalog
(passives, lines, transformers, converters, protection, sensors).

## 2026-07-19: science panels for the line family (line, tline, fdline)
Extended the educational science panel (SPEC section 5 item 31) to the three
line blocks, at full IM-style fidelity. `line` branches internally on its
mode: plain series RL (default), nominal-pi with shunt charging (C > 0), or
3-phase mutually coupled (Rm/Lm), each with its own equivalent-circuit SVG
(series chain, pi with C/2 shunt caps to ground at each end, or three coupled
phases with an M bar). `tline` gets the Bergeron companion equations plus a
propagation figure (forward wavefront + reflected wave), and a physical
interpretation of tau as roughly 300 m/us times the travel time in km.
`fdline` gets the JMarti rational Zc(s) and H(s), forward/backward wave
relations, and a two-panel Bode-style SVG sampling the actual rational
functions (|Zc(f)| rolling Zlf -> Zh, |H(f)| dc gain att rolling off at ph).
One honest modeling note baked into the line panel: the line block carries no
frequency parameter (it is a time-domain trapezoidal companion, frequency-
agnostic), so the phasor illustrations use 60 Hz as a labeled reference rather
than fabricating a frequency; the time-domain companion equation is the
primary content. SVGs reuse the IEC-resistor / arc-coil idiom and the var(--*)
CSS-variable palette established by the IM prototype. UI only; smoke_test.js
(70 checks) and api/test_api.js both green, build.py regenerated. Remaining
for item 31: transformers, passives, converters, protection, sensors.

## 2026-07-19: science panels for the transformer family (xfmr, xfmr3, xfmr3w)
Extended the educational science panel (SPEC section 5 item 31) to the three
transformer blocks, at full IM-style fidelity. `xfmr` shows the ideal-ratio
plus primary-referred-leakage grounded two-port, the symmetric 2x2 nodal
stamp Y = G*[[1,-a],[-a,a^2]], and the opt-in piecewise-linear saturable
magnetizing branch (flux integral + two-slope lambda-i map), with the
classical inrush mechanism stated honestly (energization flux offset decays
only through the external source resistance, tau ~ Lm/R_source). SVG is the
two-coil-on-iron-core figure with a common ground return and the Lm shunt
added when saturating. `xfmr3` derives the vector-group physics from the
winding incidence (Y vs delta, sigma = the clock number), computes the
line-line ratio k2/(k1*a) and the clock phase shift live from the conn
string (Dy11 -> leads 30 deg, |VLL2|/|VLL1| = sqrt3/a = 0.866 at a=2, matching
the smoke test), and explains the Kron neutral elimination and the
zero-sequence circulation/blocking; SVG is a vector diagram with the primary
and secondary phasor triangles rotated by the connection shift. `xfmr3w`
shows the three referred leakage branches meeting at the analytically
eliminated internal star node (vs = (sum gw*aw*uw + sum Ihw)/G), the 3x3
port-admittance stamp, and the delta-tertiary zero-sequence sink; SVG is the
per-phase 3-port star equivalent (vertical star bus, three R+jX arms to P/S/T).
Same honesty note as the line family: xfmr and xfmr3 carry no frequency
parameter (passive companions), so the leakage-reactance illustrations use
60 Hz as a labeled reference. UI only; smoke_test.js (70 checks) and
api/test_api.js both green, build.py regenerated. Remaining for item 31:
passives, converters, protection, sensors.

## 2026-07-19: science panels for the passives (rlc, rlcp, cap, gnd, probe, bus)
Extended the educational science panel (SPEC section 5 item 31) to the six
passive / structural blocks. `rlc` and `rlcp` are the rich pair: series RLC
shows the second-order companion (one current + one vC state, Req = R + 2L/dt
+ dt/(2C), the trapezoidal history and vC update) with the series impedance and
resonance frequency live, and a series-chain SVG that draws only the present
elements; parallel RLC shows the admittance-sum companion (G = GR + GL + GC)
with the parallel resonance live, and the SVG emphasizes the key teaching
point, the sentinel-flip vs series (here -1 = absent but 0 = SHORT, the
inverse of series RLC; all-absent is a clean open, not a forced short). `cap`
is the standalone trapezoidal capacitor companion (G = 2C/dt), noting it is the
same form every capacitor in the solver reuses. `gnd`, `probe`, and `bus` are
short panels (no params, minimal live values) but still present for catalog
coverage: ground as the 0 V datum (singular matrix without it), the probe as
the ideal current-free voltmeter (i = 0, the ID-based signal convention in
purest form), and the bus as a one-node many-taps junction. SVGs: series chain,
parallel two-rail with vertical branches (R rect / L arcs / C plates, plus a
short wire for R=0 or L=0), a 2-terminal cap, the ground symbol, a voltmeter
circle with a dashed ideal lead, and a bus bar with tap dots. 60 Hz labeled
reference for the rlc/rlcp/cap reactances (passive companions, no frequency
param). UI only; smoke_test.js (70 checks) and api/test_api.js both green,
build.py regenerated. Remaining for item 31: DC converters (pfc, batt, dcdc,
pv, cpl), protection (fault, brk, relay, mov), sensors/switching (vsw, scale),
and the source (src).

## 2026-07-19: science panels for the rest of the catalog (item 31 COMPLETE)
Finished the educational science panel for the entire block catalog (SPEC
section 5 item 31). This batch added the 12 remaining blocks at the same
full-IM fidelity (equations + live-substituted param values + an inline SVG +
a scope-and-limits sub-section each): the AC source (src); the DC converters
(pfc, batt, dcdc, pv, cpl); and protection / sensors / sources (fault, brk,
relay, mov, vsw, scale). The DC converters lean on the shared PI voltage-loop
companion (pfc, batt, dcdc all share err/integ/raw/clamp with anti-windup,
differing only in setpoint and clamp edges), with batt adding the SOC-gated
clamp and SOC integrator, dcdc adding the CV/CC mode split and the lossless
power-balance IN port, pv adding the Perturb-and-Observe MPPT over a single-
knee I-V curve, and cpl as the negative-incremental-resistance constant-power
load with its stability condition kp > P/V^2. The protection blocks lean on
time/characteristic curves rather than equivalent circuits: fault and brk
share the conductance-switch + current-zero-opening machinery (fault one-shot
to ground, brk with multi-op reclosing), relay shows the IEEE C37.112 inverse-
time t(M) curve with the dynamic disk-travel integral and the instantaneous 50,
mov shows the two-segment piecewise-linear i-v clamp, vsw shows the V-on/V-off
dead-band switching bands (a pure sensor, no stamp), and scale shows the
asymmetric dependent-source Y = g*[[N,-N],[-1,1]] stamp that deliberately does
not conserve power at the coupling. A shared curvePath() helper samples the
characteristic-curve SVGs (pv I-V, cpl I-V, relay t-M, mov i-v) directly from
the block's equations. Live values are computed from params only; numbers that
depend on the circuit (e.g. mov clamped peak, which depends on the external
source Rs) are given as formulas, not fabricated. The whole catalog is now
covered: 28 science panels plus the im prototype. UI only; smoke_test.js (70
checks) and api/test_api.js both green, build.py regenerated. Item 31 is
DONE.

## 2026-07-19: visual palette (symbol thumbnails + drag-and-drop) and optional left Library sidebar
Two related UI features, both about making the palette visual and draggable
so the learner sees what they place and can build without repeatedly re-opening
the top flyout. Direct user requests, not SPEC section 5 roadmap items.

(1) Symbol thumbnails + drag-and-drop. The flyout rows were text-only. Each
row now shows the block's actual IEC symbol beside its label by reusing
blockSymbol (the canvas art) via paletteThumb(type), which renders a synthetic
block built from DEFS defaults into a mini SVG with colors passed as
var(--bds) etc. so the thumbnail follows the light/dark theme. One art path,
reused: no new symbols. Press-and-drag from a row drops the block at the cursor
via a new drag.type='palette' (setPointerCapture on the pressed item, svgPt for
screen-to-world, addBlock so LL defaults and history still apply), with a
translucent blockSymbol ghost in render(). Click-to-place (no move) is kept,
but owned in pointerup rather than via onclick: preventDefault on pointerdown
makes the click event unreliable across browsers, and owning both paths is
deterministic and avoids a double-add. blockSymbol's midline fallback
(terms[0] ? ... : d.h/2) makes the thumbnail safe for bus (DEFS.bus.terms is
empty).

(2) Optional left Library sidebar. The flyout shows one category at a time at
the top of the page. A new optional #library drawer (toggle in the toolbar,
localStorage emt_lib, off by default) shows all four categories at once as
collapsible details groups, so blocks can be dragged straight from the sidebar
while building. It follows the overlay-drawer philosophy (canvas stays
full-width): #library floats over the left edge like #params, and when open
shifts #params right (.emt.lib .props left:226px) so the two left drawers don't
overlap. Responsive shrink at 1100/760px; no auto-hide of params (the user's
preference: let it be tight on narrow screens rather than surprising people by
hiding the params rail). The flyout drag handler was refactored into
attachPalItemDrag(el) and called for both #palpop and #library, so the two are
mechanically identical.

Both UI-only: no solver, schema, example, or API change. Smoke 70/70 and
api/test_api.js green; build.py regenerated. Commits daf4bdc (thumbnails +
drag) and 0afe6ab (Library sidebar).

## 2026-07-20 — Transformer ratio entered as per-winding line-line nameplate voltages
The xfmr/xfmr3/xfmr3w blocks now take V1/V2(/V3) rated winding voltages instead
of a bare turns-ratio `a`, because users think in nameplate voltages, not turns
ratios. The internal winding ratio `a = N1/N2` is derived from the entered
line-line voltages and the Y/D connection: `a = (V1/V2)·(k2/k1)` with `k = sqrt3`
for a wye side, 1 for a delta side (the xfmr3/xfmr3w science panels already
documented this exact relationship). For the per-phase/1-ph xfmr block the
terminal voltage IS the winding voltage, so `a = V1/V2` with no connection factor.
The legacy `a`/`a2`/`a3` params are kept as a load-time fallback inside `xfmrA`
so older saved files still solve. The voltage params are intentionally excluded
from the PH/LL vconv toggle (a nameplate is a fixed line-line value, not a
per-phase source quantity). Symbols for xfmr3 and xfmr3w gained 1/2(/3) winding
tags next to their terminals (xfmr already had them).

## 2026-07-20 — Plot decimation: keep every sample, downsample at render time
The auto plot decimation was `floor(N/1400)`, capping total plotted points at
~1400 regardless of run length, so a 2 s run stored only every 28th sample
(1.4 ms spacing) and zooming in could not reveal finer detail. Two changes:
(1) auto is now `max(1, floor(N/50000))`, so normal runs keep EVERY solver
sample and only genuinely long runs thin to cap storage at ~50000 points/signal;
(2) the zoomed-out plot view is decimated at RENDER time by per-pixel min/max
bucketing in drawOnePlot (ui.js) — for each output pixel column, draw the
min-to-max range of the samples that fall in it, so a narrow spike inside a
bucket shows as a vertical line at its true amplitude instead of being stepped
over by strided decimation. Zoomed in (fewer samples than pixels) still draws
every sample. This decouples storage (fine, for zoom-in and spike preservation)
from rendering (bounded by pixel count, peak-preserving). LTTB was rejected in
favor of min/max because LTTB picks one point per bucket and can under-state a
spike's amplitude, which matters for a transient simulator. Side effect: the
pq/zip smoke tests' forward-shift Q estimator (v[k]*i[k+shift]) is dec-sensitive
because of the loads' Tf tracker + quarter-period buffer dynamics (dec=1 lands
~8% off, dec=5 cancels to ~1.6%) — the wt4 test already flagged this same
decimation-skews-Q issue. Those two tests now pin an explicit plotUs=250 so
they are deterministic and not coupled to the auto-cap policy; the solver's
injected Q is unchanged by dec, only the test's estimate of it moves.

## 2026-07-20 — Bus gains a per-bus voltage base (`Vbase`, 0 = slack-derived)
The power-flow per-unit readout previously divided every bus voltage by the
single slack-derived Vnom, so in a multi-voltage-level circuit a healthy 480 V
bus behind a 13.8 kV:480 V transformer read 0.035 pu and the canvas
color-coding screened it as a violation. Each `bus` block now carries a
`Vbase` param (entered in the circuit's vconv convention, like other bus/source
voltages): when Vbase > 0 it is that bus's own per-unit base; when 0 (the
default) the slack-derived Vnom is used, so existing single-level circuits are
unchanged. This is a reporting/screening base only — it does not affect the
time-domain solve or the power-flow solution itself, only the Vpu annotation.
Same commit, recorded here for completeness: the Params and Science side rails
got independent show/hide View toggles (persisted in localStorage, default
shown), science panels now open by default, and the bus block's cosmetic
defaults changed (taps 6 → 1, length 160 → 50) to match the common
single-tap-anchor use.

## 2026-07-20 — Solver/physics review fixes (silent-wrong-answer class)
A full review of blocks.js/solver.js against the SPEC §2 derivations found no
physics errors in any companion model or control law, but four seam bugs, all
of the "confident wrong number, no error" class. Fixed together:

1. **Per-phase-looped spanning lines triple-stamped on DC nodes.** On a DC
   node every phase index clamps to the single unknown, so `makePiLines`/
   `makeTlines`/`makeFdlines`' ph=0..nph-1 loop stamped the same element nph
   times in parallel (measured: a DC pi-line divider read 348.4 V in 3-ph vs
   the correct 327.3 V in 1-ph). All three now collapse to one copy via the
   relay's existing `nEff` pattern, and tline/fdline were added to the AC/DC
   classification propagation set (previously a node behind a tline in a DC
   circuit silently defaulted to AC, which is how the tline case half-hid).

2. **Power flow silently severed the network at unstamped series elements.**
   `buildYbus` had no stamp for relay/tline/fdline/xfmr3w/scale; a series
   relay made the PF "converge" with the downstream bus at 0 V while the EMT
   run gave 264 V. The relay is now stamped (its fixed closed-breaker 1e4 S,
   same as its EMT stamp — trivially correct); the other four make
   solvePowerFlow() return a clear error instead of a wrong solution, because
   severing is categorically worse than the shunt blocks' documented
   "draw ignored" approximation. §7's PF-coverage wording was corrected to
   distinguish shunt (ignored) from series (refused).

3. **Silent NaN runs.** An `xfmr` with V2=0 (one typo from any real circuit)
   fell back to an undefined legacy `a`, NaN'd the matrix, and ran the whole
   simulation outputting NaN — buildLU's singularity guard cannot see NaN
   (Math.abs(NaN) < eps is false). Three layers now: a shared
   `xfmrRatioBad()` validation in both simulate() and solvePowerFlow(); a
   first-step NaN/Infinity guard on the solution vector (O(D), once) that
   converts the entire failure class into a clear error; and `rlcp`'s R=0/L=0
   "hard short" is now a floored conductance (1e-6 Ω / 1e-9 H, matching
   rlc's Req floor) instead of a literal Infinity stamp, which only worked as
   a shunt to ground and NaN'd the LU in series. The SPEC §2 rlcp paragraph
   claiming Infinity "correctly shorts" was corrected.

4. **PF generator-bus lookup hardened.** solvePowerFlow() identified a
   machine's network bus via terminal 1 only; wired the other way round the
   machine silently stopped being a PV/slack candidate. It now falls back to
   terminal 0 when terminal 1 is the grounded one.

Seven regression guards were added to smoke_test.js (70 → 77 checks), one per
fixed behavior, each pinning the analytic value or the exact error path.

## 2026-07-20: single-phase laterals via per-node phase identity + a `tap` block
Added the ability to hang a single-phase lateral off one phase of a 3-phase
feeder (pole-top transformer, 1-ph service, unbalanced spur). Chose per-node
phase IDENTITY (`phs[n]`: -1 = full 3-phase set, 0/1/2 = a lateral on that
phase) over the more general per-node phase MASK. Why: the single-index form
covers the stated use case, reuses the existing AC/DC classification fixpoint
almost verbatim (a second pass over a different lattice), and a mask remains a
strict superset to grow into if phase-to-phase / 240 V center-tap laterals
ever justify it. The tap is stamped as an ordinary small conductance rather
than merged in union-find, because merging would restore all three unknowns to
the lateral node and destroy the phase restriction - the entire point.

Two things were found by TESTING, not inspection, and are worth remembering.
(1) `curEls = phEls[0]` silently dropped every lateral branch whose phase was
not A, because that list is phase A's elements; recorded traces are now
indexed against the phases a block actually occupies, not the global phase
number. (2) Phase did not propagate through the single-phase `xfmr` (it is
seeded by the AC/DC pass, not propagated), so a pole-top transformer's
secondary silently stayed 3-phase and only one of its three phases was ever
energized - it solved, it just quietly modeled the wrong circuit.

Deliberate refusals over silent wrongness, following the existing tline/
fdline/xfmr3w/scale precedent: any non-tap block bridging a 3-phase node and a
lateral is an error; blocks implemented as SPANNING elements (relay, tline,
fdline, vsw, pfc, dcdc, pi-line, saturable xfmr) are refused ON a lateral,
since they loop the phase set themselves and would stamp three phases of a
one-phase node; and `solvePowerFlow()` refuses the whole circuit, because a
positive-sequence power flow cannot represent an unbalanced lateral in
principle (this is not a missing stamp to fill in later).

A lateral is phase-to-neutral, so `vPh()` is called with a block-local phase
count: a 277 V lateral load means 277 V phase whether the circuit convention
is PH or LL. Without this a lateral silently inherited the 3-phase LL/sqrt(3)
divide, which is the wrong physics for a phase-to-neutral connection.

## 2026-07-20: relay, vsw and pfc made lateral-aware; 1-ph PFC needs phasor injection
Widened the phase tap's supported downstream set. relay, vsw and pfc now size
and index their per-phase arrays from a new `topo.phList(b)` ([0,1,2] normally,
[0] on DC or in 1-ph mode, [k] on a lateral) instead of from `nph`. tline and
fdline stay refused BY CHOICE, not by limitation: a traveling-wave or
frequency-dependent line models a long transmission circuit, not a
distribution lateral.

relay and vsw needed nothing but the indexing change, and get a strong test
for free: a phase-A lateral is phase-to-neutral with zero phase shift, so it
must reproduce the same sub-circuit run in 1-ph mode EXACTLY. It does, to
0.0e+0 on every sample, including the relay's trip instant and the vsw's
bank-close instant. (The 1-ph rig carries a matching 1e-4 ohm resistor for the
tap's connector; without it the comparison is only good to ~4e-5 and the
invariant looks approximate when it is actually exact.)

pfc was NOT just an indexing change and is the substantive part. Its 3-phase
AC draw is an instantaneous conductance emulation resting on the balanced
identity v2 = (2/3)·Σv_p², which has no single-phase counterpart, and the
emulation itself is a one-step-lagged current source that is only stable while
kdraw < the node's companion conductance. A single phase carries 3x the kdraw
at equal power, and that node conductance shrinks as dt is refined, so the
naive port self-excited to +/-53 kV on an ordinary 4 kW lateral behind 0.5 mH.
Replaced with phasor injection, the same interface `im` was forced into for the
identical reason (SPEC §2 records its two failed attempts): extract the
terminal voltage phasor over one cycle against a self-clocked frame, solve the
current phasor algebraically, inject a reconstructed sinusoid. Unity pf falls
out by construction and there is no algebraic feedback path left to excite.
The 3-phase path is deliberately untouched, so central_ups and every other
existing circuit stay bit-identical.

Worth remembering: the first version LOOKED fine on a power-balance check
(P_ac tracked P_dc to ~2%, apparently converging as the run lengthened). It was
diverging the whole time. The balance held only because v*i was pinned by
construction while v and i drifted apart in opposite directions; the tell was
the terminal voltage reading 50 kV, which no power-balance assertion would ever
have caught. The shipped test therefore bounds the terminal voltage as well as
the power balance.

Also corrected a stale SPEC claim that the solver rejects DC blocks in 3-ph
mode. No such guard exists or ever existed, and adding one would break the
hybrid AC/DC examples. The real property, verified in both directions, is that
an AC node and a DC node may never be the same node.

## 2026-07-20: single-phase GFM inverter (lateral + 1-ph mode)
Made the GFM work on a single-phase lateral and in 1-ph mode, not just 3-ph.
The branch companion and both control laws (droop, GFL PI) were already
per-phase; only the P/Q measurement assumed the balanced set. Gave it a
one-cycle projection of v and i onto the inverter's OWN rotating reference
(θ plus phase shift), which yields P and Q with the same sign convention the
3-phase instantaneous formulas use, so everything downstream is unchanged.
makeConverters moved out of the `if (nph === 3)` guard in makeSpanning, and
the 3-ph-mode refusal was removed.

Key decision: projection onto θ, NOT a fixed quarter-cycle delay (the pq/im
delay-line technique). A GFM runs off-nominal by design (droop), and a fixed
T/4 delay is 90° only at exactly f0; at a 47 Hz operating point it is 84.5°,
injecting ~9% phantom reactive power into a resistive load, which then feeds
the Q droop. θ tracks the actual frequency and cannot mistune. First
implementation used the fixed delay and showed exactly this: 0.27 kvar into a
purely resistive island where the answer must be 0. Switching to θ projection
dropped it to -0.0 var.

Deliberate exclusion: the AC current limiter (Iacmax) is REFUSED on any
single-phase inverter, with a clear error. A bolted fault makes the inverter
slip against the grid, and single-phase P/Q cannot be measured faster than one
cycle, so the stale measurement drives the angle away instead of holding it:
measured grid-tied, mu floored at MUMIN and held 91% ABOVE the limit while the
EMF drifted ~104 deg out of phase. Islanded it happens to work (40.1 A against
40 A), but "only when islanded" is not a precondition a user can track, so it
errors rather than silently failing in the one scenario it exists for. The
3-phase limiter is untouched and still validated.

Testing note worth keeping: my exploratory DC-port and GFL checks initially
read 97 kW against a 3 kW setpoint and looked like a single-phase bug. It was
my test helper defaulting mp=1 (a huge GFL proportional gain that explodes the
frequency PI); the real 3-ph GFL test uses mp=0.05. The droop tests (mode=0,
where mp=1 IS the shipped default) were valid throughout. Once the gains
matched the known-good 3-ph GFL test, single-phase GFL tracked 5 kW/1 kvar and
the DC port balanced to <0.1%. Lesson: mirror an existing passing circuit's
parameters when validating a new mode, do not hand-pick gains.

The DC port, GFL setpoint tracking, and cold-start phase alignment
(SHIFT[global phase], so a lateral inverter does not swing in from 0) all
carry over unchanged and are covered by tests.

## 2026-07-23: PSS/E RAW importer (`src/import.js`)

Added an Import button (and `api/core.js importCase()` + an `import_case` MCP
tool + an `openemt import` CLI subcommand) that converts a PSS/E RAW case into an
OpenEMT circuit. Rationale and the non-obvious choices:

- **Standalone pure-JS parser, no external tool.** The whole product premise is
  zero-install, single-file, no other software on the client. So the importer is
  a hand-rolled parser in `src/import.js`, not a wrapper over pandapower/powerio/
  PSS/E (which exist in this dev environment as research aids only). Reading a
  documented interchange format independently is clean; the IP note lives in
  `legal/BUSINESS_DECISIONS.md`.

- **One field map for REV 30 to 36, revision used only as a gate.** The leading
  fields this importer reads (bus I..VA, load I..QL, gen I..STAT with ZR/ZX,
  branch I..STAT, the 2-winding transformer block) are stable across v30 to v36,
  verified against real v34 (`savnw`) and v36 (`ieee_25bus`, `savnw`) files. So
  there is a single field map; REV only decides accept (30 to validated),
  warn-and-attempt (above the highest validated, currently 36), or hard-refuse
  (below 30, the legacy fixed-column format). Unknown/new sections are ignored by
  construction (the section-marker walker never reads a section it was not told
  to), so the real risk is field drift within known records, not new sections.

- **Generators map to `syncgen` with real dispatch but placeholder dynamics.** A
  RAW file carries no inertia/reactance/governor data (that is in the DYR). The
  machine gets its real P/Q/Vset/MVA-base/slack-or-PV type from RAW; H and
  governor droop are generic placeholders, and Ra/Xd' are seeded from the RAW
  generator ZR/ZX source impedance when present (less arbitrary than a pure
  guess). Every import surfaces a warning that the dynamics need manual entry (or
  a future DYR import) before EMT transients are trustworthy. `syncgen` (not
  `src`) is required because only it carries the real-power injection the power
  flow needs; `src` injects zero P.

- **`vconv:'ll'`, base kV as line-to-line volts, `Zbase = kV_LL²/MVA`.** RAW base
  voltages are line-to-line and its pu impedances are on the system MVA base, so
  the per-phase ohm base is exactly kV_LL²/MVA and voltages entered as LL volts
  are recovered per-phase by `vPh()`. Validated: imported slack/PV buses hold
  their RAW setpoints and buses behind a 138/13.8 transformer read ~1.0 pu.

- **Reuses the existing load path, no second loader.** The browser factored the
  validate/backfill/commit tail of `loadCircuit` into a shared `applyCircuit()`
  that both Load and Import call; the API's `importCase()` ends in the existing
  `loadCircuit()`. Imported circuits carry only a coarse grid layout, so the
  browser runs the existing `doHierarchicalLayout('fit')` (bus-aware) afterward.

- **v1 scope:** buses, loads, generators, branches, 2-winding transformers, and
  fixed shunts (capacitive to a `cap`, inductive to an `rlc` L-only). Deferred:
  switched shunts, 3-winding transformers (`xfmr3w`), and DYR. Regression fixture
  is a hand-written IP-clean 3-bus case (`tests/fixtures/psse_3bus.raw`), asserted
  in `api/test_api.js`; no vendor-distributed RAW is committed.

- **Fixed en-route:** `drawOnePlot` crashed (`new Array(negative)`) when the plot
  canvas has zero width and there is series data. Latent before, but import makes
  it easy to hit (it always creates an auto bus-voltage plot with data), so
  guarded with an early return when the canvas is too narrow to draw. Also had
  `runPowerFlow` expose `busBlocks` so the CLI `pf` prints per-bus pu (correct
  across mixed voltage levels) instead of pu against a single flat Vnom.

## 2026-07-23: PSS/E importer fidelity pass (CW/CZ, 3-winding, shunts, ZIP)

Second pass on the importer, driven by an inventory of what the 19 PSS/E 36.5
example RAW files actually contain versus what v1 read. Prevalence numbers in
`IDEAS.md`; the ordering was by real-world frequency, not guesswork.

- **`CW` was never read: a silent wrong answer.** The winding data I/O code says
  whether `WINDV` is pu of the bus base (CW=1), kV (CW=2), or pu of `NOMV`
  (CW=3). v1 assumed one interpretation unconditionally, so a CW=2 record had its
  kV value multiplied by a kV base: a wildly wrong turns ratio with no warning.
  56 transformers in the corpus are CW!=1. Now all three codes are handled.
  `CZ` is likewise fully handled, including CZ=3 (R is load loss in WATTS and X
  is |Z| pu, so R and X are recovered properly rather than approximated), and the
  impedance base now uses the NOMINAL winding voltage rather than the tapped one.

- **Three-winding transformers now import** onto the existing `xfmr3w`. RAW gives
  the three measured winding-PAIR impedances, each on its own MVA base, so they
  are rebased to the system base before the standard star conversion
  Z1=(Z12+Z31-Z23)/2 and so on. Hand-checked against a real CW=2/CZ=3 example
  (228/136.275/21.5 kV) to the digit. Note the T equivalent legitimately produces
  a NEGATIVE arm reactance on one winding; that is expected, not a bug, but it is
  warned about because EMT stability with a negative L is not obvious.

- **Discovered while doing it: the power flow has no `xfmr3w` model at all.** Any
  circuit containing one is refused by `solvePowerFlow`, so a real transmission
  case with a 3-winding unit imports correctly but cannot be power-flowed. Logged
  in `IDEAS.md` as the main remaining blocker; deliberately NOT fixed here, since
  adding a PF stamp is solver physics and belongs in its own scoped change.

- **Switched shunts import at `BINIT`** (their initial admittance), with a warning
  that the switching control is not modeled. This section's field layout genuinely
  DIFFERS across revisions (v36 inserts `ID`, `NREG`, `NAME`; v34 does not), which
  is the first real counter-example to "one field map covers v30 to v36". Rather
  than hardcode per-revision indices, the parser now captures each section's `@!`
  column-name comment (present in v34+) and resolves fields BY NAME, falling back
  to revision-based indices for older files that have no header. That mechanism
  generalizes to every record type later.

- **ZIP loads and shunt conductance.** RAW splits a load into constant power
  (PL/QL), constant current (IP/IQ) and constant admittance (YP/YQ); v1 mapped
  everything to `pq` and silently dropped the I and Y parts. Loads with any I/Y
  content now map to `zip` with real Z/I/P fractions, and pure constant-power
  loads still use the simpler `pq`. Fixed shunts were keyed only off `BL`, so a
  pure-conductance shunt was skipped entirely; `GL` is now honored, and a shunt
  with both G and B maps to a PARALLEL RLC (`rlcp`), because a shunt admittance
  G + jB is an admittance sum, not a series branch.

- Bus record lookups became a map instead of a per-element linear scan; the
  quadratic version was fine on a 25-bus case and would not have been at
  ERCOT scale.

## 2026-07-23: Three-winding transformer power-flow stamp

Closes the gap logged earlier the same day: `solvePowerFlow` refused any circuit
containing an `xfmr3w`, so a PSS/E case with a 3-winding unit imported correctly
and then could not be power-flowed at all. Real transmission cases routinely
contain them, so this was the practical blocker on the importer being useful.

- **The star (T) equivalent is stamped, using the SAME algebra as the transient
  companion**, just written in phasors. Both now derive from one identity
  (analytic star-point elimination, `Y[k][j] = conj(A_k)*A_j*(d_kj*g_k -
  g_k*g_j/G)`), so the EMT model and the PF model cannot drift apart. That
  mattered more than saving code: a PF stamp that disagrees with the EMT model
  is worse than no stamp, because "Init from PF" would then start a run at an
  operating point the time-domain solver does not share.

- **The connection factor is the xfmr3 complex-ratio rule reused unchanged**
  (sqrt3 * e^(j*sigma*30deg) for a delta side, 1 for wye), so a delta tertiary's
  clock shift survives into the power flow and into machine init downstream.
  Primary is always wye on this block, so its factor is 1.

- **Validation is by independent construction, not by tolerance.** The T is
  rebuilt out of primitives whose PF stamps were already validated (a series
  `rlc` for the primary arm out to a virtual star bus, then one `xfmr3` per
  remaining arm, leakage on the primary side so it IS the primary-referred arm)
  and the two circuits must agree bus for bus. They agree to ~1e-10 for a wye
  and for a delta tertiary. A second anchor: opening one arm collapses the
  3x3 stamp exactly onto the existing two-winding xfmr3 stamp. Worth recording
  that the first comparison looked like a 1.5e-5 pu discrepancy and was not one:
  the API's `runPowerFlow` forwards only `busType`, so the tolerance override
  was being dropped and both runs were stopping at the default Gauss-Seidel
  tolerance. Calling the solver directly showed exact agreement.

- **A negative star-arm reactance is accepted, not guarded against.** The T is a
  mathematical equivalent, not three physical branches, and one negative arm is
  normal for a real 3-winding unit; the PF handles it. Only an exact 0 + j0 arm
  is floored, because 1/0 would put Infinity in the matrix where the singularity
  test cannot see it. The EMT-side caution about a negative L is unchanged and
  still warned about at import.

- **An unwired winding is left alone deliberately.** It keeps its own floating
  node and settles at the star potential, which is the correct open-winding
  answer; grounding it would have loaded the transformer through the third arm.

## 2026-07-24: Newton-Raphson power flow, per-island references, isolated buses

Prompted by importing the PSS/E 36.5 example corpus: several cases did not
converge, and the ones that did took hundreds of iterations. Four separate
causes, fixed together because they only show up together on real cases.

- **Newton-Raphson replaces Gauss-Seidel as the default** (SPEC section 5
  item 10 named it as the successor; classical method, public domain by age).
  Gauss-Seidel is a fixed-point iteration: linear convergence at best, 277
  sweeps on a 23-bus utility case and 1368 on IEEE 39-bus, and it DIVERGES
  outright on a series-compensated network at every acceleration factor,
  because a negative branch reactance breaks the diagonal dominance it leans
  on. NR is 4 to 5 iterations on the same cases. Gauss-Seidel is kept as the
  fallback for anything NR cannot finish, so the change can only add solvable
  cases, never remove one.

- **Six Gauss-Seidel sweeps warm-start the Newton iteration.** Not a
  performance tweak: the power-flow equations have more than one root, and NR
  converges to whichever its start is nearest. From a flat start on
  `ieee_harmonics_test_case` it converged, in the ordinary sense of a residual
  below tolerance, onto the LOW-VOLTAGE root, with one bus at 0.036 pu. That is
  a real solution of the equations and a quietly wrong answer, which is worse
  than not converging. A few unaccelerated GS sweeps cost microseconds and land
  inside the operating root's basin. The step is also damped: the whole Newton
  step is scaled by one factor when it exceeds 0.5 rad or 0.25 pu, preserving
  the direction rather than clipping components, so quadratic convergence near
  the solution is untouched.

- **Per-BUS voltage bases, not one system-wide base.** Ybus is in volts and
  spans every voltage level at once, so per-unitizing everything by the slack's
  base starts a 500 kV bus at 25 pu when the slack is a 20 kV machine; the first
  Newton step then drives a bus magnitude through zero, where the polar
  formulation is not defined. Each bus block already carries its own Vbase. The
  transformation is an exact diagonal rescaling, so no base choice is wrong in
  principle, only useless in practice.

- **A voltage reference per ISLAND, not per case.** Real cases are routinely
  multi-island (PSS/E's `sample.raw` declares six swing buses) and the solve
  previously used the first slack it found for all of them. Components are now
  labeled over the Ybus off-diagonals and each gets its own reference, promoting
  its largest machine if no swing bus was declared. What is left over has no
  source anywhere in its island: it is held out of the iteration and reported by
  name. Before this, such a bus divided by a zero Ybus diagonal and the NaN
  flooded every other bus through the dense row sums, so 41 of 45 buses in
  `sample.raw` came back NaN. Both fixes were needed: the island reference alone
  would not have caught a bus with nothing attached at all.

- **Non-convergence reports the POWER BALANCE, not just a residual.** Most real
  divergence is a balance problem that is knowable before any iteration runs.
  The solver now names the worst island's shortfall against its slack machine's
  rating, because after an import the usual cause is infeed arriving through
  equipment the importer does not model. On `sample.raw` that reads "an island
  of 40 buses needs 4967 MW from its slack machine, which is rated 100 MVA",
  which is the actual answer: its HVDC links are not imported.

- **The importer now warns about the record types it skips.** Same reasoning:
  HVDC, FACTS, induction machines, multi-section lines and node-breaker
  switching devices carry power and carry buses, so dropping them silently is
  what makes a case look mysteriously unsolvable.

- **REV 34 field shift in the generator record.** REV 34 inserted NREG after
  IREG, so MBASE, ZR, ZX, STAT and PT all sit one field later. Read positionally
  against the pre-34 layout, a v34+ file yields MBASE where ZR belongs (machine
  resistance of 100 pu rather than 0.004), the wrong machine rating, and GTAP
  where STAT belongs, so an out-of-service generator imports as if it were
  running. Now resolved from the "@!" header by name, which is the generalization
  already flagged for the switched-shunt section. `psse_3bus.raw` has no header
  comments and stays the guard on the positional fallback; the new
  `psse_rev36.raw` guards the name lookup.

- **The power-flow status line summarizes `busBlocks`, not `buses`.** Every pu
  in `buses` is divided by the single slack-derived Vnom, so on a multi-voltage
  circuit the line read "0.059 to 1.000 pu" and invented a count of buses
  outside the band while the canvas annotations beside it were correct. Every
  imported transmission case is multi-voltage, so this was the first thing a
  user saw after an import.

## 2026-07-24: Sparse power flow (CSR Ybus, sparse Jacobian, sparse LU)

The dense power-flow structures were the single structural ceiling (the
"Scale" item in IDEAS.md measured it directly). Replaced all three with sparse
equivalents, in `src/solver.js` only (no new file, so `build.py` and the
`api/core.js` vm load are untouched and the byte-identical-build discipline
holds): a COO-to-CSR `SparseBuilder` (duplicate entries summed, so parallel
branches compose as `cAdd` did), a CSR `Y` from `buildYbus`, a real sparse
Jacobian allocated ONCE on the Ybus pattern (each nonzero caches g, b, and a
block tag so the per-iteration refill touches no Ybus), and a column-list
sparse LU with threshold partial pivoting (Option B, tau = 0.1; null when a
column max is below 1e-12, the same contract as the old `denseSolve`). The
Jacoban pattern is the Ybus pattern restricted to the PVPQ/PQ subsets; it is
symmetric and every off-diagonal entry is a function of the one-way Y_ik
alone, so the asymmetric phase-shifting-transformer Ybus does not break it.
Island labeling and the Gauss-Seidel fallback are CSR row walks, so both are
O(nnz) rather than O(m^2).

Why hand-rolled in `solver.js` rather than adopting SuiteSparse/KLU: the
project is zero-install single-file, so an LGPL/GPL dependency is out, and a
new src file would mean touching `build.py` and the loader against the "no
second loader" discipline. The methods (CSR, sparse LU, Tinney minimum-degree
ordering, all 1960s) are public domain by age; the method-vs-implementation
licensing split is recorded in `legal/BUSINESS_DECISIONS.md`.

A minimum-degree fill-reducing ordering was added after measurement showed
natural (imported) bus order fills badly: on `bench.raw` (1648 buses) the
natural-order sparse LU ran minutes per iteration; ordered, fill stays near
nnz and the per-iteration cost drops to ~0.6 s. This is the "add MD only if
needed" contingency from the design pass, now triggered. The ordering is
computed once per solve and reused across every NR iteration, so its O(n^2)
selection cost is amortized to nothing.

Measured outcome (2026-07-24, PSS/E 36.5 example set):
- The memory ceiling is broken. A 7917-bus case (`bench2.raw`) now imports and
  runs; the dense Ybus could not allocate its ~63M {re,im} objects.
  Gauss-Seidel at 7917 buses is ~0.9 s for 50 sweeps (O(nnz)).
- `bench.raw` (1648 buses) is AC-unsolvable as imported (1011 MW short; its
  infeed is HVDC the importer does not model), so it never had a converged
  answer to compare against. The real win is that it no longer hangs: the dense
  solver ran 25+ minutes and had to be killed, the sparse solver finishes in
  ~40 s and reports the imbalance. There is no large SOLVABLE case in the
  36.5 corpus, so a "sub-second on a 1648-bus solving case" headline cannot be
  demonstrated here.
- Correctness unchanged: every smoke and API assertion still passes, and the
  NR-vs-GS bus-for-bus agreement tightened to ~1e-13 Vpu / ~1e-10 deg.

Remaining, deliberately not done this pass: the sparse LU stores each nonzero
as a [col, val] pair array and rebuilds rows on every elimination, so its
per-iteration cost is still ~0.6 s at 1648 buses (a solvable case of that size
would NR-solve in a few seconds, not sub-second). Reaching sub-second on
1000+-bus NR needs a typed-array symbolic factorization (pre-allocate the
fill pattern once, numeric refactor per iteration), the KLU-style next stage.
The time-domain `buildLU`/`luSolve` also stay dense for now (stage 2); only
the power flow is sparse today.

## 2026-07-24: Tier 3 PSS/E importer detail carry (MAG, end shunts, ratings, V band, area/zone/owner)

The importer now carries detail it used to drop silently, all default-off so
every saved circuit and smoke assertion is byte-identical: transformer
MAG1/MAG2 becomes a linear `Lm` magnetizing shunt on `xfmr3`/`xfmr3w` (the
same trapezoidal inductor companion `makeSatXfmrs` uses for its linear
segment; MAG1 core-loss and capacitive MAG2 are dropped, warned); branch
GI/BI/GJ/BJ line-end shunts are folded into the line pi-C (the line block
cannot place per-end admittances, so the net susceptance is split equally,
an approximation warned when the ends differ); RATE1-3, LEN, and the metered
end land on the line block as inert metadata; bus NVHI/NVLO drive a per-bus
canvas voltage band (Vhi/Vlo, falling back to 0.95/1.05 when 0) instead of
the hardcoded band; and AREA/ZONE/OWNER land on the bus as inert ids.

Why carry rather than model: these are mostly irrelevant to power flow
(magnetizing current, line-end shunts) or are study metadata (ratings,
limits, grouping) with no enforcement today. The value is honesty, not
silently losing data the RAW carries, and unblocking a future loading
readout and grouping view. The magnetizing shunt is the one piece with
solver effect, and it reuses an existing companion form rather than
introducing a new numerical method. A per-branch loading readout from the
carried RATE1 was deferred this round (noted in IDEAS.md); the metadata
carry is the mergeable core, and the readout needs terminal-bus voltage the
query path does not yet expose per branch.

## 2026-07-24: Generator reactive limits (PV to PQ), shared buses, colocated load

Three changes that had to land together, because each one alone makes a vendor
case worse.

**Reactive limits.** `syncgen`/`gfm` gain `Qmax`/`Qmin` (kvar, 0/0 = no limit,
so every pre-existing circuit solves bit-identically), the importer carries the
RAW's QT/QB onto them, and both solvers enforce the band. Newton-Raphson does it
as the classical OUTER loop: solve, pin any bus whose reactive left the band at
the limit and let its magnitude float (it becomes PQ), re-solve. It is an outer
loop rather than a test inside the Newton iteration because the set of bus types
fixes the Jacobian's row/column STRUCTURE, which `nrPowerFlow` builds and
minimum-degree orders once per call; rounds are bounded and each re-solve starts
warm, so a round costs one or two iterations, not a fresh solve. Gauss-Seidel
clamps per sweep instead. Both pins LATCH: once the magnitude floats, the
reactive recomputed from it is what is actually being injected, which after
clamping sits AT the limit rather than beyond it, so a test that only asks "is
it over the limit now" releases the bus every sweep and chatters. Release uses
the physical condition instead: the magnitude coming back through the setpoint
from the side that means the limit stopped binding. A zero band (QT == QB, the
standard way of writing a fixed-reactive machine) starts as PQ rather than
spending a round discovering it. PSS/E's +/-9999 "unlimited" sentinel is mapped
to 0/0 on import.

**Machines sharing a bus.** Real cases put several units on one bus: three
motors on bus 7 of the IEC 60909 network, eight such buses in `ieee_25bus`.
Each machine used to OVERWRITE the previous one's entry, so only the last
record's dispatch reached the network and the shipped IEC example injected
-2 MW at bus 7 where the file says -9 MW. The bus is now aggregated (P and the
reactive band add, a declared slack anywhere on the bus wins, the setpoint comes
from the largest unit), and the solved bus output is split back onto the
individual machines for their EMT initialization: P by each unit's own dispatch
with the residual shared by rating, Q by the classical "proportional to reactive
range, offset by each unit's minimum" rule, which is the allocation that puts
every machine exactly on its OWN limit when the bus is pinned at the aggregate
one.

**Colocated load.** A generator bus now schedules its machines' dispatch NET of
any load on the same bus. This is the convention gap parked on 2026-07-24 so
that Newton-Raphson could be validated against Gauss-Seidel under one
convention, and it is what forced all three changes into one commit: fixing the
aggregation alone made `ieee_25bus` WORSE (worst bus error 0.036 -> 0.090 pu),
because the two errors had been cancelling. That case puts 1889 MW of its 3528
MW of load on generator buses, and dropping it left the slack absorbing about a
thousand MW of phantom surplus; under-counting the generation had been hiding
most of it.

Measured against each vendor case's own solved voltages, worst |dV| in pu:
IEC 60909 0.0033 -> 0.0009, IEEE harmonics 0.0398 -> 0.0175, `ieee_25bus`
0.0361 -> 0.0351, `savnw_nb` 0.1196 -> 0.1092, everything else unchanged. No
case got worse. Every hand-built example (`ieee39bus`, `ieee9bus`,
`radial_feeder`, `syncgen_droop`, `central_ups`) is bit-identical, since none
has a shared bus, a colocated load, or a declared band.

Both shipped imported examples were regenerated, which also picked up the Tier 3
importer fields they predate (Vhi/Vlo, area/zone/owner, line ratings).

Not fixed here, found while validating and logged in IDEAS.md: the importer
maps a RAW `ANG` of -30 deg to `Dy1`, putting the delta on winding 1, where the
file's own VECGRP says `YNd1` (delta on winding 2). Since the positive-sequence
stamp scales a delta side by |c|^2 = 3 exactly, the wrong winding both flips the
phase-shift sign and scales the series impedance by 3. It is visible in the
harmonics example as the entire remaining error: BUS 8 and BUS 302, the only two
buses fed by a YNd1 unit, sit 30 deg the wrong way and drop about a third of the
voltage they should.

## 2026-07-24: Transformer vector groups on import (VECGRP, delta winding, shift sign)

The importer chose an imported transformer's connection from `ANG1` alone,
mapping a -30 deg shift to `Dy1`. Both halves of that were wrong, and the
compound error was the largest known discrepancy on any imported case.

**Which winding carries the delta is an impedance question, not a cosmetic
one.** `xfmr3`'s R/L are PER-WINDING: the positive-sequence stamp scales a delta
side by |c|^2 = 1.5^2 + (sqrt3/2)^2 = 3 exactly, because a delta winding sees
line-to-line voltage. `leakOhms` refers the RAW's per-unit leakage to winding 1
on a wye (line-to-neutral) base, so handing that value to a block with a delta
PRIMARY makes the unit a third of its real impedance. `ANG1` cannot say which
winding is the delta. `VECGRP` can, and it is populated across the PSS/E example
corpus, so it is now parsed (`_vecWindings` splits `YNd1` / `Dyn11` /
`YN0yn0d1` / `YNa0d11` into one entry per winding; an autotransformer's `a` is a
wye). A delta named on winding 1 gets `Dy` plus a 3x leakage rebasing; anything
else gets `Yd`, which needs no rebasing because the block's own turns ratio
already cancels the factor on the far side. With no usable label, the delta is
assumed to be on winding 2: the common configuration, and the one that needs no
correction.

**VECGRP does NOT decide the phase shift.** It is an informational label and
routinely disagrees with the model: every delta-wye GSU in PSS/E's own
`sample.raw` carries `VECGRP` `YNd1` or `Dyn1` with `ANG1` = 0, and all seven
delta units in `ieee_gic_test_case.raw` do too, because a positive-sequence load
flow does not need the 30 deg. `ANG` is what PSS/E actually solves with, so it
stays the sole authority on the shift; honoring the label instead would rotate
half of a real case away from its own solved answer for nothing. A record that
names a delta while carrying ANG = 0 imports as `Yy0` and is counted into one
aggregated warning, since for an EMT tool the dropped connection is worth
saying out loud even when the load flow does not care.

**The sign was inverted, and the two-winding and three-winding paths looked like
they disagreed.** PSS/E models each winding against a common reference (the star
point of a 3-winding unit), so angle(Vk) = angle(ref) + ANGk and the shift ACROSS
the unit onto winding k is ANGk - ANG1. For a two-winding record that is -ANG1
(the winding-2 line carries no ANG field at all); for a tertiary with ANG1 = 0 it
is +ANG3. Read off "whichever ANG is nonzero" those look like opposite
conventions, which is how the two-winding path came to be flipped while the
three-winding path was right. Both now share one helper. Block side, clock 1 is
a 30 deg lag on the far winding and clock 11 a lead.

Result: `ieee_harmonics_14bus` now reproduces its source case EXACTLY, all 16
buses in magnitude and angle to the five decimals the RAW carries (worst |dV|
0.0175 -> 0.000005 pu, worst |dAng| 60 -> 0.0001 deg). The ~0.001 pu spread that
had been sitting on the other 14 buses was this same error feeding back through
the network, not a separate approximation. `iec60909_hv_network`, `ieee_25bus`,
`savnw_nb` and `sample` are bit-identical: only records with |shift| near 30 deg
change, and those cases have none.

Guarded in three places, because a sign convention silently flips back: the new
`tests/fixtures/psse_vecgrp.raw` (four identical radial units differing only in
VECGRP/ANG1, asserted in `api/test_api.js` down to the two delta units dropping
the SAME voltage, which is only true if the 3x rebasing happened), the vendor
magnitude AND angle spot checks now in `smoke_test.js`, and the fixture's
missing `@!` header, which keeps the positional VECGRP fallback honest.

Not fixed, and logged in IDEAS.md: `xfmr3`'s magnetizing `Lm` is per-winding in
the EMT companion but node-basis in the power-flow stamp, so a delta-primary
unit with Lm > 0 is inconsistent between the two. No case in the corpus combines
the two, so no speculative scaling was added.

## 2026-07-24: HVDC links imported as scheduled real-power injections

PSS/E's `TWO-TERMINAL DC`, `VSC DC LINE` and `MULTI-TERMINAL DC` records were
counted and warned about but never read. That left the `sample*` family (six of
the nineteen vendor RAW files in the development corpus) with no solution to
find rather than a solution that was hard to reach: `sample.raw` moves 3942 MW
through DC links, so with them dropped bus 301 sat as an island of one with 2990
MW of generation feeding nothing, and buses 401 and 402 the same at 321 MW each.

Each converter TERMINAL is now a scheduled real power at its AC bus, mapped onto
the existing `pq` block: a rectifier is a load of P MW, an inverter a source of
P MW. The DC side is not modeled at all, and neither is converter reactive
consumption, converter loss or DC line loss. This is deliberately not a converter
model: it is the one thing a DC link IS to the AC network in a positive-sequence
case, and it needs no new numerical method or component model (so no IP screening
step, per the standing rule).

Three rules beyond "copy SETVL across", all confirmed against the vendor cases
rather than assumed:

* SETVL is MW when MDC = 1 and DC amps when MDC = 2 (times VSCHD, the scheduled
  DC kV). A blocked link (MDC = 0) injects nothing rather than its stale
  setpoint.
* An end that regulates DC VOLTAGE has no schedule of its own: it is the DC
  network's slack and takes exactly minus the sum of the scheduled ends, DC
  losses ignored. That is VSC TYPE = 1, and the multi-terminal converter whose
  AC bus is named by VCONV.
* Positive means rectifier (drawn FROM the AC bus).

The confirmation is sharp because three of `sample.raw`'s islands contain
nothing but generation and converters, so their generators cannot hide an error
in a network. They now dispatch 996.883 / 996.883 / 996.883 MW at bus 301 and
321.000 MW at each of 401 and 402, against the RAW's own solved 996.884 and
321.000: the DC setpoints and the machine dispatch agree to 0.001 MW. A wrong
sign or a mis-assigned DC slack would be off by hundreds of MW there.

No DC line resistance is applied at either end. On `TWO_TERM_DC1` the RDC of
7.85 ohm would be about 63 MW, and adding it at the rectifier would break the
2990.65 MW agreement above, so PSS/E is evidently metering the schedule where
this model puts it. Both ends carry the same P and the loss is simply absent.

Result: all six `sample*` variants converge, which none of them ever had.
Every other case in the corpus is bit-identical, magnitude and angle.

What this does NOT fix, and is not claimed to: `sample.raw`'s 40-bus AC island
converges but still sits 0.15 to 0.20 pu and 20 to 30 degrees off the vendor
solution. That residue is LCC converter reactive consumption (not modeled here,
while the filter banks that offset it ARE imported as fixed shunts), the 350 MW
series FACTS device, and three-winding transformers with a single winding out of
service being dropped whole. Those are separate items in IDEAS.md.

## 2026-07-24: Newton retries from a flat start before falling back to Gauss-Seidel

The power flow warm-starts with six unaccelerated Gauss-Seidel sweeps and then
runs Newton. That warm start is usually a help, but on a network with SERIES
CAPACITORS it can land Newton in a basin it cannot climb out of inside its
iteration budget. A RAW branch with X < 0 imports as a negative L on the line
block, which is right for the power flow (Z = R + jwL with wL < 0 is exactly a
series capacitor), and PSS/E's `sample.raw` has three of them arranged as a
reactor and a capacitor in series through a midpoint bus, whose two large and
nearly cancelling admittances leave a small diagonal. That is precisely what
unaccelerated Gauss-Seidel handles worst.

Measured: `sample.raw` diverges from the six-sweep warm start and converges in
21 Newton iterations from flat. Zero sweeps, two sweeps and twelve sweeps all
converge; six does not. So the warm start is not wrong, it is just not always
right, and the number is not tunable to a safe value.

Fix: when Newton fails, restore the declared bus types, throw the warm start
away, and run Newton once more from a flat start before falling back to
Gauss-Seidel. This can only ever execute AFTER a failure, so no case that
already converged changes behavior, which the corpus diff confirms. The
alternative (changing or removing the default warm start) would have touched
every case to fix six.

A minimal fixture for this was attempted and abandoned: whether six sweeps land
badly depends on the whole network, and a small hand-built series-capacitor case
converges from either start. The guard is the vendor corpus, run by hand, plus
both suites staying green.

## 2026-07-25: Spain_Blackout study paused to add transmission-scale features

A conceptual demo of the 28 April 2025 Iberia overvoltage cascade was
attempted in `studies/Spain_Blackout/` (7-bus then 3-bus). The research
(`references.md`) and design (`design.md`) are done and stand on their own;
the runnable circuit is not, and the decision is to pause the build and add
OpenEMT features rather than keep tuning.

The mechanism needs a weak bus (the southwest solar pocket) where losing
inverter Mvar-absorption plus line unloading raises voltage; and every active
source model OpenEMT has is unstable on a weak bus. This is not a parameter
problem: it was confirmed by isolation across roughly fifteen variants
(GFL with fixed-PF Mvar; GFL unity PF plus a passive shunt L; GFL unity PF
alone; small under-excited syncgen; unity syncgen; with AVR; with a softer
src; fewer machines; shorter line). The full log is in
`studies/Spain_Blackout/DIAGNOSTICS.md`.

The blockers, in unblocking order, were promoted from `IDEAS.md` to the SPEC
section 5 roadmap on 2026-07-25 as committed items 32 to 35: initialize
passive-element histories from the power flow (kills the inrush that knocks
machines loose; the single biggest unblocker); a transmission-grade inverter
model with per-plant-rated gains, a transformer-leakage output reactance, a
PLL, and a current limiter; a latched overvoltage/overfrequency
generation-trip block so the cascade can self-drive; and a documented
weak-bus operating envelope for `syncgen`. Each is a new numerical method or
component model, so each needs an IP screening (`legal/BUSINESS_DECISIONS.md`)
and a SPEC section 2 derivation before implementation.

The frequency-collapse cascade (generation loss, frequency drop, LFDD,
islanding, blackout) at a strong realistic 400 kV scale is achievable with
the current tool and remains an option for a working demo before the features
land; it was not chosen here because the user opted to enhance the tool
first. The `studies/Spain_Blackout/` artifacts (references, design,
diagnostics, builders) are kept so the study resumes cleanly once the
features are in.

## 2026-07-25: passive-history initialization from the power flow (SPEC §5 item 32)

Machine initialization (item 10) started the MACHINES at the operating point but
left every passive history at zero, so a run still opened by energizing a dead
network. On a multi-bus case with long lines that inrush is a torque impulse,
and it is what knocked syncgens loose in the Spain_Blackout study. Each element
now seeds its own trapezoidal registers from the power flow. Derivation in
SPEC §2 "Passive-history initialization from the power flow"; three choices in
it are worth restating because each one was a way to get this subtly wrong.

**The registers hold t = −Δt, not t = 0.** Step k=0 solves at t=0 and reads its
history from the step before, so every seeded quantity is evaluated at −Δt.
Seeding the t=0 values instead injects a one-step error that rings for the same
reason the cold start does. Silent if you get it wrong: the result still looks
initialized and still has a transient.

**Each element derives its current from its own admittance, not from a PF branch
flow.** The seed has to be consistent with the DISCRETIZED element, and an
element's EMT model is not always the same object as its Ybus stamp (`rlc` with
a `-1` sentinel, a saturable core on its linear segment, a breaker's state). PF
node voltages in, element admittance at ω applied locally, so any residual
appears as a small mismatch instead of a wrong history.

**Continuous-time phasors, not the trapezoidally warped ones.** The exact
discrete admittance would be s → j(2/Δt)·tan(ωΔt/2); using jω instead costs
(ωΔt)²/12 per reactive element, 2e-5 at 50 µs / 50 Hz. Correcting it would mean
seeding against a frequency the PF the node voltages came from does not use,
trading 20 ppm for an inconsistency. Documented, not corrected.

Two things had to be fixed with it, both pre-existing and both found by this
work rather than looked for:

**Source polarity against the power flow.** Source blocks inject with terminal 0
as the + node, but `solvePowerFlow`'s `genBus` takes terminal 1 as the network
bus whenever it isn't grounded, which is the normal wiring. So the EMT solution
came out 180° from the power flow it was initialized from. That was invisible
while only machines were initialized (one global sign flip is not observable in
a swing equation, and every source in a circuit flips together) and fatal for a
passive seed, which would have been exactly anti-phase with the sources driving
it. Under PF init the EMF is now driven at the polarity that reproduces the PF,
so EMT waveforms agree with the bus angles the PF reports. Gated on `pfInit`, so
every cold start is bit-identical. The underlying terminal convention is left
alone deliberately: fixing it unconditionally would flip the sign of every
existing cold-start result for a cosmetic gain.

**`src` was the one source block PF init never reached.** It is a Thevenin
source (drives Vrms behind Rs), while the PF pins its bus AT Vset, so its EMT
terminal sat below the PF solution (3.9% on the test case) and, at a non-slack
bus, at the wrong angle entirely. `pfResult` already back-computed its Thevenin
EMF — `gens` includes `src` — so this was using a value that was being thrown
away, not computing a new one.

**`syncgen`'s Qf was initialized in kvar into a VAr state**, so the droop-AVR law
started 1000x off in its Q term and E walked for the first ~Tf. `gfm` already
stored VAr. Too small to see against a cold start's own inrush; once the passive
histories were seeded it was 99% of what was left (0.194% → 0.0013% first-cycle
deviation). Item 32 is the reason it surfaced at all.

**Measured** on the new 3-bus fixture in smoke_test.js (long lines, line-charging
caps, H = 0.6 s machine), first cycle against the PF's own phasors: machines-only
init deviates 49.5% and overshoots 12.4%, seeded deviates 0.004% with no
overshoot; machine frequency swing 525 mHz → 1 mHz. The machine's own stator
branch is seeded too, for the same reason lines are.

**Not seeded, and why** (each falls back to the cold start per element, so a
partially seedable circuit still gets the benefit everywhere else): DC nodes
(the PF is AC positive-sequence and does not solve them), de-energized buses
(already 0), single-phase laterals (the PF refuses tap circuits), and
`tline`/`fdline`, whose histories are travel buffers spanning τ rather than
single registers and need their own derivation. Still to seed, tracked as the
remainder of item 32: `pline`, `cline`, `xfmr3`, `xfmr3w`, `xfmrsat`, the `gfm`
stator branch, and the one-cycle measurement windows in `pq`/`zip`/`im`/`svc`/
`wt4`/`hvdc`/`relay`/`vsw`.

**The fixture SPEC named for this item does not work.** `studies/Spain_Blackout/
spain_blackout_3bus.json` diverges on the FIRST solver step (bus voltages to
1e140) cold, machine-initialized, and seeded alike, with EMT bus voltages 25x
off the PF solution before any transient — the case is broken in a way that has
nothing to do with inrush, so it cannot validate this. A purpose-built 3-bus
fixture was written instead. Repairing the study case stays with the study.

## 2026-07-25: item 32, second pass — seeding is all-or-nothing; two more bugs

Adding the non-two-terminal families (`cline`, `xfmr3`, `xfmr3w`, `xfmrsat`)
turned up a design error in the first pass and two more pre-existing bugs. All
three were found by writing the fixture BEFORE the hook and checking that the
un-seeded residual was large, which is now the required order for the rest of
item 32.

**Partial seeding is worse than no seeding, so the pass is now all-or-nothing.**
The first pass seeded per element and let anything without a hook start cold,
on the assumption that a partly seeded network is partly better. It is not. Two
series branches sharing a node, one preloaded with its steady-state history
current and the other holding zero, cannot both be satisfied at t=0 and the node
voltage spikes to whatever reconciles them: on a coupled-line case, 6%
first-cycle deviation with nothing seeded, 195% with the load seeded and the
line not. The elements carrying trapezoidal history are now checked before
anything is written (`SEED_REQUIRED`, plus `SEED_SOURCES` for blocks that drive
the network), and one un-seedable element cancels the whole pass. Shunt
current-source interfaces (`pq`, `zip`, `im`, `svc`, `wt4`, `hvdc`) stay outside
the set deliberately: they inject a commanded current, not a history current, so
starting at zero understates a load for a cycle instead of fighting a series
partner, and the error is bounded by the source impedance rather than a spike.

**The power flow stamped a delta-primary magnetizing branch line-to-neutral.**
`buildYbus` scales an `xfmr3`'s LEAKAGE branch by the connection factor
m1 = |c1|² (3 for a delta side) but stamped the magnetizing shunt without it, so
a delta-primary transformer's magnetizing draw was understated threefold and the
PF returned a solution the EMT run would not hold. Invisible before: it read as
a small steady-state discrepancy. With seeding it was 323% first-cycle
deviation, because the magnetizing history was preloaded from a phasor the
network could not sustain. Wye primaries have m1 = 1 and are unchanged.

**A saturable core past its knee is not seedable at all.** `buildYbus` models
the magnetizing branch as the linear `Lm`, so for a steady state above the knee
the PF's bus voltages are not the ones the core would hold, and preloading the
saturated magnetizing current against them is much worse than cold (2485% vs
41%). This is a model mismatch, not a tolerance, so `xfmrsat` declines through a
new `seedVeto` hook and the all-or-nothing rule hands the circuit its ordinary
cold start. A core seeded BELOW its knee — the normal design case, saturating
only on a disturbance — seeds exactly (0.000%).

**Measured**, first cycle against the PF's own phasors, machines-only vs seeded:
`cline` 6.06% → 0.0001%, `xfmr3` Dy11 with Lm 1.55% → 0.0001%, `xfmr3` Yy0 with
neutral grounding 0.53% → 0.0000%, `xfmr3w` Yy0d1 3.71% → 0.0000%, `xfmrsat`
linear 1.08% → 0.0000%. All eight vector-group × Lm combinations land at
0.000%. Cold-start output stays byte-identical to the previous commit across
every shipped example (SHA-256 over all recorded samples).

## 2026-07-25: item 32 closed — im passive-history seeding (the last family member)

`im` was the only element left in item 32 and the only measurement-window
family member that also carries genuine electromechanical state (rotor EMF
`Ed`/`Eq` and slip), so its seed is the induction-motor steady-state torque
balance, not a buffer prefill. The seed solves the third-order ODE
`makeIMs` integrates for its exact steady state (bisect the small stable
motoring root of `Pe(s) = PL0*(1-s)^kexp` in the transient-reactance model,
then seed `Ed`/`Eq`/`nu`/`s` from the steady-state relations) and pre-fills
the one-cycle voltage boxcar by the wt4 rule. `icmd` stays cold, like
`svc`/`wt4`/`hvdc`: `im` is absent from `buildYbus` and the PF load
bookkeeping, so the PF bus models no motor load and seeding `icmd` would
recreate the partially-seeded-series-pair spike. Fixture (stiff source
directly into the motor — no series line, since `im` has no LPF on its
injected current and a series L against a stiff bus self-sustains a
trapezoidal Nyquist ring): DOL inrush 3.9% first-cycle bus deviation
unseeded, 0.36% seeded (11x, no overshoot), scaling linearly with source
resistance as the bounded-by-source-impedance design predicts. The
per-family commits carry the detailed reasoning; this entry is the short
version. Item 32 is DONE; item 10's "passive-history initialization for a
fully flat start" is closed. `tline`/`fdline` remain a separate, future
derivation (travel buffers spanning τ, not single registers).

## 2026-07-25: transmission-grade GFL solar inverter (`gfl`, SPEC §5 item 33)

The Spain_Blackout study found every active source model OpenEMT had was
unstable on a weak bus; `gfm`'s GFL mode diverges at transmission scale because
its small signal-filter Lf plus line charging C resonates above the solver
Nyquist and its kW-scale gains flip the voltage on MW/Mvar swings. The new
`gfl` block is the SPEC item 33 current-source primitive.

Three choices worth restating, each a way to get this subtly wrong:

**A Norton current source, not a voltage-behind-impedance branch.** The block
stamps NO series filter branch (it is absent from buildYbus's EMT stamps, like
`wt4`): the cure for the Lf-C resonance is the absence of the series L, not a
larger L. The SPEC's "output reactance sized as a transformer leakage rather
than a small signal-filter L" is honored by reflecting `Xt` into the current-
limiting algebra (the optional Emax converter-voltage ceiling E_int = V + I·jXt)
and the power-flow internal-EMF back-computation, not by a real branch. A real
series L behind an ideal current source is physically redundant: the current
source dominates the grid current, so the L is moot for the grid and would
only add a passive L-C mode. This is the "lower-effort alternative form" the
SPEC explicitly accepts, extended with a real SRF-PLL and per-plant rating.

**The PLL locks to the BRANCH-voltage angle, not the bus angle.** vbr =
v(term0) − v(term1) is −v(bus) under the standard term0-grounded wiring (like
`gfm`/`wt4`), so arg(vbr) sits π off the bus angle. Seeding the PLL to the bus
angle (pfInit.ang) puts it at its δ = π unstable point and it diverges; the
seed uses arg(vbr) instead, which is wiring-agnostic (it tracks whichever
terminal is the bus). The cold-start path converges there from θ = 0 anyway,
which is why cold start worked but power-flow init did not until this was
fixed. Anti-windup (integrate only inside |δ| < π/2, clamp ω to ±30% of ω0)
was added after the one-cycle boxcar's lag through a fault transient wound the
integrator to ~1200 Hz; with it the PLL rides through a 0.63 pu fault and a
0.05 pu held bolted fault and re-locks.

**Seed the commanded current (unlike `wt4`).** `wt4` is absent from buildYbus
and must stay cold (seeding its current spikes against branches seeded for
zero). `gfl` IS in buildYbus as a PV/PQ gen bus, so the PF solved the network
WITH its P injection and the surrounding branches are seeded for that current;
seeding `gfl`'s commanded current to the dispatched P/Q is consistent. It
seeds in the independent loop (not SEED_REQUIRED/SEED_SOURCES), so a `gfl`
issue never vetoes the all-or-nothing pass. The seed derives (Irf, Iif) from
the seeded boxcar with the SAME formula `update` uses, so there is no one-step
sign-flip transient at t = 0.

Per-unit interface (Sbase, Vrated, Imax/Vfloor/Emax in pu) so the same
defaults hold from 4 kV to 400 kV. `gfl` joins FLOW_REVERSED; raw v·i is
positive-delivering (mirrors `wt4`). 3-ph only. Engineering derivation in
SPEC §2; IP screening in the business log (SRF-PLL Chung 2000, classical
phasor injection, voltage-reduction current limiting, all clear).

## 2026-07-25: latching generation-trip relay (`gtrip`, SPEC §5 item 34): math derived

Derivation only this session; implementation handed to the local model per
SPEC §6 (the rule of thumb: write the physics as a §2-style derivation BEFORE
asking the local model to implement it). Full math, params, solver wiring,
seeding and validation targets are in SPEC §2 "Latching generation-trip relay".
The choices worth recording:

**A third member of the control family, not a variant of `vsw`.** `vsw`
recloses by design and `relay` decides on current only, so neither can express
"a generator trips on a voltage or frequency excursion and stays tripped".
`gtrip` reuses `vsw`'s one-terminal sensor shape (no stamp, no inject, no
history, so it can never perturb what it measures) and `relay`'s brkId link and
trip action, and inverts `vsw`'s reclose: it never touches tc/opened/armed. The
latch is the point of the block, so it holds for the whole run (a real latching
relay needs a manual reset, and a run has none).

**Frequency is read off the PLL INTEGRATOR STATE, not the VCO output.** The
81 elements need a bus frequency and nothing measured one at a node before
(`syncgen` reports rotor speed, `gfl` its own PLL, both internal to a source).
Reusing `gfl`'s SRF-PLL is obvious; taking ω_vco = ω0 + Kp·δ + Ki·∫δ as the
measurement would have been wrong. Kp·δ is the phase-correction path and spikes
on any angle step (a fault, a pole clearing, or just the one-cycle boxcar
lagging a transient), which is correct for placing θ and useless as a grid
reading. In lock δ → 0 and the integrator alone carries the whole off-nominal
offset, so ω_meas = ω0 + Ki·∫δ agrees with ω_vco in steady state and stays
smooth through the transient. Consequences that fell out for free: ∫δ = 0 at
t = 0 makes f = f0 exactly at start, so a cold start cannot false-pick an 81
element, and the PLL's own second-order response is the only filter needed (an
extra low-pass would add an unmodelled third pole under a delay-based element).
Because the STATE is now the output, the anti-windup clamp moves onto the state
(|Ki·∫δ| ≤ 0.3·ω0) instead of clamping only the summed correction as `gfl` does.

**One-terminal means no vbr/π reasoning.** `gfl` locks to the branch voltage,
which sits π off the bus angle under term0-grounded wiring, and its seed is
written around that. `gtrip` correlates the node voltage directly: no sign
flip, no offset. Called out explicitly in the derivation because the obvious
implementation route is to copy `gfl` and carry that reasoning across wrongly.

**One voltage quantity, two consumers.** The `vsw` Σv²/nEff boxcar and the PLL
correlator magnitude have the same scaling (both are per-phase rms for a
balanced set), so Vrms drives 59/27 AND supervises the 81 elements, and no
second magnitude state exists. Σv² is also the only form that works on a
lateral, which is what keeps the voltage elements lateral-capable while the
frequency elements are 3-phase only.

**Guards chosen over user discipline.** A lock detector (|δ| < 0.02 rad held
one cycle) holds the 81 timers at zero during pull-in, and Vblk supervision
(the classical 27-block-81) freezes the PLL and blocks the 81 elements on a
collapsed bus. Both could have been left to "set Tdf long enough"; they are in
the model instead because a frequency read off a faulted bus is not a slow
measurement, it is a meaningless one.

**Four timers, not one, and an asymmetric reset.** Each element owns its dwell
timer so one element's dropout cannot reset another's accumulation. The timer
keeps running between the dropout value and the pickup value, and that band IS
the hysteresis: it stops measurement ripple on a quantity parked at the
threshold from resetting the timer forever. Since the trip latches, the
hysteresis affects only the timer, never the trip, which is the whole reason a
latched element still needs one. hysV is fractional and hysF absolute in Hz
because one shared number cannot serve both (2% of 60 Hz is 1.2 Hz, wider than
the entire range an 81 pickup lives in).

**Deliberately out of scope for item 34:** no ROCOF/81R element, no inverse-time
frequency curve, no directional or sequence supervision, four elements sharing
two delays rather than four. Stated in the derivation so the implementation
does not invent them.

The cascade validation is the item's real deliverable: two `syncgen`s sharing a
load, A trips, B's droop settles it below its own Fuv and B trips. The swing is
second order so the crossing instant is not closed-form; the assertion that
matters is that the SAME case with A's trip removed never trips B, i.e. the
second trip is solver-driven rather than scripted. IP screening is in the
business log (definite-time 59/27/81 protection and SRF-PLL, both already
inside the cleared baseline).

## 2026-07-26: `gtrip` implemented and item 34 closed; three fixes to the first pass

The block was implemented from the 2026-07-25 derivation by the local model
(SPEC §6 division of labor). It came back with the physics substantially right
and the validation substantially wrong, which is a useful data point about
where that boundary actually sits: the derivation transferred, the test DESIGN
did not.

**Three corrections to the implementation.**

1. *The hysteresis band froze the dwell timer instead of running it.* The first
   pass incremented the timer above pickup and reset it below dropout, leaving
   the band between them as a no-op, so a quantity sitting in the band held its
   timer frozen forever and a definite-time trip that should have occurred
   never did. Pickup is a LATCH: once picked up the element stays picked up
   until the quantity passes dropout, and the timer runs the whole time. Fixed
   by giving each element an explicit `pu` latch. The four near-duplicate
   element blocks collapsed into one `els` array plus a single loop while
   fixing it, which is why the trip action now appears once instead of four times.
2. *The Vblk freeze was half a freeze.* The integrator was held below the block
   voltage but the VCO was still recomputed from the (meaningless) correlator
   angle, so θ was driven by noise on a collapsed bus and re-lock after
   recovery was delayed. `gfl` skips the entire loop update below its floor;
   `gtrip` now does the same.
3. *`(+p.hysV || 2)` swallowed a deliberate 0.* A user asking for no hysteresis
   silently got 2%. Replaced with an isFinite test. Same for hysF.

**The validation was rewritten, not repaired.** Five of the seven original
targets asserted on `r.aux[...] >= 1` as though the aux signal were a 0/1 trip
flag. It is the measured frequency in Hz, so that predicate is true at every
sample: three targets passed vacuously and two could never pass. The idiom was
copied from the `vsw` test, where the aux genuinely IS a bank state. Trip
detection now always goes through the target breaker's current falling to zero
and staying there, which also folds the latch into every assertion for free.
Recorded here because the same trap is waiting for any future block whose aux
is a continuous quantity rather than a state flag.

**The hysteresis target is a real regression test, not a description.** It runs
one circuit and one dip twice, changing only the dropout band, and the pre-fix
frozen-timer code was confirmed to fail the wide-band case (no trip) where the
fixed code trips at 309.2 ms. A test that cannot fail the bug it describes is
the thing this session spent its time undoing.

**Vblk's justification in the derivation was overstated, and the SPEC now says
so.** The derivation claimed a bolted fault would otherwise read as a frequency
excursion and trip generation. Measured, a held 3-phase fault moves the
reported frequency by at most ~0.1 Hz, because the integrator-state readout
(the derivation's own central choice) already rejects the transient the VCO
output would have carried. Vblk is therefore defense in depth, and its real,
testable job is holding the 81 dwell timers while the bus is down. Correcting
the claim rather than quietly keeping a guard with a wrong rationale attached.

Also: `api/test_api.js` asserts an exact block-type count, which a new block
necessarily breaks. Updated 34 to 35. Worth knowing that adding any block
requires that edit.

## 2026-07-26: item 35 closed as a documented note; the slip was fixed by item 10, not item 32

Item 35 asked for the minimum interconnection stiffness a `syncgen` needs to
start and stay locked, and offered two outcomes: a documented note if item 32
alone had fixed the slip, or a model-robustness task if not. It closes as a
note, but the item's own premise was wrong twice, and the corrections are the
substance here.

**The premise said the machine "slips on a weak bus under inrush even with PF
init". It does not.** Measured on a machine tied to an infinite bus through a
Thevenin reactance (SCR = 3·Vph²/(Xth·Sbase), bisecting the largest dispatch
that starts AND holds), a power-flow-started machine holds at least 1.09 pu at
every SCR down to 1.0, and 2.81 pu at SCR 3. That is above the machine's own
rating everywhere tested, so at any realistic dispatch the PF start is simply
not the binding constraint. Only a COLD start has an envelope worth writing
down: at 1.0 pu it slips below SCR ≈ 1.72, with a ceiling of 1.91 pu at SCR 6
falling to 0.70 pu at SCR 1.0. That is the documented envelope.

**The fix was item 10, not item 32.** This is the correction with consequences,
because item 35 was written assuming passive-history seeding was the candidate
remedy. Separating the three starts (cold / machine-init-only / fully seeded,
the middle produced by deleting the `pfV` phasors the seeder reads, the same
trick the item 32 acceptance test uses) shows machine-init-only already
reaching 1.09 to 3.99 pu, matching the fully-seeded case to within
near-boundary noise. In hindsight this is obvious and should have been reasoned
before measuring: a pole slip is an ELECTROMECHANICAL event governed by the
rotor's starting angle, and item 10 is exactly what supplies that angle. Item
32 seeds the ELECTRICAL histories, which changes the first cycles of inrush and
has no purchase on where the rotor starts. Recording it because the roadmap
item encoded the wrong causal story for a year of sessions, and because it is a
reminder that "the newest initializer probably fixed it" is a hypothesis, not a
finding.

**Two non-levers, measured so nobody re-tries them.** Halving inertia (H = 4 to
2 s) moves the cold ceiling by under 5%, and in the direction people do not
expect (slightly HIGHER, since the faster swing settles inside the run window).
Adding 2 µF of line charging changes the numbers to 2 decimal places not at
all, which kills the "it was the transmission-scale charging capacitance"
hypothesis carried over from the Spain_Blackout study.

**The original observation is still correct in its own context.** The
2026-07-15 entry that started this described a plant bolted cold onto a weak
bus at a time when the tool had no power-flow initializer at all, and named
that absence as the root cause. It was right. Items 10 and 32 both landed
since, and the guidance in that entry (attach a new machine at a stiff bus, or
replace an incumbent) is now superseded by the simpler one: use "Init from PF".

Guarded from both sides in smoke_test.js (cold holds at SCR 3.0, cold slips at
SCR 1.2, PF init holds at SCR 1.2) rather than only asserting the good case, so
a regression that silently made cold starts fail everywhere, or that broke the
PF remedy, both fail the suite. Envelope documented in SPEC §7.

## 2026-07-26 — `pq`/`zip` power is a three-phase total; the EMT model was per-phase

Found while resuming the Spain_Blackout study, which needs a power-flow start on
a multi-bus case whose load is mostly constant-power. `pq` and `zip` injected
their full `P`/`Q` into EVERY phase (per-phase semantics) while
`solvePowerFlow()`, a three-phase-total solve throughout (`Ii = conj(Snet/(3·V))`),
read the same parameter at face value. The two solvers therefore disagreed by
exactly 3x about how large every constant-power load in the tool was.

**Chosen convention: three-phase totals, everywhere, for every power parameter.**
The alternative (make the power flow and the PSS/E importer per-phase, matching
the old EMT model) was rejected. It would have kept a permanent asymmetry in
which `pq.P` was per-phase while `syncgen.Pm0`, `gfl.P0`, `hvdc.Pset` and every
`Sbase` were three-phase totals — an unlabelled 3x trap sitting between two
blocks a user wires together in the same circuit, which is precisely the trap
that had just cost this project two sessions of the Spain study. Making the
loads match the machines removes the asymmetry instead of relocating it, and it
is also what the PSS/E importer and RAW files already assume, so imported cases
became correct with no importer change. Each block now divides by `nphB`, so
1-ph circuits and single-phase laterals are numerically untouched: only 3-phase
loads move.

**Why it survived this long, which is the part worth remembering.** Every load
test measured ONE phase against a per-phase expectation, so it passed under
either convention; every power-flow test used constant-impedance `rlc` loads,
which stamp as admittance and are immune. No test ever solved the same circuit
both ways. The suite was green at 122 checks with a 3x error in it. The witness
that settles the question is external and not ours to argue with:
`examples/ieee9bus.json` is a benchmark with a published answer, and its power
flow returned a slack of −133.11 MW against the published +71.6 MW. It is now
+72.44 MW. Lesson recorded as a new guard: solve one circuit both ways and
compare the bus voltage (0.6% now, 20.0% on the pre-fix code).

**Fallout accepted deliberately.** Any circuit saved before today has `pq`/`zip`
values that now mean three times what they did. No automatic migration was
added, and this is a judgement call rather than laziness: pre-fix files are not
self-describing — hand-built ones (`ieee9bus.json`) carry per-phase values while
importer-written ones (`ieee_harmonics_14bus.json`) carry three-phase totals,
and nothing in the file distinguishes them, so a blanket rescale on load would
silently corrupt exactly the imported cases that were already right. The two
tracked files written under the old convention were rescaled in place so their
physics is unchanged (`ieee9bus.json` now stores the benchmark's own 125/90/100
MW rather than a third of each; `pq_piline.json` 24 kW rather than 8).

**Suspected retroactive explanation for the Spain study.** Its
`DIAGNOSTICS.md` attributed repeated "power flow converges, time-domain run
blows up" failures to weak-bus instability of every active source model. Those
cases were all PF-initialized with large `zip` loads, so the power flow was
solving a network carrying a third of the load the EMT run then drew, and the
run started from an operating point the network does not hold. That is a
simpler explanation than the one recorded there and should be tested before any
more modelling effort is spent on the weak-bus theory.

## 2026-07-27 — power-flow convergence: three defects in the acceptance test

Found while restarting the Spain Blackout study, which had been blocked for
three days on what looked like a modeling problem and was not.

**Newton's tolerance was below its own noise floor.** `nrPowerFlow` accepted on
`mis < opt.nrTol || 1e-10` (pu on the internal 100 MVA base, so 10 mW across
the whole network). The residual has a floor: the injection sum for a bus
accumulates terms of size Vm_i·Vm_k·|Ypu_ik|, so its rounding error is roughly
eps times that row's sum, and `buildYbus` stamps a closed breaker at a fixed
1e4 S — about 1.6e7 pu at 400 kV. Measured: one closed breaker in a three-bus
400 kV case puts the floor at 1.1e-10, the old tolerance itself. Newton
therefore ran its full budget at a SOLVED point, returned failure, and the
failure path discarded the iterate, handing back the flat start. The default is
now `max(1e-10, 10·eps·max-row-sum|Ypu|)`.

Why `max` and not a flat looser number: a case with no near-short branch has a
row sum of order 1e2 and lands at ~1e-13, so `max` keeps the historical 1e-10
and every such case is bit-for-bit unchanged. Only a case that cannot reach
1e-10 gets the relaxation it needs. The safety factor of 10 is set against
measurement: the estimate is an upper bound on one row's rounding and the
observed floors run about an order of magnitude under it. The Spain case still
fails at 4.8 pu after the change, which is the right answer — that one is a
genuine fold.

**Gauss-Seidel reported on the wrong quantity.** It STOPS on a voltage step,
which is fine, that is what its iteration produces. It also REPORTED on one, so
`converged: true` meant "the last sweep did not move", not "the network
balances". On an ill-conditioned matrix those come apart: the Spain case
returned converged after 20 sweeps with the synchronous fleet at 8635 MW
against a 15000 MW setpoint. A silent wrong answer is worse than the reported
failure Newton was giving on the same case. GS is now scored on the same power
mismatch Newton uses, so `unit` is 'pu' for both methods and the two numbers
are finally the same quantity. Iteration behaviour is untouched; only the
verdict changed.

**The NR-to-GS fallback restored the wrong bus types.** It put back `busType0`,
a snapshot taken after the zero-width-band PV-to-PQ conversion had already run,
so declared generator buses came back as PQ — and Gauss-Seidel reads load only
at a PQ bus, dropping those machines from the network. The comment above the
line already said this was the exact thing to avoid. Measured before the fix:
method 'gs' and method 'auto' put the same inverter at +2542 MW and -1458 MW on
identical voltages. Restores `busTypeDecl` now.

**Non-convergence names the bus.** Both solvers already compute the per-bus
residual, so they now track the argmax alongside the max and report "Worst
residual: P at bus X, off by N MW". This is not cosmetic: three days of the
study went into bisecting a failure by deleting blocks one at a time, and the
first run with this line pointed at the right bus immediately.

Two wrong theories were held for those three days and are worth recording so
they are not re-derived. Neither `gfl` nor the closed-breaker conductance had
anything to do with it. The `gfl` suspicion came from a bisection confounded by
the operating point — its baseline load sat past the corridor's own transfer
limit (P_max ≈ V²/2X), so adding a plant "fixed" convergence by moving net load
back under the nose — and since a plant arrives through a breaker, "add a
plant" also meant "add a breaker", which produced the second theory. Replacing
every breaker with an equivalent line and walking it from 1e4 S to 1 S changes
nothing: the failure is identical at every conductance. The lesson is the one
the new diagnostic encodes: check WHICH equation fails before theorising about
why.

## 2026-07-27 (later) — `zip`'s constant-Z part is stamped, not injected

`zip` inherited pq's whole interface, including `G = 0` and a Norton injection
carrying all three parts of the polynomial. For the constant-I and constant-P
parts that is right: their currents depend on the tracked RMS, so there is no
fixed admittance to put in the matrix. The Z part is different. `az·P0/V0²` IS
a plain conductance and `bz·Q0/V0²` IS a plain susceptance, both constant and
both known at element build, and applying a fixed admittance off the PREVIOUS
step's voltage is an explicit feedback loop of gain G_z/G_node. It diverges as
soon as the load's conductance passes the node's own companion conductance.

Now: G stamped directly, B through the standard trapezoidal companion at the
block's own `f` (absorbing = inductor, injecting = capacitor, the same
companions `rlcp` uses). Both signed, so a negative P0/Q0 stamps a negative
conductance or a capacitive susceptance — the matrix needs an entry to be
constant, not passive. UVLO becomes automatic rather than a special case: a
stamped admittance is always in the matrix, which is what "the Z part rides
through" already said. Reported current is the injected I/P parts plus the
stamped branch, so the drawn-power validation still sees the whole load.

**The diagnostic that identified it, which is the transferable part.** The run
blew up after the same ~4 STEPS at every timestep from 20 µs to 1 ms. A
physical instability has a time constant in seconds and blows up at the same
ABSOLUTE time whatever the timestep; divergence in a fixed number of STEPS can
only be a numerical feedback path. That one measurement separated "the case is
unstable" from "the block is wrong" in a few minutes, after the question had
been open since 2026-07-24.

Two traps worth recording. First, a small network does NOT reproduce it: a
2-bus case is stable at every Z/I/P split and every timestep because its loop
gain is under 1. The first pass at retesting used exactly such a case and
wrongly concluded the block was fine. The smoke-test fixture therefore builds
the regime on purpose — a node fed through a large series inductance and
nothing else, G_z/G_node ≈ 140 — and reaches NaN on the old code.

Second, this is the OPPOSITE of the standing constant-power trap in CLAUDE.md.
Constant-P misbehaves at a COLD start (dividing by a tracked RMS that is still
near zero) and is cured by PF initialization. This one survived PF
initialization and was cured only by stamping. Both live in the same block, so
"the load blew up" does not by itself point at either.

## 2026-07-27 — a closed breaker is stamped as a ratio, not an absolute conductance

`buildYbus()` in the power flow stamped every closed `brk` (and every `relay`)
at a hardcoded 1e4 S. That number is an implicit assumption about voltage
level. At 400 V it is a fine approximation to an ideal short. At 400 kV, where
a transmission corridor is about 0.04 S, it makes the breaker node's
self-admittance 2.5e5 times its links, and the Jacobian is conditioned so badly
that Newton diverges on a network that has a perfectly good solution.

Found while scaling the Spain_Blackout study from 3 buses to an 11-bus
geographic reduction of Iberia. The 3-bus case had 6 breakers and survived; the
11-bus case has 22 and did not.

**The measurement that identified it.** Splice every closed breaker out of the
case by hand, wiring its two neighbours straight together, which is what node
merging a zero-impedance branch would do. The spliced network converged in 16
Newton iterations to 8.3e-14; the identical network with the breakers present
blew up to a 6.6e5 pu residual. That separates the stamp from the extra nodes,
because splicing removes both and the stamp sweep then isolates which mattered:

    stamp    result
    1e4 S    diverges, 6.6e5 pu
    1e3 S    diverges, 6.5e4 pu
    1e2 S    converges, 24 iterations, matches the spliced answer to 4 decimals
    1e1 S    converges, but 0.26% voltage error
    1e0 S    converges, 2.8% error (the breaker is no longer negligible)

So there is a wide window in which a breaker is both a good short and well
conditioned, and its position depends entirely on the network's own impedance
scale. Each short is now stamped at `min(1e4, 1e3·max(nodeY_i, nodeY_j))`,
where `nodeY` is the ordinary branch admittance already accumulated at its own
two nodes. Shorts are collected during the stamping loop and applied afterwards
so they cannot inflate the number they are scaled by.

**The measure has to be LOCAL, and the first attempt got that wrong.** Scaling
every short by the largest admittance anywhere in the network failed on the
same case: the France source's Thevenin `Rs = 1` ohm is 1 S, three orders above
any 400 kV corridor, so it set the scale for breakers whose own neighbours are
0.04 S and the bad ratio came straight back. Per-node is immune to that.

The `min` keeps the historical 1e4 wherever a node's own admittances are
already that stiff, so low-voltage cases are bit-for-bit unchanged, and a node
with no ordinary branch at all (two shorts in series) has nothing to scale
against and falls back to it.

**This is the same defect class as the Newton tolerance fixed earlier the same
day**: a constant that was correct for the scale it was written at, silently
wrong at another. Worth looking for others.

**A trap for whoever writes the regression check.** The failure does NOT
reproduce on anything easy. A radial of passive breakered feeders at 400 kV
converges in three iterations either way, and so does a ring of 25 breakers
feeding loads. What exposes it is a MESHED network whose feeders are PV
machines, because a PV bus's Jacobian row is written at the machine node,
directly behind the breaker. The smoke-test check therefore builds a 3-bus ring
at 400 kV with 6 breakered feeders, 3 of them PV syncgens, and asserts both
that the answer matches the spliced network and that the residual floor reaches
5.8e-11 — a level the unscaled stamp cannot reach (it bottoms out at 1.5e-8).
The floor is the right thing to assert because it degrades smoothly with the
ratio, whereas outright divergence needs a case near the edge of solvability.

## 2026-07-27 — `gtrip` gets an arming delay (`tarm`)

Real generator protection is blocked while the plant energizes, because a
control settling is not a grid event. A PF-initialized EMT case needs the same
thing for the same reason: `seed()` seeds the MEASUREMENT states from the power
flow but starts the CONTROL states cold, so a case with many inverters rings
before it sits down.

Measured on the 11-bus Iberian case (12 grid-following plants, 5 machines): the
start-up ring is 10 to 16% peak-to-peak and takes about a second to clear,
against relay windows half a percent wide. Armed from t = 0, four belt plants
tripped during the pre-roll, BEFORE the study's own initiating event. The run
then looked like "the cascade never fired" when in fact it had already fired
off-screen, with the plants sitting at 2 A from the first second onward. That is
a nasty failure mode because the symptom (nothing happens at Event 1) points
away from the cause.

`tarm` (ms) blocks all four elements until it passes, clearing pickup latches
and dwell timers rather than freezing them, so an excursion still in progress
when the relay arms must re-establish itself and serve its full definite time.
Default 0 keeps every existing case armed from t = 0 and unchanged.

**Two study-side traps found alongside it, both about where a threshold comes
from.** First, thresholds must be derived from the EMT's own settled state, not
from the power flow: the two differ by a few tenths of a percent, which is
nothing next to a 6% window but decisive next to a 0.5% one. Second, when
re-deriving them from a run, make sure the run being read is one where the
plants were still connected. Reading a CSV from a run in which they had already
false-tripped gave a "pre-event" voltage 5% too high and a ladder that never
picked up.

## 2026-07-27 — meshing weakens a voltage cascade, and that is the point

The v2 study put four plants on ONE pocket bus, where a single trip was worth
6.1% and the cascade completed in half a second. The v3 geographic model puts
the same plants 200 to 400 km apart on a meshed 11-bus network, and the measured
ladder changes character completely: Granada is worth only 0.55% at
Extremadura, and each relay window shrinks to well under a percent.

That is not a defect in either model. It is the reduction showing what it costs:
a 3-bus pocket overstates coupling, and the real Iberian network is meshed,
which is a large part of why the actual Events 2 and 3 came about 20 s after
Event 1 rather than in the same half second.

A second measured result, and the more interesting one: **the overvoltage
cascade self-limits.** Losing a small absorbing plant raises the belt voltage,
but losing a 1,200 to 1,800 MW exporting plant LOWERS it, because the belt then
has to import that power through the same weak corridors and the drop from
carrying it swamps the gain from removing the absorption. So bulk plants cannot
be part of an overvoltage ladder at all; they carry undervoltage and
underfrequency ride-through limits instead, which is also how they are really
protected.

## 2026-07-27 — add a distance/line-protection relay block (zrel)
Added a `zrel` block that extracts positive-sequence V and I, computes
apparent impedance Z = V/I, and trips a breaker on a mho or impedance-circle
reach. The public-domain classical distance-relay principle is old enough to
need no IP search, but the implementation deliberately excludes modern
microprocessor-specific features such as quadrilateral, adaptive, traveling-wave,
and communication-assisted schemes; those are listed as limitations in SPEC section 7.
This unblocks solver-driven line protection in transmission studies, starting
with the France-tie opening in `studies/Spain_Blackout`.

## 2026-07-27 — zrel: assert measured ohms, not just trip/no-trip
The first zrel implementation scaled the voltage correlator by √2/3 (an RMS
phasor, matching gtrip) but the current correlator by 1/3 (a half-peak
phasor), so every apparent impedance came out a factor of √2 too large. The
number looked entirely plausible (3.5 Ω read as 4.95 Ω) and the original test
could not see it: it only checked trip/no-trip, and it read the trip instant
off the aux signal, which for zrel is |Z| in ohms rather than a trip fraction,
so "first sample ≥ 1" meant "impedance exceeded 1 Ω". Its fault was also wired
to a node already tied to ground, making it electrically a no-op. Lesson kept
as a rule: a measurement block's test must pin the measured VALUE against a
hand calculation. A relay that trips at the right time for the wrong impedance
is a relay whose reach settings are silently meaningless. V and I are now
correlated in one loop with one shared scale factor, so the two paths cannot
drift apart again.

## 2026-07-27 — zrel: the correlator frame must turn while its window fills
A distance relay tripped a healthy line the instant its one-cycle boxcar
filled. Cause: θ only advanced inside the PLL update, which is gated on a full
window, so the frame stood still while the window filled. Correlating a 60 Hz
signal against a stationary frame averages to zero, so the first sample was
0/0, and a garbage Z near the origin is deep inside every mho circle (the
origin is the mho circle's own boundary point). Fixed by free-running θ at ω₀
during the fill, plus a one-window settling gate before the element may act.
Both are measurement validity, deliberately kept distinct from `tarm`, which
is the user's knob for blocking a start-up ring. gtrip has the same
fill-time structure but is immune because its frequency elements are gated on
the PLL lock detector; zrel's impedance has no equivalent natural gate.

## 2026-07-28 — an instrument's clamp must be wider than a relay's, and must say when it is on the stop
The node-frequency PLL first shipped with gtrip's tracking clamp (+/-30% of
nominal). That is correct for gtrip, which is a CONTROL loop driving a trip
decision and must not chase garbage. It is wrong for an instrument. On the
Spain_Blackout island the frequency ran off the bottom of the range, and the
clamp then reported a rock-steady 35.00 Hz (0.7 x 50) on every bus, which
reads exactly like a settled system. It is the worst failure mode an
instrument has: not noise, not an error, a plausible wrong number.

Two changes. The range is now +/-50% (25 to 75 Hz at 50 Hz), and each node
latches a `sat` flag surfaced as `probeMeta.fSat` and `query(...).saturated`,
so a trace that touched the stop can never be quoted as a measurement.

The correction this produced is not small. With the clamp removed the island
is NOT stable at 43 to 49 Hz as previously reported: it is still falling
through 30 Hz at 15 s with no sign of arresting. The old numbers were the
compound artifact of two blinded instruments — a gtrip freezes its PLL below
Vblk, so it stopped measuring exactly when the interesting part began, and the
clamp supplied a confident value for the rest. The study's voltage collapse
stalls; its frequency collapse does not.

Generalisable: when a sensor and a controller share a measurement path, the
sensor inherits limits that were chosen for the controller's safety, and those
limits are silent. Give the instrument its own range and make saturation
observable.

## 2026-07-28 — network frequency belongs on the probe, not on a relay
Machines reported frequency (syncgen rotor, gfl/gtrip PLL) but the NETWORK had
no frequency reading. To watch a bus you had to place a threshold-free `gtrip`
there purely as a sensor, which is what studies/Spain_Blackout does: a
protection block used as an instrument, carrying a brkId it must be prevented
from ever using. Every probe and every bus on a 3-ph AC node now runs the same
SRF-PLL as a pure sensor, so frequency is available wherever you can already
see voltage, which for a cascade study is every bus rather than only the ones
with a machine on them.

Deliberately absent on DC nodes and 1-ph laterals (`hasF` false, null series)
rather than reporting a flat nominal: a positive-sequence phasor needs three
phases, and a zero-crossing period measurement is a DIFFERENT method with
different noise behaviour, not the same number under a shared name.

Two traps, both already paid for elsewhere. The frame must keep turning while
the boxcar fills or the first reading is 0/0 (the zrel lesson, applied before
it could bite). And the loop must START aligned: left at theta = 0 the PI loop
pulls in from an arbitrary angle error, a real 45 to 62 Hz excursion over the
first cycles that is honest but dominates the plot's autoscale and buries the
signal. The node's own angle is one atan2 away on the first step; with that,
the same run stays inside 59.96 to 60.13 Hz and reads 60.0000 settled.

## 2026-07-28 — run settings belong in the circuit file
Loading `spain_blackout_v3.json` in the GUI showed no collapse. Nothing was
wrong with the case: Event 1 is at t = 6 s, the Duration field defaults to
120 ms, and the run therefore ended 5.9 s before anything happened, with no
hint as to why. The saved file carried blocks, wires, vconv and plots but not
the one thing needed to reproduce the result.

So the file format now carries an optional `sim` block ({duration, dtUs,
plotUs, nph, pfinit}), written by Save and restored by Load. A circuit whose
first event is seconds in is not fully described by its topology. Kept
optional and clamped to each input's own max, so files without it leave the
toolbar alone and every existing case loads exactly as before. The Duration
max also went from 20 s to 60 s, because this case's own analysis window
(21 s) did not fit in the old limit.

Generalisable: when a stored artifact needs out-of-band knowledge to be
interpreted, the artifact is incomplete, and the failure mode is silence
rather than an error.

## 2026-07-27 — a distance relay cannot open the France ties, and that is correct
Wiring `zrel` into `studies/Spain_Blackout` to replace the scripted France-tie
opening produced a negative result that is worth more than the feature was.
A correctly-set mho relay never picks up on that tie, at ANY reach from 60 to
300 ohm. The reason is structural, not a tuning miss: there is no fault on the
Pyrenees ties. The separation is a power swing, and its apparent impedance runs
along the RESISTANCE axis (measured: 0 to -25 deg, pre-event R = -167 ohm
swinging to +55 ohm), while a mho circle set at the line characteristic angle
of 84 deg has almost no resistive coverage. Reaching further does not help; it
just moves a circle the locus is not in.

Holding the ties closed then showed the study something else: the model does
not collapse at all. It rides through at 50.00 Hz with every bus back to ~1.0
pu, and the cascade stops after the southern overvoltage cluster at 1.96 s.
The France-tie opening is the single load-bearing event in the whole case.
Recorded because it is the kind of thing a scripted event hides: as long as
the event was a clock, nothing forced anyone to notice that everything
downstream depended on it.

## 2026-07-27 — out-of-step tripping is a TIME discriminator, not a reach
Added the classical double-blinder out-of-step scheme to `zrel` (`oos`, `RB1`,
`RB2`, `Tsw`), which is what actually opens a tie during a separation. The
blinder coordinate is the component of Z perpendicular to the characteristic,
u = R·sin θ − X·cos θ, reducing to the textbook vertical lines at θ = 90 deg.
The discriminator is the TRANSIT TIME from the outer blinder to the inner one:
a fault crosses in one sample, two systems pulling apart take tens of ms, so a
slow transit is a swing. Default trip-on-the-way-out (after a completed pole
slip) is the classical preference, because the breaker then interrupts with
the systems swinging back together instead of at the 180 deg point.

Tsw earns its place: at 30 ms the Spain locus false-declares a swing on a fast
transient at 0.5 s, at 50 ms it correctly waits for the real slip at 0.94 s.
Kept OFF by default (`oos` 0), so every existing case is a plain distance
relay and no behaviour changed anywhere else.

Consequence for the study: the ties now open at 1.83 and 1.86 s on their own
protection, against the 3.20 and 3.26 s that were scripted. The 1.4 s
difference is a finding, not an error to tune away — the relay says separation
came earlier than the hand-written timeline assumed. Scripted operations in
that case drop from three to two.

## 2026-07-27 — the last machine rides the collapse down, voltage-blocked
With relay-driven ties the cascade completes but stops short of the clean
"every bus below 0.10 pu" blackout the scripted version reached: it stalls at
~0.49 pu with Centre thermal still connected at 43.6 Hz. This is the
27-block-81 doing its job, not a defect. Every syncgen carries Fuv = 47.0 Hz
with Vblk = 0.80 pu, and CN's voltage falls through 0.80 pu BEFORE its
frequency reaches 47.0, so its own underfrequency element is blocked and the
machine never trips. It rides down with the island. Worth keeping in mind
before reading any final-state number from that case: at 0.5 pu and 43 Hz
every component model in it is far outside where it is valid.

## 2026-07-27 — zrel: Imin fault-detector supervision is optional, default off
Classical practice supervises an impedance element with a minimum-current
detector. It was added as `Imin`, but defaulted to 0 (off): the de-energized
and isolated-section cases it was meant to guard turned out not to produce a
near-origin Z at all (the G_on leakage leaves V/I large, ~1e8 Ω, safely
outside every zone), so defaulting it on would have been unearned magic
blocking legitimate low-current trips. It stays available for users who want
the classical supervision, and the start-up hazard it was conflated with is
handled by the settling gate instead.

## 2026-07-28 — a de-energized node has no frequency, and must not report one
The node-frequency instrument tracked numerical noise on a dead bus and
reported a confident 50 to 67 Hz at 0.0005 pu, which reads exactly like a live
system. Same failure class as reporting the tracking clamp, so the same
answer: below 2% of the largest positive-sequence magnitude that node has ever
shown, hold the last live value and latch `dead`, surfaced as
`probeMeta.fDead` / `query(...).deEnergized`. Self-scaling from the node's own
history, so no nominal voltage has to be configured anywhere.

Taken with the clamp fix, the rule for this instrument is now explicit: it
either reports a measurement or it says why it is not. It never quietly
returns a plausible number.

## 2026-07-28 — the Spain case never went dark because a protection was missing
Asked when the model fully collapses, the answer at 60 s was: it does not.
Voltage sat near 0.5 pu with Centre thermal carrying 32 kA indefinitely.

Cause: the synchronous fleet carried ONLY underfrequency protection, blocked
below 0.80 pu by the classical 27-block-81. Centre's voltage falls through
0.80 pu before its frequency reaches 47.0 Hz, so the element blocked itself
permanently and nothing else could trip the machine. A classical constant-EMF
syncgen has no field limit, no V/Hz element, no overcurrent trip and no
auxiliaries to lose, so it will drive a half-dead network forever.

That is a modelling hole, not a result about power systems: real generators
carry undervoltage protection precisely so this cannot happen. Added a 27
element at 0.70 pu / 1 s to the synchronous fleet, chosen to sit far below
anything healthy (pre-event buses 0.94 to 1.03 pu) and well after the
underfrequency ladder, so it is a backstop and not a competing mechanism. The
model now blacks out at 7.56 s, going 0.50 to 0.01 pu in about 50 ms once the
last machine goes.

Cross-check against the event: the real peninsula reached zero volts 8.2 s
after the France ties opened (12:33:21.5 to 12:33:29.741, ENTSO-E Factual);
the model takes 5.7 s. The earlier "it stalls half-collapsed" behaviour
matched nothing real and should never have been reported as a finding.

## 2026-07-28 — the real France ties tripped on out-of-step, as the model found
Recorded because it is the study's one piece of external corroboration. The
ENTSO-E Factual Report timeline has all France-to-Spain AC lines (Vic/Baixas,
Hernani/Argia) tripping at 12:33:21.407 to 21.535 on "loss-of-synchronism
(out-of-step, DRS) protection" — the element added here on 2026-07-27, and
NOT the distance zones that provably cannot see that swing. The same report
has the Spain-Portugal Cedillo to Falagueira tie tripping on distance
protection Z1 four seconds later, so both elements had a role, each on the
circuit it suits. The model reached the out-of-step conclusion from its own
impedance trajectory before that line of the report was read; the settings are
still tuned to this reduction, not to REE's.

## 2026-07-29: gtrip reports which element tripped it (cause)
A relay with more than one enabled element gave no way to tell, from the run
alone, which one fired. The gap was exposed by the Spain Blackout study: an
offline reconstruction of the decision, driven only by bus V/f series, got
Centre thermal's trip element wrong (predicted underfrequency, actual
undervoltage), because it cannot see the PLL lock detector that privately
gates the frequency elements. The relay itself always knows, so it now
records the asserting element's name as `this.cause` on trip, following the
convention `zrel` already set with `oosTripped`: set at the instant the
latch closes, initialized alongside `tripped`, and carried out through
`curMeta` (solver.js) and `_listSignals` (api/core.js), null when the relay
never trips. Verified against the one case here with independent ground
truth: the relay reports `27` for Centre thermal, confirming REPORT_v3.md
section 5's undervoltage claim and correcting the earlier reconstruction's
wrong answer.

## 2026-07-29 — the zrel out-of-step rationale in SPEC.md was wrong (conclusion right)

SPEC.md justified out-of-step tripping by saying a separation swing is a
"mostly RESISTIVE excursion" with apparent impedance "between 0 and -25
degrees" against an 84 degree characteristic. Measuring the Spain_Blackout
tie loci directly while writing the report showed that is not what the data
says: an exporting tie has R < 0, so a locus near the resistance axis has an
argument near +/-180 degrees, and the measured argument spans roughly -178 to
0 degrees. The conclusion (a mho element cannot pick up on this swing at any
reach from 60 to 300 ohm) is correct, and the operative reason is the SIGN OF
X: reactance is negative in every sample on both ties from the disturbance to
the tie opening, while a mho circle at the line angle is tangent to the origin
and extends into X > 0, so the two regions are effectively disjoint. Corrected
in place in SPEC.md because it is a physics rationale a future implementer
would rely on, with a dated note at the point of correction.

## 2026-07-30: resizable canvas and plots, and a per-plot vertical zoom

Three UI limits reported together, all of them "the view is a fixed slot".
(1) Canvas height: Wide and fullscreen only ever changed the width, so a
tall screen still showed the schematic through a letterbox. (2) Plot zoom
was time-only, which cannot resolve a signal that is flat at plot scale:
frequency was the reported case, where a 0.02 Hz excursion stays a
horizontal line however far the time axis zooms in. (3) Plot height was a
hardcoded 150 px.

Height in both places is a drag grip that writes one number (an inline
height on `#cnv`, `pl.h` on a plot) plus a double-click reset, rather than
preset size steps: the existing camera code already derives its aspect from
the element's live shape, so an arbitrary height needed no new geometry.
The canvas height is a localStorage preference (it is about this screen);
a plot's height is saved with the circuit next to its title and signals (it
is about that plot's content).

The zoom decision worth recording is that the time window stays SHARED
while the value window is PER PLOT. Sharing time is the whole point of
stacked plots (correlating one event across signals); sharing a value
window across plots holding volts, amps and hertz would be meaningless.
Within one plot both axis sides do move together, because a drag selects a
region of screen, not a range of one quantity. A drag/scroll acts on the
axes named by a toolbar mode (Time / Value / Box) rather than on a modifier
key: Shift+drag was already taken by pan, and the mode has to be visible
somewhere for the gesture to be predictable.

Vertical zoom made the old fixed `.toFixed(0)` y tick labels useless (a
zoomed 59.98 to 60.02 Hz axis printed "60" five times), so labels are now
formatted from the tick step and the axis gutters size to the widest
measured label. Two latent bugs surfaced while testing: a plot canvas with
only `width:100%` set takes its display height from the BITMAP aspect ratio,
so an undrawn card was laid out at half its own width until the first draw,
and window `resize` never redrew plots, leaving a stale bitmap width and a
wrong screen-to-time mapping until the next run.

## 2026-07-30: plots export themselves as PNG and CSV

Right-clicking a plot and using the browser's "Save image as..." was the
only export route, and it has two problems. It is not always offered:
the report came from an embedded viewer whose context menu has no such
item. And what it saves is the raw bitmap, which is the wrong artifact:
`drawOnePlot` clears the canvas rather than filling it, so the plot is
transparent (it inherits the page's theme by design) and carries no title
and no legend. Pasted into a document it is a floating set of unlabelled
traces on whatever colour happens to be behind it.

So export is now an explicit per-plot action. PNG composites the LIVE
canvas onto an opaque themed background with a title, the plotted time
window and a legend. It reuses the already-drawn bitmap rather than
re-plotting into a second context, which is what makes the figure
pixel-identical to the screen (verified by comparing every opaque pixel);
a second plotting path would be free to drift from the first.

CSV is the more useful half for anyone doing real work: one row per
stored sample in the current time window, one column per plotted signal,
full precision. The window is the TIME window only, because a vertical
zoom is a display range and must not silently drop rows from an export.
The values are the raw solver output, not the per-pixel min/max buckets
the plot draws when zoomed out, so a CSV is never a function of how the
plot happened to be scaled.

`plotSeries`/`seriesLabel`/`windowBounds` were factored out of
`drawOnePlot` and are now shared by the renderer, the legend and both
exporters, so an exported figure cannot disagree with the screen. Also
fixed while here: a plot's pointerdown treated a right-click as the start
of a zoom drag, capturing a pointer for a gesture that can never complete.

## 2026-07-31: one block browser, categories by function, blocks wear their category color

Four related UI decisions, all pushed by the same observation: the toolbar
was carrying weight the Library drawer had already taken over.

The per-category flyout is removed. It showed one category at a time at the
top of the page while the drawer showed all of them beside the canvas, so it
was a worse copy of a thing already on screen. Two consequences follow and
both matter. The drawer is now the ONLY way to add a block, so it has to
default to ON: a first visit with an empty localStorage would otherwise have
no way to build anything. And with no button row to keep short, the reason
the categories were merged is gone.

So the categories are now by FUNCTION, which is how someone looks for a
component, not by construction. Sources holds src, syncgen, gfm, gfl, wt4,
pv and batt: a wind turbine and a PV plant are generation, and filing them
under "power electronics" describes how they are built rather than what they
do. Loads is its own group and holds the induction motor, which is a load.
Power Electronics keeps only the converters that are neither generation nor
load: pfc, dcdc, hvdc, svc. Doing this surfaced that `zrel`, the distance
relay, had no palette entry at all and was unreachable from the UI despite
being fully implemented and used in the Spain study.

The per-block category corner tick became the whole symbol's color. The tick
was the cautious version (keep the IEC art monochrome, add a small mark) and
the verdict on it was that it was too small to be useful. Measurement blocks
are deliberately exempt and stay the default outline color: a bus, a ground
and a probe are annotations on a circuit, not apparatus, and keeping them
neutral is what lets a colored block read as "this does something".

Auto plots are capped at 6 signals. An auto plot expands from the live
registry, so on an imported case it meant every node voltage on all three
phases, redrawn on every streamed chunk. The cap is on the expansion only:
the legend reports how many were left out and the picker still offers all of
them, so nothing vanishes without saying so.

## 2026-07-31: clicking a wire selects it instead of deleting it

Click-to-delete was fine on a five-block demo and hostile on anything
larger: the useful question about a wire in a dense schematic is which two
terminals it actually ties together, and a stray click silently changed the
circuit with only undo to catch it. A click now highlights the wire, marks
both endpoints, thickens both end blocks and names both ends on the status
line; Delete removes it, the same key that removes a selected block.

The state is `selWire`, an INDEX into `S.wires`, because wires have no id
(unlike blocks). That is the thing to be careful with: it is cleared
wherever indices can shift or the circuit is replaced (block delete, clear,
load, undo restore), since a stale index would highlight, and then delete,
the wrong wire.

## 2026-08-01: bus-aware layout, tertiary buses, axis-aligned connectors, balanced columns

The user hand-fixed the auto-layout of the IEC 60909-4 network and asked for
the algorithm to reach the same result. Diffing their file against a headless
run of `busAwareLayout()` isolated four defects; all four are now fixed, and on
that case the layout goes from 13 wire crossings, 1 block overlap and a
1536-unit longest wire to 1 crossing, 0 overlaps and a 220-unit longest wire.

(1) A component touching 3+ buses (a three-winding transformer) had its extra
bus silently dropped: `buses: ub.slice(0, 2)` kept the first pair only. The
tertiary bus was then absent from the bus graph, so BFS never reached it, the
island fallback put it at layer 0, and it landed in the leftmost column with
its winding wire crossing the entire figure. Both of IEC 60909's tertiaries did
exactly that. Extra buses are now SATELLITES: the connector is drawn between
the two best-connected buses (by how many components touch each), and every
further bus is parked beside the component body, perpendicular to the connector
axis, outside the column grid entirely. That is the right shape for the object:
a delta tertiary is an accessory of its transformer, not a station of its own,
and giving it a column would space the whole figure around something that has
one connection.

(2) Connector symbols were always drawn flat (`rot = 0`) even when the
connector runs vertically, which happens whenever it joins two buses in the
SAME column. The body then lies across its own wire. The symbol is now turned
to lie along its axis.

(3) Parallel connectors overlapped. They land on adjacent taps, one 50-unit tap
pitch apart, and a transformer symbol is 52 to 56 units tall. Rather than grow
the tap pitch (which would lengthen every bus bar in the figure to fix two
symbols), each parallel group is spread perpendicular to its own axis by the
widest body measured ACROSS that perpendicular, so a diagonal run gets an
honest clearance instead of a nominal one.

(4) Columns were top-aligned: `cy = 160 + order * ROW` puts the first bus of
every column at the same height, so a one-bus column sits at the top of a
three-bus column and its connectors bend straight back up. Vertical position is
now relaxed toward the mean of each bus's neighbours in the adjacent columns,
with the minimum row separation re-imposed in the barycentric order after every
sweep. The ordering pass was already barycentric; this is the matching
coordinate pass.

Also added `declutterConnectors()`, the connector-body analogue of
`declutterProbes()`: a body that still overlaps something slides ALONG its own
wire first (it stays on the line, so nothing reads as disconnected) and only
then perpendicular, capped at 30% of the span so it cannot wander out from
under its own run and settle on a different bus. `orientTwoTerminal()` became
`orientBlocks()` and now considers any block with 2+ terminals, which is what
lets a three-winding transformer be flipped; 1-terminal blocks stay excluded
because a flip cannot shorten a single lead and their angle is set deliberately
by the placement pass.

Verified by re-running the layout headlessly on every example and comparing
against the previous algorithm, since browser screenshots do not composite in
this environment. iec60909: crossings 13 to 1, overlaps 1 to 0, wire length
8987 to 5270. ieee_harmonics_14bus: crossings 23 to 4, overlaps 3 to 0.
ieee39bus: crossings 9 to 6, overlaps 4 to 1, length 22047 to 19937. ieee9bus
unchanged at 0/0. The four-terminal geometry was then confirmed in the real app
by calling `doHierarchicalLayout('fit')` on the loaded example and reading back
block centres and rotations, which matched the headless run exactly.

## 2026-08-07: examples and fixtures re-laid-out; saved power-flow state is NOT model data
All 11 examples and all 8 JSON fixtures were reworked by hand (layout, bus tap
counts, explicit `vconv`, `sim` run settings) and promoted over the originals.
Four findings came out of promoting them, three of which were latent bugs the
promotion merely exposed.

**`pfInit` / `pfV` are derived state and must not be committed.** Saving a
circuit after pressing Power flow writes the solved operating point onto every
block. Reloading then STARTS the EMT run from it, so `showcase.json` came back
with its GFM injecting 11 kW instead of its 5 kW setpoint (41.9 A vs 17.1 A) and
five assertions failed. 506 such fields were stripped across 15 files. They are
a snapshot of one session, they go stale the moment anything is edited (the
suite already had a staleness detector, which was firing), and a shipped example
must describe the model, not one solve of it. Regenerate with "Init from PF".

**Re-saving a circuit materialises every DEFS default, which can change
physics.** A parameter that was absent is not the same as a parameter set to its
default: absent reads as 0/NaN at the use site. `tests/fixtures/dcbus.json` came
back with `Ichg: 10` written in, so the battery charged before the grid was lost
and the depletion check's coulomb balance broke. The test had relied on the key
being MISSING ("no Ichg -> never charges"); it now sets `Ichg: 0` explicitly. A
test must state the condition it depends on rather than inherit it from an
omission.

**`smoke_test.js` leaked `S.vconv` between tests.** Fourteen file-loading blocks
never set it, so each inherited whatever the previous test left behind. Harmless
while every shipped file was phase-convention, and immediately wrong once some
files became line-to-line: a `ll` file read as phase volts is off by sqrt(3).
Every load site now sets `S.vconv = ex.vconv || 'ph'`, and every circuit clear
resets it to `'ph'`, so tests no longer depend on execution order.

**IEEE 9-bus drops the parallel-breaker workaround.** The outage is now one
breaker with `nOps: 2` (open 200 ms, reclose 250 ms) instead of two breakers in
parallel, which supersedes the 2026-07-14 "opened latches, no reclose" pattern
for this case. Block 35 is gone, so the case is 34 blocks; the API test asserted
35 and was updated. With "Init from PF" on it no longer needs to wait out a
multi-second cold-start swing, so 500 ms covers the whole event where 3000 ms
used to be required.

## 2026-08-07: solver reports WHICH node floats, and refuses to return a diverged run
Two diagnostics, both prompted by examples that failed in ways the tool did not
explain.

**Singular matrix now names the circuit.** `buildLU` returns the failing column
instead of null, which maps back through `topo.off`/`cnt` to a node and then to
every block sitting on it. `ieee_harmonics_14bus.json` now reports "Bus #8
(BUS 8), AC PQ #27, Xfmr 3ph #67, V probe #76" and adds that #67 has a DELTA
winding on that side, which is the actual cause: a delta has no neutral, so with
nothing else on that side reaching ground the winding set has no voltage
reference. Confirmed by construction, `Yd11` fails and `Yy0` solves, and adding
a magnetizing branch does not rescue it. This is the isolated-secondary
limitation already named in SPEC section 5 item 4, not a new defect; only the
message is new. Note `Dy11` (delta PRIMARY) works, because that side reaches the
grounded source network.

**Divergence is now an error, not a result.** `iec60909_hv_network.json` grew to
1e28 V by 634 ms and still returned a "Solved" status with plottable garbage,
which is worse than failing because it looks like an answer. Every 16th step is
checked against 1e4x the largest source/EMF voltage in the circuit, a bound
nothing physical approaches, and the run stops naming the time. The message
leads with placeholder machine dynamics because that is the real cause here: a
case imported from a power-flow file has invented inertia and droop.

## 2026-08-07: imported bus bars are sized from their tap count
`import.js` hardcoded `len: 200` on every bus while computing a sensible tap
count from incidence, so imported buses were all one physical size regardless of
how many things hung off them: two-tap buses drew as long empty bars, eight-tap
buses were cramped. Now `len = 50 * taps`, matching `DEFS.bus` (1 tap / 50) and
the bus-aware auto-layout, which already wrote `50 * taps`. This is most of why
a freshly imported case read as clutter before running auto-layout on it.

## 2026-08-07: auto-layout direction picker only takes the bus-aware path when it can honour it
`doHierarchicalLayout()` called `busAwareLayout()` before consulting its
`direction` argument and returned early on success, so any circuit with 3+ buses
(that is, every transmission case) ignored the Left-to-Right / Top-to-Bottom /
Best-fit choice entirely and all three produced the same figure. The picker was
not broken, it was being bypassed. `busAwareLayout()` has no direction of its
own: it always advances BFS columns rightward with vertical bus bars, so it IS
left-to-right. It now runs for `lr` and `fit` only, and `tb` falls through to
the tidy-tree, which honours it. Teaching it to transpose for `tb` is the real
fix and is left in IDEAS.md.

## 2026-08-07: canvas parameter labels are formatted, not interpolated raw
Block sub-labels read straight off params, so an imported PSS/E line rendered
`0.0034567890123 Ω` and overflowed its symbol. A local `nn()` trims the DISPLAY
only: integers pass through whole (a 2400 V source must not read `2.40e+3`),
long decimals get four significant digits, and only very small or very large
magnitudes go exponential. `sciNum()` was deliberately not reused: its >=1000
rule turns ordinary voltages into exponentials, which suits a science panel and
not a schematic. Stored values are untouched, so no solve changes.

## 2026-08-07: a current-source interface wired to ground is still a floating node
The singular-matrix message now says so explicitly, because the circuit looks
grounded and is not. `ieee_harmonics_14bus.json`'s BUS 8 carries an `AC PQ` load
whose other terminal IS wired to a ground block, so "wire every terminal and
give the circuit a return path to ground" was actively misleading advice. `pq`
(like `zip`'s constant-power part, `cpl`, `im`, `svc`, `wt4`, `hvdc`, `gfl`) is
a controlled Norton current source built with `G: 0`: infinite impedance,
contributing nothing to the conductance matrix, so it cannot fix a node voltage
regardless of what it is wired to. The check reads the elements touching the
failing LU column directly (element `n1`/`n2` are global unknown indices, the
same space as the column) and, when every one of them has `G` falsy, says that
and names what would actually help: an `rlc`/`rlcp` shunt, a line with shunt C,
or a grounded transformer winding.

## 2026-08-07: new blocks land in the visible viewport, and are selected
`addBlock()` defaulted to a random point in a FIXED world-space box
(60..440 x 50..230), which is unrelated to where the camera is. On a large
circuit, panned away from the origin, a palette click created a block thousands
of world units off-screen with no sign anything had happened. The viewBox IS the
camera, so the visible centre is `view.x + view.w/2, view.y + view.h/2`; new
blocks land there, centred on their own footprint, stepping outward on a
perimeter walk when the spot is taken so repeated clicks tile rather than stack.
The new block is also SELECTED, which highlights it and opens its params rail:
at a zoomed-out view the centre of the screen is still a lot of pixels, and the
highlight is what actually answers "where did it go?". Drag-and-drop from the
palette is unaffected, since it passes an explicit drop point.

## 2026-08-07: fixed-direction layout options disabled in the UI pending rework
Left-to-Right and Top-to-Bottom are greyed out; Best fit is the default and the
only selectable option. They are not removed: `doHierarchicalLayout()` still
honours `'lr'`/`'tb'` and the API can pass them, and they behave sensibly on
radial circuits with fewer than three buses. The problem is the meshed case,
which is most of what the direction control is wanted for: `busAwareLayout()`
has no direction of its own, so `'lr'` produced the identical figure to `'fit'`
while `'tb'` fell through to a tidy-tree that draws a transmission network
badly. A control that appears to do nothing is worse than an absent one. The
default also changed from `'lr'` to `'fit'`. Re-enable once `busAwareLayout()`
can transpose (IDEAS.md).

## 2026-08-07: 3-phase examples use `xfmr3`; the single-phase block no longer stands in for a bank
Every 3-ph-only example that used `xfmr` now uses `xfmr3` with `conn: Yy0` and
both neutrals solidly grounded: `ieee39bus` (12 blocks), `ieee9bus` (3),
`central_ups`, `central_ups_sag`, `showcase` (1 each). The conflict was
documentary rather than numerical, and that is exactly why it mattered: the
`xfmr` block's own description opens "Single-phase transformer", so a flagship
three-phase case built out of them contradicted the tool's own help text. In
3-ph mode `xfmr` is instantiated per phase, which IS a grounded wye-wye bank,
and `xfmr3`'s description already stated the equivalence ("Yy0 with both
neutrals solid reduces exactly to three independent xfmr blocks"). The examples
now say what they mean.

**Two files deliberately keep `xfmr`.** `single_phase_lateral.json`'s pole-top
unit really is a single-phase transformer on a lateral, which is the block's
correct use. `radial_feeder.json` is documented to run in 1-ph OR 3-ph and
`xfmr3` is 3-ph only, so migrating it would remove capability.

**Verified equivalent rather than assumed.** Mapping is `a = V1/V2` either way:
`xfmr3` derives `a = (V1/V2)*(k2/k1)` with `k = sqrt(3)` on both wye sides, so
the factor cancels. Neither block is in `VCONV_PARAMS`, so no line-to-line
scaling difference. `lknee`/`Lsat` were dropped only where `Lm = 0` (all of
them), since they are gated by the saturable path. Measured: `ieee39bus`,
`central_ups`, `central_ups_sag` and `showcase` are bit-identical (worst PF |V|
change 0.000e+0 %, worst EMT RMS change ~1e-13 %, same Newton iteration count
and mismatch).

**`ieee9bus`'s 5e-5 % residual is a POWER-FLOW stamp difference, not a model
difference, and was tracked down rather than waved through.** It survived every
Newton tolerance from 1e-8 to 1e-14, so it is structural, not convergence. A
minimal src/xfmr/load circuit reproduces NONE of it: `xfmr` and `xfmr3` give
bit-identical EMT results at ieee9bus's own ratios (8.6088/120, 9.3912/120,
7.2/120) and at 240/120 and 4157/480. The decisive test is `pfinit`: with it
OFF the two versions of `ieee9bus` agree to 0.000e+0 %, with it ON they differ
by 5.8e-5 %. So the EMT models are identical and the residual is `buildYbus`
rounding differently for the two block types, about 0.5 ppm, which then seeds
the run. Far below any engineering significance and two orders below the
suite's percent-level tolerances, but recorded because "reduces exactly" is
true of the EMT stamp and not quite true of the power-flow stamp.

## 2026-08-08 — Headless runs default to the file's saved `sim` settings
`api/core.js`'s `runSimulation()` hard-defaulted to 120 ms / 3-ph / 50 µs and
ignored the circuit's `sim` block, which the UI honours (`applySimSettings`).
The result was that the agent surface silently measured a different study than
the file describes: `run examples/central_ups.json` ended at 120 ms, before the
150 ms utility trip the case exists to show, and `syncgen_droop` (a 5 s study)
showed nothing. Option precedence is now explicit option > file `sim` block >
built-in default, reported back as `settingsFrom` so a result is never
ambiguous about where its duration came from. The CLI's commander defaults were
removed for the same reason: with them in place an unset flag arrived as 120,
not undefined, and re-imposed the old behaviour one layer up.

The power flow is deliberately still NOT auto-run, even when the file carries
`sim.pfinit: true` (that flag drives the browser checkbox, and a hidden solve
would make scripted results depend on an invisible step). Instead the result
carries a `warnings` entry when the file asks for PF init and none has been
solved, and `openemt run|query --pf` makes that one step explicit. Guarded by
API-suite assertions that were confirmed to fail when the defaulting is removed.

## 2026-08-08 — README and SPEC lead with the agent-first identity
The front page opened with "concept-level ... proof of concept" and buried the
MCP server at line 180 under Development, so the differentiator (one pure
deterministic solver core with three coequal frontends: canvas, CLI, MCP) was
invisible at the moment of most attention, and the CLI was not mentioned at
all. The lead, the dual quick start, and the AS-IS accuracy notice were added
above the fold; MCP was promoted to a top-level section; `SPEC.md` was retitled
from "Web EMT Platform"; the app tab title and subtitle were updated to match.

Four stale facts were corrected at the same time, since stale numbers are worse
than modesty in a project whose pitch is meticulousness: 77 checks to 129,
32-block catalog to 36 (adding gfl, zrel, gtrip and the phase tap to the prose
list), roadmap "complete through item 31" to item 37 with item 9 still the one
open exception, and the two per-example "set Duration to N ms" instructions
that saved run settings made obsolete. `SPEC.md` section 4 was missing its
`gtrip` row (35 rows against 36 block types); the table is now checked against
`DEFS` rather than by eye.
