# Ideas

A backlog of things worth considering. **Nothing here is a commitment.** Ideas
are cheap to add, cheap to delete, and freely reordered.

Promotion path: when an idea is actually committed to, move it into the
`SPEC.md` section 5 roadmap (which is prioritized and tracks DONE), implement
it, then record the *why* in `DECISIONS.md`. This file is the funnel; the
roadmap is the plan; the decision log is the history.

**Engineering only.** This file is committed and the repository is headed for a
public release, so commercial, licensing, funding, and go-to-market ideas belong
in `legal/BUSINESS_DECISIONS.md` (gitignored), not here.

---

## Power flow follow-ups

The power-flow MVP documents its own limits; these are them, in rough value
order.

- **Initialize passive-element histories, not just machines.** Today the flat
  start seeds rotor angle, EMF, and filtered P/Q, but line currents and cap
  voltages still start at zero, so a brief electrical inrush remains over the
  first cycles. The power-flow solution already contains every bus voltage
  phasor, so each branch current and cap voltage is directly derivable. Would
  make the flat start exact rather than merely free of the electromechanical
  swing. Promoted to SPEC section 5 item 32 on 2026-07-25 (motivated by the
  Spain_Blackout study: the inrush knocks syncgens loose on weak buses).
- ~~**Newton-Raphson instead of Gauss-Seidel.**~~ DONE 2026-07-24 (why in
  DECISIONS.md). IEEE 39-bus went from 1368 Gauss-Seidel iterations to 4, and
  series-compensated networks that Gauss-Seidel diverged on now solve. Warm
  started with six Gauss-Seidel sweeps, because a flat-start NR converged onto
  the LOW-VOLTAGE root on one vendor case; Gauss-Seidel remains the fallback.
- ~~**Reactive-limit enforcement (PV to PQ switching).**~~ DONE 2026-07-24 (why
  in DECISIONS.md). `Qmax`/`Qmin` on `syncgen`/`gfm` (0/0 = no limit, so earlier
  circuits are bit-identical), carried from the RAW's QT/QB, enforced by a
  classical PV-to-PQ outer loop in Newton-Raphson and a per-sweep clamp in
  Gauss-Seidel, both latching. The measured example that motivated it closed as
  predicted: in `examples/ieee_harmonics_14bus.json` both generators now sit
  exactly on their limits (50.000 and 44.200 Mvar) and the three high buses went
  from +0.037 pu to +0.0008. Two adjacent fixes had to land with it (machines
  sharing a bus, and colocated load, both below).
- **N-1 contingency screening.** The canvas already color-codes buses against
  the 0.95 to 1.05 band. Looping branch outages and re-solving turns that into a
  real screening view, which is a large part of what an interconnection study
  actually wants. Natural extension of work already done.
- **Tap changers** on the transformer block.
- ~~**The power-flow STATUS LINE reports pu on a single system-wide base.**~~
  DONE 2026-07-24: the line summarizes `busBlocks` (each bus's own `Vbase`),
  matching the canvas annotations, and also names the method, the mismatch unit,
  and any de-energized buses.
- ~~**A generator sharing a bus with a load has its dispatch treated as the NET
  bus injection.**~~ ~~**Machines sharing a bus overwrite one another.**~~ Both
  DONE 2026-07-24 (why in DECISIONS.md), and they had to be done together with
  reactive limits, because each alone makes a vendor case worse: the two errors
  had been cancelling. A generator bus now schedules its machines' dispatch net
  of any load on that bus, and several machines on one bus aggregate (P and the
  reactive band add) instead of the last record silently winning, with the
  solved bus output split back per machine for EMT init. `ieee_25bus` puts
  1889 MW of its 3528 MW of load on generator buses; fixing only the aggregation
  took its worst bus error from 0.036 to 0.090 pu, and fixing both took it to
  0.035.
- ~~**Power flow has no `xfmr3w` (3-winding transformer) model.**~~ DONE
  2026-07-23 (why in DECISIONS.md). `buildYbus` now stamps the star (T)
  equivalent using the same analytic star-point elimination as the transient
  companion, with the xfmr3 complex-ratio factor carrying each side's clock
  number, so `solvePowerFlow` no longer refuses these circuits. Verified against
  the same T rebuilt from `rlc` + two `xfmr3` (agreement ~1e-10), and every
  vendor example case containing a 3-winding unit now solves.

## Scale

- ~~**Sparse solver to replace the dense LU.**~~ PARTLY DONE 2026-07-24 (power
  flow; why in DECISIONS.md). The power-flow path is now sparse: CSR Ybus, a
  Jacobian built once on the Ybus pattern and refilled per iteration, a
  column-list sparse LU with threshold pivoting, and a minimum-degree ordering
  so fill stays near nnz on imported bus numbering. This breaks the MEMORY
  ceiling (no dense m x m; a 7917-bus case now imports and runs where the
  dense Ybus could not allocate) and makes island labeling and Gauss-Seidel
  O(nnz). `bench.raw` (1648 buses, AC-unsolvable as imported) no longer hangs:
  it finishes in ~40 s and reports the imbalance, versus 25+ minutes unkillable
  with the dense solver. NR-vs-GS agreement tightened to ~1e-13.

  Two follow-ons are parked here as FUTURE ideas, not active work (2026-07-24:
  low value right now, since every solvable case in the 36.5 corpus is already
  instant and the large ones are AC-unsolvable, so neither has a case to prove
  out against):

  - **Typed-array / symbolic sparse LU.** The current LU stores each nonzero as
    a [col, val] pair and rebuilds rows on every elimination, so a single NR
    iteration at 1648 buses is ~0.6 s (a solvable case of that size NR-solves
    in a few seconds, not sub-second). Reaching sub-second on 1000+-bus NR
    needs a typed-array symbolic factorization (pre-allocate the fill pattern
    once, numeric refactor per iteration), the KLU-style approach. Worth
    revisiting only once there is a real large SOLVABLE case to benchmark
    against; `bench.raw` and `bench2.raw` are both AC-unsolvable (infeed via
    HVDC the importer does not model), so the sub-second headline cannot be
    demonstrated on the corpus today.
  - **Sparse TIME-DOMAIN solve (`buildLU`/`luSolve`).** The time-domain LU is
    still dense. Rewiring the ~12 spanning `e.stamp(M)` methods in `blocks.js`
    to the sparse builder (with a symbolic factor cached across breaker
    refactorizations, since the pattern is stable across switch events) is the
    other half of this item. The TD solve is currently fine for the case sizes
    it sees, so this waits until TD scale actually bites.

  The original measured framing, kept as the record of what was wrong before
  this pass: `buildYbus` allocated a dense m x m of `{re,im}` objects (2.7
  million at 1648 buses, 63 million at 7917), the NR Jacobian was dense with
  an O(N^3) `denseSolve` (~3.6e10 operations per iteration at 1648 buses), and
  island labeling and Gauss-Seidel were both O(m^2) per sweep. The methods
  (CSR, sparse LU, Tinney minimum-degree ordering, all 1960s) are public
  domain by age; adopting an existing IMPLEMENTATION (KLU, SuiteSparse) is a
  separate LGPL/GPL licensing question, which is why the core is hand-rolled
  in `src/solver.js`. See `legal/BUSINESS_DECISIONS.md`.
- **WASM solver** (already noted in SPEC section 5 item 8 as future). Worth far
  less than sparsity: it buys a constant factor, not a complexity class.

## Model fidelity

- **Grid-following (GFL) solar as its own current-source primitive**, with a PLL
  and momentary-cessation behavior. Deferred once already as "phase 2" when the
  grid-forming path was chosen. Note the trap: a naive constant-power injection
  behind impedance is the dual of the constant-power-load phantom-voltage
  problem, so the current limiter is what makes it well-posed. Promoted to SPEC
  section 5 item 33 on 2026-07-25 as the transmission-grade inverter model
  (per-plant-rated gains, transformer-leakage output reactance, explicit PLL,
  current limiter), motivated by the Spain_Blackout study. DONE 2026-07-25 as
  the `gfl` block (SPEC §2 derivation): a Norton current source (no series L,
  so no Lf-C resonance) with an explicit SRF-PLL, per-plant current limit +
  hard voltage floor, and an optional converter-voltage ceiling (Emax, Xt).
  All four SPEC validation targets met by smoke_test.js.
- **Synchronous generator beyond the classical model**: subtransient reactances,
  saturation, exciter dynamics. Currently round rotor with constant transient
  EMF behind Ra + Xd'.

## Transmission-scale dynamic studies (motivated by the Spain_Blackout study)

Promoted to the SPEC section 5 roadmap on 2026-07-25 as items 32 to 35
(passive-history initialization from the power flow; transmission-grade
inverter model; latched overvoltage/overfrequency generation-trip block;
weak-bus operating envelope for `syncgen`). The motivating context and the
full isolation log are in `studies/Spain_Blackout/DIAGNOSTICS.md`; the
committed descriptions and validation targets are in SPEC section 5. Each
needs an IP screening (`legal/BUSINESS_DECISIONS.md`) and a SPEC section 2
derivation before implementation.

## Component library

The 2026-07-16 component-library backlog (14 candidate blocks in three tiers:
induction motor, ZIP load, overcurrent relay, transformer vector groups,
Bergeron line, exciter/governor, SVC/STATCOM, Type 4 wind, surge arrester,
switched shunt, frequency-dependent line, VSC-HVDC, transformer saturation,
three-winding transformer) was promoted wholesale to the SPEC section 5
roadmap and is fully implemented (items 12 to 25, all DONE July 2026; the
whys are in DECISIONS.md). New block candidates go here as they come up;
none pending right now beyond the "Model fidelity" items above (GFL solar
primitive, subtransient syncgen).

## Interoperability and agent access

- ~~**A real API surface (MCP server or CLI).**~~ DONE (July 2026, SPEC section
  5 item 29): `api/core.js` + `api/cli.js` + `api/mcp-server.js` (stateful,
  registered in `.mcp.json` at the repo root). Remaining agent-access work is
  the importer below.
- ~~**PSS/E RAW importer (static case).**~~ DONE (2026-07-23, `src/import.js`;
  why in DECISIONS.md). Standalone pure-JS parser (browser bundle + `api/core.js`,
  no Python/pandapower/PSS/E at runtime), an Import button, an `import_case` MCP
  tool, and an `openemt import` CLI. Converts bus/load/generator/branch/2-winding
  transformer/fixed-shunt records (REV 30 to 36) to `bus`/`syncgen`/`line`/
  `xfmr3`/`pq`/`cap`/`rlc` blocks through the shared `applyCircuit()` load path.
  Validated against real v34/v36 `savnw` and v36 `ieee_25bus`. Still open below.
- **PSS/E RAW importer gap backlog.** Inventory taken 2026-07-23 by sweeping all
  19 PSS/E 36.5 example RAW files; percentages are prevalence in that corpus, so
  the ordering reflects real-world impact rather than guesswork. Tier 1 and 2 are
  being implemented now; the rest is the standing backlog.

  *Tier 1, correctness (silent wrong answers):*
  - ~~Transformer winding code `CW` never read~~ DONE 2026-07-23. Was assuming
    CW=1 semantics unconditionally; CW=2 puts winding data in kV, giving a wildly
    wrong turns ratio with no warning (56 transformers in the corpus). Fixed
    alongside proper CZ=1/2/3 impedance bases (CZ=3 is the load-loss-watts form).

  *Tier 2, missing but the block already exists (cheap, high value):*
  - ~~Three-winding transformers~~ DONE 2026-07-23 (30 of 2,699 transformers,
    1.1%): 5-line record, star (T) conversion onto `xfmr3w`.
  - ~~Switched shunts~~ DONE 2026-07-23 (imported as fixed at `BINIT`; switching
    control not modeled). Note: this section's field layout genuinely DIFFERS
    across revisions (v36 adds `ID`/`NREG`/`NAME` vs v34), which is why the
    parser gained `@!` header-comment-driven field lookup.
  - ~~ZIP loads~~ DONE 2026-07-23 (19 of 6,981 loads): RAW carries IP/IQ
    (constant current) and YP/YQ (constant admittance) alongside PL/QL; these
    were silently dropped by mapping everything to `pq`. Now maps to `zip` with
    real Z/I/P fractions when any are nonzero.
  - ~~Fixed-shunt conductance `GL`~~ DONE 2026-07-23 (66 of 1,581 shunts): was
    keyed only off `BL`, so a pure-conductance shunt was skipped entirely.

  *Tier 3, detail dropped inside records that ARE imported:*
  - ~~Transformer magnetizing branch `MAG1`/`MAG2` (91 in corpus)~~ DONE
    2026-07-24: carried as a linear `Lm` shunt on `xfmr3`/`xfmr3w` (the
    trapezoidal inductor companion; no saturation knee, MAG1 core-loss and
    capacitive MAG2 dropped). Irrelevant to power flow, matters for
    energization/inrush studies.
  - Tap-changer control (`COD`/`RMA`/`RMI`/`NTP`/`TAB`): the off-nominal tap is
    applied, but no regulating behavior. Ties to the "Tap changers" idea above.
  - ~~**The delta is put on the WRONG WINDING, which is a factor-3 impedance
    error, not just a cosmetic phase shift.**~~ DONE 2026-07-24 (see
    DECISIONS.md). `VECGRP` is now parsed and decides WHICH winding is the delta
    (a delta primary additionally gets its leakage rebased by 3, since `xfmr3`'s
    R/L are per-winding); `ANG` remains the sole authority on the SHIFT, because
    VECGRP is an informational label that routinely names a delta on a record
    carrying ANG = 0. The shift sign was inverted too: it is ANGk - ANG1, which
    is -ANG1 for a two-winding record but +ANG3 for a tertiary, so the
    two-winding path had been flipped while the three-winding path was correct.
    `ieee_harmonics_14bus` now matches its source case exactly, all 16 buses in
    magnitude and angle.
  - **`xfmr3`'s magnetizing `Lm` is per-winding in the EMT companion but
    node-basis in the power-flow stamp.** Found 2026-07-24 alongside the vector
    group work. `makeXfmr3s` adds `Gm` across the primary WINDING port (through
    the connection incidence row), while `buildYbus` adds `-1/(w*Lm)` straight
    onto the primary node. For a wye primary those are the same thing; for a
    DELTA primary they differ by 3, so a `Dy` unit with Lm > 0 is inconsistent
    between the transient and the phasor solve. Nothing in the PSS/E corpus
    combines a delta primary with a nonzero MAG2, so no scaling was guessed at.
    Deciding it properly means picking one convention for the param and fixing
    whichever side disagrees, plus a regression case built by hand.
  - True phase-shifting transformers: an ARBITRARY shift angle is still not
    representable on `xfmr3`, which only has clock numbers; the +/-30 deg cases
    above are the ones a vector group can express at all.
  - ~~Branch `GI/BI/GJ/BJ` line-end shunts (27 of 13,436, negligible)~~ DONE
    2026-07-24: the net susceptance is folded into the line pi-C (split equally,
    an approximation when the ends differ); shunt conductance and net inductive
    susceptance are dropped (no per-end G or shunt-L on the line block). Warned.
  - ~~Thermal ratings `RATE1-12`, line length, metered end~~ DONE 2026-07-24 as
    inert metadata on the line block (`RATE1..3`, `LEN`, `metre`), so the data is
    no longer silently lost. The loading/limit CHECK is still future: it needs
    the terminal-bus voltage per branch, which the query path does not yet
    expose, so a `loading` signal and an over-100% flag are deferred.
  - ~~Generator `QT`/`QB` reactive limits~~ DONE 2026-07-24: carried onto the
    machine as `Qmax`/`Qmin` and enforced by the solver (PV-to-PQ item above).
    PSS/E's +/-9999 "unlimited" sentinel maps to the block's own 0/0.
  - ~~Bus `NVHI`/`NVLO` voltage limits~~ DONE 2026-07-24: drive the per-bus
    canvas voltage band (`Vhi`/`Vlo`, default 0.95/1.05) instead of the
    hardcoded band.
  - ~~Area/zone/owner metadata~~ DONE 2026-07-24: carried as inert ids on the
    bus block. No grouping or area-interchange logic yet; the data is available
    for a future grouping view.

  *Tier 4, missing components (no equivalent block, real modeling work):*
  - HVDC: two-terminal DC, VSC DC, multi-terminal DC lines. FACTS devices.
    Induction machines. Multi-section lines (2 in savnw). Impedance-correction
    tables.

  *Tier 5, structural:*
  - **DYR dynamic-model import.** A RAW file has no dynamics, so imported
    machines get generic placeholder H/droop (Ra/Xd' seeded from generator ZR/ZX
    when present). OpenEMT's dynamic models don't map 1:1 to PSS/E's DYR library,
    so this is best-effort/manual-tuning translation, not a clean parse.
  - `.rawx` (the newer JSON variant) unsupported.
  - Sequence data (negative/zero sequence) not imported, so no unbalanced or
    fault studies from an imported case.

  *Robustness:*
  - Zero-impedance branches (X=0) do not occur in the example corpus but are
    common in real utility cases; they would currently make a degenerate `line`.
    Needs either a small series reactance or a proper node-merge.
  - Out-of-service equipment is dropped silently; could optionally import as open
    breakers so the topology is preserved.
  - ~~**A bus left with NO incident admittance NaNs the whole power flow.**~~
    ~~**Multiple slack buses.**~~ Both DONE 2026-07-24 in the solver: references
    are assigned per electrical island, and a bus with no source in its island
    is held out of the iteration and reported by name. The importer-side half
    (not emitting a bus with nothing attached) was deliberately NOT done: the
    bus is real, it is in the case, and reporting it de-energized is more honest
    than hiding it.
  - ~~Generalize the `@!` header-comment field lookup to every record type.~~
    PARTLY DONE 2026-07-24: applied to the generator and branch records, which
    is where it was actually biting (REV 34 inserted NREG, shifting MBASE / ZR /
    ZX / STAT / PT one field later). Transformer, load and fixed-shunt records
    still read positionally; their layouts have been stable across 33 to 36, but
    the same treatment is cheap insurance.
  - ~~**The remaining unsolvable vendor case class is HVDC, not numerics.**
    Importing HVDC links as a scheduled P injection at each converter bus
    (ignoring the DC side entirely) would make this whole family solvable and is
    much less work than a real converter model.~~ DONE 2026-07-24: all three DC
    record types map to a scheduled `pq` at each converter bus, and all six
    `sample*` variants now converge (see DECISIONS.md, which also covers the
    Newton flat-start retry the series capacitors in those cases turned out to
    need). Four follow-ups the work surfaced, in rough order of how much they
    cost the `sample*` solution:
      - **LCC converter reactive consumption.** A rectifier or inverter absorbs
        roughly half its real power in reactive, and the filter banks that
        offset it ARE imported (they are ordinary fixed and switched shunts), so
        modeling P alone leaves converter buses reading high. `sample.raw`'s
        40-bus island converges but sits 0.15 to 0.20 pu and 20 to 30 degrees
        off the vendor solution, mostly from this. The classical relation
        (cos phi = Vd/Vd0, Q = P tan phi, with RC/XC/EBAS/TAP/ANMX all in the
        record) is 1960s textbook material, but it IS a component model and so
        needs the IP screening step first. A VSC in MODE = 2 states its power
        factor outright, which is arithmetic on a stated datum rather than a
        model, and is the cheap half of this.
      - **Series capacitors are a live EMT trap now that these cases import.** A
        RAW branch with X < 0 becomes a negative L on the line block. That is
        right for the power flow and meaningless in the time domain, where the
        companion model would want an actual series C. No warning is emitted
        today; at minimum there should be one.
      - **A three-winding transformer with ONE winding out of service is dropped
        whole.** STAT of 2, 3 or 4 means the unit is in service with that
        winding out, not that the unit is out. `sample.raw` has three, and
        dropping them strands buses 215, 3010 and 3012 with no AC connection at
        all (215 and 3010 are reported de-energized, and 3010 takes a 12 MW load
        with it).
      - **FACTS devices still carry power nobody models.** `sample.raw`'s
        `FACTS_DVCE_2` moves 350 MW and 40 Mvar from bus 153 to bus 155. Unlike
        HVDC this is inside a single island, so it does not break the balance,
        only the distribution.

- **Other vendor importers.** The `importCase` dispatcher is the seam:
  PowerWorld `.aux`, OpenDSS `.dss`, PowerFactory only via a user-produced
  CIM/XML export (no safe native-format read path).
- **Network-reduction module (low priority, not needed for the main
  application right now).** For loading an ERCOT-scale case as a *boundary
  equivalent* behind a detailed hand-built EMT circuit, rather than as a full
  network in OpenEMT: reduce to a capped bus count by retaining chosen
  boundary buses and eliminating the rest. Confirmed 2026-07-21 that this does
  NOT need OpenEMT's own sparse/WASM solver work (see "Scale" above) or a new
  numerical method: pandapower 3.4.0 (already available in this environment)
  ships `grid_equivalents.get_equivalent(net, eq_type, boundary_buses,
  internal_buses)`, implementing Ward/xward/REI reduction against real
  utility-scale cases. The only genuinely new OpenEMT-side piece would be a
  converter from the reduced pandapower net (ext_grid/ward/xward at the
  boundary, real elements internally) to OpenEMT circuit JSON (`src`/`syncgen`
  + `rlc`/`line` + `bus`). Depends on the PSS/E importer above only if the
  source case isn't already loadable via pandapower/PSS/E MCP tools directly.

## Tooling and verification

- **Screenshot-driven launch verification.** OpenEMT is a standalone
  `index.html` assembled by `build.py`, opened straight from disk with no dev
  server. Today "launch" can only confirm the entrypoint resolves and the smoke
  test is green; confirming the canvas actually renders needs a real browser.
  Adding Playwright (or Puppeteer) would let a `run`/launch step load
  `index.html`, drive a representative circuit, screenshot the canvas, and
  assert the frame is non-blank. The same harness could capture regression
  screenshots of solver output over time. Pure tooling, no `src/` change; the
  dependency would be dev-only and must not touch the byte-stable build.

## Validation and study material

- **Per-block validation suite** (SPEC section 5 item 9, still open). Each block
  with a canned circuit and an analytical or reference-tool check. Flagged in
  SPEC as non-negotiable before any client-facing use, and it is the one roadmap
  item still outstanding.
- **A reduced ERCOT-flavored equivalent case**: weak import corridor, high
  inverter share, lower inertia. The current IEEE 39-bus realization has an
  H=50 aggregate machine that pins system frequency, so frequency-stability
  stories fall flat on it (documented in DECISIONS.md). A case where frequency
  actually moves would let the grid-forming fast-response benefit show.

## Usability and interface

From a measured audit of the shipped app on 2026-08-13 (build c165506, v0.1.1)
at 1280x720 and 375x812. Every number below was read off the live page with
`getBoundingClientRect` and computed-style inspection, not estimated. Until this
audit the whole backlog was solver, importer and physics work, with no interface
item in it at all.

The framing that came out of it: the *content* in this app is ahead of tools
costing five figures a seat (the solver errors name the offending block and the
fix, the science rail is real teaching material, the verification tier is
honest), and almost none of it is delivered where a person can receive it. So
most of the work is moving existing quality into the user's field of view rather
than adding features. Ordered in four phases by how many users each reaches.

*Phase 1, make the run/look/adjust loop visible (the whole point of the tool):*

- **The result of pressing Run is off screen.** At 1280x720 the first plot
  starts at y=771 and the plot toolbar at exactly 720; on a phone the first plot
  is at y=1111 in a 902px viewport. 250px of chrome sits above the canvas (title
  24, subtitle 32, toolbar 124 across four wrapped rows, status 26). A run
  completes and the only visible change is one line of grey text. Reclaim the
  vertical budget (subtitle behind an info affordance, title inline with the
  toolbar, toolbar toward two rows, target under 120px) and get the canvas and
  first plot co-visible.
- **No way to read a value off a plot.** Zero hover handlers on the plot
  canvases: no data cursor, no crosshair, no readout. "What is the voltage at
  t = 34 ms" is the most common question anyone asks a transient simulator and
  the only answer today is a CSV export. Everything needed exists already (zoom,
  legend, per-plot `_geom`); only the readout is missing.
- **`--tx3` fails WCAG AA in both themes.** 3.59:1 on white, 3.26:1 on `--sfc1`,
  3.79:1 on the dark card, against 4.5:1 required for text under 18.66px. It is
  the colour of `#stat` where every solver error appears (12px), the subtitle
  (12px), the `.tcl-l` cluster labels (9px), and every `.hint` block, which is
  where all the per-block physics writing lives (11px). `--acc` is marginal too
  at 4.42:1 on white and sets the science summary text.
- **Errors share a channel with progress text.** The solver's diagnostics are a
  genuine competitive advantage and they render in the same 12px grey line that
  says "Running... 40%". They need their own persistent, dismissable region, and
  it must carry the full message rather than truncating it into a toast.
- **The app explains itself in a message that self-destructs.** `#stat` ships
  with the only description of the interaction model anywhere in the UI (wiring,
  panning, rotate, find). `loadDemo` auto-runs on a 400 ms timer and overwrites
  it. `loadDemo(autorun=false)` already exists solely so a bad `?example=` link
  keeps its explanation on screen, for exactly this reason; the general case was
  never covered.

*Phase 2, make the "runs on your phone" claim true (it is the launch
differentiator and currently the weakest surface):*

- **Wire terminals are a 5.6 by 5.6 CSS pixel target on a phone.** The canvas
  renders at scale 0.507 at 375px, so the r=5.5 user-unit terminal circles come
  out at 5.6px; a whole block is 46 by 26. The touch standard is 44 by 44. Give
  terminals a transparent hit circle sized in CSS pixels rather than user units
  so it holds at any zoom.
- **All 30 toolbar controls are under 44px tall, smallest 21px**, and the
  toolbar is 363px across five wrapped rows. 70% of the first phone screen (627
  of 902px) is furniture before the schematic starts. Collapse to Run, Power
  flow, Library and Examples with the rest behind an overflow control, and add a
  sticky Run so the primary verb is always reachable.
- **The rails cover the canvas they annotate.** On a 345px canvas the science
  rail is 241px (70%), params 217px (63%), library 189px (55%). The floating
  drawer model is right on a monitor and wrong on a phone, where these want to
  be bottom sheets under 760px. They also overflow outright: with the Library
  open and a block selected, `.emt.lib .props` sits at `left:184px` and is
  196px wide, so it reaches 380px on a 375px viewport and gives the page a
  horizontal scrollbar. Measured 2026-08-13 and confirmed to predate the Phase
  1 work; left alone deliberately, since the bottom-sheet rework replaces this
  geometry rather than adjusting it.
- Acceptance test, on real hardware rather than an emulator: place three blocks,
  wire them, ground it, and run, without pinch zooming.

*Phase 3, make it fast to build (serves the person who decided to stay):*

- **No copy, paste, or duplicate.** A ten-bus feeder is ten trips to the library
  plus ten rounds of retyping. For a tool shipping a 39-bus example this is the
  largest throughput gap. Shortcuts today are Ctrl+Z, Ctrl+Y, `/`, R, Delete and
  Escape; missing are Ctrl+S, Ctrl+C/V, Ctrl+A and arrow-key nudge.
- **Wiring gives almost nothing to go on.** Terminals get a crosshair cursor,
  which does not exist on touch, and no hover state. After the first click no
  line follows the pointer, so there is no sign you are mid-wire; clicking empty
  canvas cancels silently.
- **`clearAll()` silently flips the convention from phase to line-to-line.** The
  choice is deliberate per SPEC section 2, but nothing tells the user, so
  clearing and rebuilding the same circuit with the same typed numbers is off by
  root three with no other symptom. That is a named trap in CLAUDE.md reachable
  by pressing a button labelled Clear. Clear should also announce that it
  emptied the canvas and that Undo restores it (`pushHistory` already runs).
- **No empty state, and a stale status line.** After Clear the SVG has zero
  children and `#stat` still reports the previous solve ("Solved: 3 nodes ...
  2,400 steps") on an empty canvas.
- **The manual lives in 35 `title` attributes.** Plot step, PH versus LL, Init
  from PF: all load-bearing, all invisible on touch, unsearchable, and absent
  from every screenshot. Promote the important ones to visible help; keep the
  tooltips as well.

*Phase 4, convert users into contributors (the stated goal of the launch):*

- **The verification tier is a recruiting line that ends in a full stop.** The
  science rail already tells the user no block has been cross-checked against a
  commercial EMT program. Anyone reading that sentence who holds a PSCAD or
  PSS/E seat is exactly the contributor being sought, and they are reading it at
  the moment they care. Link it to the block-validation issue template.
- **Closing the tab discards unsaved work silently.** The dirty flag and its
  bullet marker already exist; nothing acts on them and there is no
  `beforeunload` guard, no autosave, no recovery.
- **The Layout dialog mostly says no.** Two of three options are disabled with
  an honest explanation. Being honest is right; showing a dialog whose main
  content is two refusals is not. Apply Best fit straight from the toolbar and
  bring the dialog back when the other layouts work (see the section above).

Explicitly *not* planned, so it does not creep in: a docked multi-pane IDE
layout (the floating-drawer model suits a single-file app and needs a responsive
variant, not a rewrite), a modal tour or onboarding wizard (the auto-running
demo is a better first impression; fix where its output lands), and anything
touching the solver (every item here lives in `src/ui.js` and `src/shell.html`,
so the API and MCP frontends are unaffected).

## Auto-layout follow-ups

- **Teach `busAwareLayout()` to transpose for top-to-bottom.** It currently has
  no direction of its own (BFS columns always advance rightward, bus bars always
  vertical), so the Top-to-Bottom option falls through to the tidy-tree, which
  draws a meshed network far worse. A final transpose pass over the computed
  positions, swapping the axes and rotating the bars, would let TB keep the
  bus-aware quality. See the 2026-08-07 DECISIONS entry for why the fallback
  exists today.
