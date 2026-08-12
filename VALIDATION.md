# Validation suite

This is the manifest for SPEC §5 roadmap item 9: *for each block, a canned
circuit with an analytical or reference result and a tolerance check, non-
negotiable before any client-facing use.* The runtime is `smoke_test.js`; run
it from the repo root with `node smoke_test.js`.

The suite is the project's safety net: it must pass before and after any
solver or example change (CLAUDE.md). It runs every block in a canned circuit
and checks the time-domain result against an independent reference. The
end-of-run summary prints a per-block PASS/FAIL table and exits nonzero if any
hard check fails.

## Reference types

Each check is classified by where its expected value comes from. The
distinction matters: a check is only as strong as its reference is
independent of the code under test.

- **analytical**: a closed-form phasor derived by hand (a voltage divider,
  reflected impedance, equivalent-circuit current). Independent of the
  solver's trapezoidal companion model in the sense that the math is
  elementary and does not share code, but the steady-state target and the
  solver's convergence point are the same physical fact.
- **independent-solver**: a complex nodal or two-port solve through
  [`tests/reference/phasor.js`](tests/reference/phasor.js), a self-contained
  linear-algebra helper with no dependency on `src/`. The pi-line check and
  the demo-circuit cross-check use this. The strongest class short of an
  external reference tool, because the reference is a genuinely different code
  path.
- **self-consistency**: a structural property with no single fixed target
  (zeta monotonic across a D sweep, charge balance, distinct per-pole clearing
  instants, no CDA blowup). Catches wrong implementation structure even when
  any one number happens to look plausible.
- **fixture**: an integration check against a saved schematic in
  `tests/fixtures/` or `examples/`. Catches wiring typos and cross-block
  regressions the inline tests cannot, but its "reference" is the
  hand-verified steady state of that file, not an external tool.
- **reference-tool** (a commercial or independently-developed EMT program):
  **not yet present for any block.** This is the one remaining gap for item 9
  (see the scoreboard below, and "Remaining work").

## Scoreboard

**0 of 36 block types have been cross-checked against a commercial or
independently-developed EMT program.** Every block is checked, and the harness
gates on those checks, but the references are all in-house: closed-form phasors,
a self-contained nodal helper, and structural properties. That is why the README
carries an AS-IS notice, and it is the honest state of the project.

Not every block benefits equally from an external check, so the table ranks them
by **cross-check priority**: how much a commercial reference would tell you that
the current check does not already establish. The ranking is an engineering
judgement, stated so it can be argued with:

- **High** — the block's *dynamics* have no closed form, so the existing gate is
  either a structural property or a steady-state target that the solver reaches
  by construction. An external tool would genuinely test the trajectory.
- **Medium** — a closed form pins the steady state, but the transient path to it
  is unverified against anything outside this repo.
- **Low** — linear circuitry against an exact phasor, or a node identity. A
  reference tool would agree by construction; effort here buys little.

| Priority | Blocks | What an external reference would actually settle |
|---|---|---|
| **High** | `xfmr` (saturation), `mov`, `gfm`, `gfl`, `syncgen`, `im`, `brk`, `zrel`, `gtrip`, `hvdc`, `wt4`, `fdline` | Inrush and clamp trajectories, converter-control and limiter behaviour under disturbance, machine swing and start transients, arc-free current-zero clearing, relay pickup timing on a real swing, and frequency-dependent line response. These are where independent EMT programs most often disagree with each other. |
| **Medium** | `pq`, `zip`, `cpl`, `svc`, `vsw`, `relay`, `pfc`, `batt`, `dcdc`, `pv`, `xfmr3`, `xfmr3w`, `tline` | Steady state is pinned analytically; the approach path, control-loop damping, and switching instants are not. Constant-power behaviour behind an impedance (`pq`, `zip`, `cpl`) is the known-fragile corner, see the CLAUDE.md traps. |
| **Low** | `src`, `line`, `cap`, `rlc`, `rlcp`, `tap`, `fault`, `bus`, `scale`, `gnd`, `probe` | Linear or structural. Already checked against an exact phasor or a node identity, several at 1e-9 or exact. |

If you have access to PSCAD, PSS/E, PowerFactory, EMTP-RV or similar, a single
**High**-row block is the most valuable contribution available to this project.
See [CONTRIBUTING.md](CONTRIBUTING.md) for what to send; a CSV and the case file
is enough. Progress is tracked in
[issue #9](https://github.com/h-d-engineer/OpenEMT/issues/9).

## Harness

`smoke_test.js` defines a small registry (`record`, `summary`) at the top.
Each per-block tolerance gate calls `record(block, name, ok)` instead of
`process.exit(1)`, so one regression no longer masks the rest: every block
still runs and the summary shows them all. Catastrophic solver errors (the
braced `if(r.err){...process.exit(1)}` guards) still bail immediately, because
there is nothing left to validate once the solver itself has crashed and
continuing would read undefined metadata.

`soft` is reserved for future tolerance-drift checks (numerical/measurement
noise rather than wrong physics). Every current gate is **hard**, preserving
the old CI contract that any gate failure is exit 1.

## Per-block manifest

Every functional block in `DEFS` (`src/blocks.js`) has at least one check.
Tolerances are the gates actually enforced in `smoke_test.js`; "ref" is the
reference type from the list above.

| Block | Checks | Ref | Tolerance |
|---|---|---|---|
| `src` | demo \|V\| divider; open-circuit EMF = Vrms*sqrt2; frequency = f | analytical | 2%; 0.1%; 0.05 Hz |
| `line` | coupled balanced Z1=Zs-Zm; SLG phase collapse + asymmetry; pi-line 2-node nodal; pi-line + mutual-coupling rejected; pi-line on DC runs one copy (3-ph == 1-ph == divider) | analytical / independent-solver | 2%; 1% |
| `gfm` (1-ph) | phase-A lateral == 1-ph mode (machine eps) delivering its GFL P0/Q0; islanded droop f/P fixed point with ~0 phantom Q into R; reactive power vs independent phasor solve; DC-port lossless balance; Iacmax refused single-phase | independent-solver / analytical | eps; f<0.02 Hz, P<2%, Q~1% |
| `relay` (lateral) | phase-A lateral reproduces the 1-ph circuit exactly, incl. trip instant | independent-solver (mode equivalence) | exact (0.0e+0) |
| `vsw` (lateral) | phase-A lateral reproduces the 1-ph circuit exactly, incl. bank-close instant | independent-solver (mode equivalence) | exact (0.0e+0) |
| `pfc` (lateral) | single-phase AC side: P_ac = P_dc, unity pf, terminal bounded below source (catches the pre-fix +/-53 kV runaway), phase-independent | analytical | <2% (measured 0.00%); pf >0.99 (measured 1.0000) |
| `tap` | 1-ph lateral on each of A/B/C vs an independent complex-phasor solve (current and voltage); untapped-phase symmetry; only the tapped phase sags; lateral tracks its own source phase; phase propagates through a 1-ph transformer to its secondary; 4 error paths (bridge, spanning-model-on-lateral, PF refusal, 1-ph transparent) | independent-solver / analytical | <1% (measured 0.00%); symmetry <1e-9 (measured ~1e-15) |
| `tline` | open-end doubling at tau; matched-load pure delay; DC single copy (lumped-R divider, both modes) | analytical | <1% |
| `fdline` | Bergeron degenerate limit; 60 Hz transfer vs independent two-port | analytical / independent-solver | <3%; <2% mag, <2 deg |
| `pq` | P + Q setpoint (lag and lead) | analytical | P<5%, Q<8% |
| `zip` | P/Q vs polynomial at V0 and 0.8*V0 | analytical | <3% |
| `cap` | series-RC divider steady peak | analytical | 2% |
| `rlc` | sentinel limiting cases vs R/line/cap; full R+L+C divider; switched be/CDA half-step | analytical / self-consistency | 2%; 0.1% cross-ref |
| `rlcp` | sentinel limiting cases; full R\|\|L\|\|C; resonance peak at f0; switched half-step; R=0 floored short in series (finite + divider) | analytical / self-consistency | 2%; 0.1% cross-ref |
| `brk` | per-pole current-zero clearing; multi-op close/open/reclose | self-consistency | clears <5% of peak, distinct poles |
| `relay` | 51 timed trip vs C37.112 curve; 50 instantaneous; below-pickup hold; bad-brkId error | analytical | curve window, <2-3 cycles |
| `xfmr` | reflected-impedance secondary V; saturable core linear mag + two-slope peak; V2=0 rejected with clear error | analytical | 2%; 3% / 5% |
| `xfmr3` | Dy11 ratio+30 deg shift; Yy0; delta zero-seq block; U-wye suppression; PF | analytical / self-consistency | 1% / 1.5 deg; <2%; >50x |
| `xfmr3w` | Yy0d1 ratios/shifts; delta tertiary zero-seq sink | analytical / self-consistency | 1% / 1.5 deg; >50x |
| `gfm` | island droop fixed point; AC current limiter (island + grid-tied); DC port; GFL P/Q | analytical | 2% / 0.1 Hz; limiter 3/10/5%; 5% |
| `syncgen` | SMIB freq lock + Pe=Pm0; damping sweep (zeta monotonic, wn self-consistent); two-machine load-sharing; AVR fixed point + governor lag | analytical / self-consistency | 0.001 Hz / 2%; 1.5% |
| `im` | steady slip + stator Irms vs equivalent circuit; DOL start band | analytical / self-consistency | 2% |
| `hvdc` | scheduled transfer + link regulation + reversal | analytical | 3%; 3%; 1% |
| `wt4` | cubic tracking + rating cap + gust + Q dispatch | analytical | 2%; 6% Q |
| `pfc` | reverse-mode -Imax export + AC phasor + SOC drain | analytical | 1% |
| `batt` | CC charge (bus, Ichg, SOC slope); depletion (SOC->0, charge balance) | analytical / self-consistency | 2%; 3% |
| `dcdc` | CV mode (Vref, out/in power balance); CC mode (I0, V=I0*R, balance) | analytical | 2% |
| `pv` | I-V curve datasheet points + peak near Vmpp; MPPT convergence; irradiance scaling | analytical | 1%; 3% |
| `cpl` | DC constant-power load: I=P/V + battery power balance | analytical | 2% |
| `fault` | fault-on divider + recovery | analytical | 2%; 5% |
| `bus` | multi-wire junction == direct wiring; auto-monitor meta + signal == probe; single-tap anchor | analytical / self-consistency | 0.01%; 1e-9 V |
| `svc` | droop line + lift + SVC/STATCOM ceiling | analytical | 1%; 0.5% |
| `scale` | current-scaling: I_net = N*I_local (integer + non-integer N) | analytical | 1% |
| `mov` | sub-knee leakage + clamp divider (V, I) | analytical | 1%; 2% |
| `vsw` | sag closes bank at predicted V; healthy feeder holds off | analytical | 2% |
| `gfl` | P/Q setpoint at unity, leading and lagging PF; current limit at 1.2x through a fault and recovery; voltage-floor ride-through with no I=P/V runaway; weak-bus stability at SCR~3; PLL tracks a network off f0 | analytical / self-consistency | P/Q <5%; limiter <10%; f <0.1 Hz |
| `gtrip` | PLL bus-frequency accuracy at 60/61/58.5 Hz and disarmed hold; 59 definite-time trip on a solver-driven step; 81U on an exact governor-droop slope, trips above and holds below; latch holds after the bus recovers; 59 hysteresis resets past dropout; Vblk holds the 81 timers on a collapsed bus; two-plant cascade trips B from its own measurement only; reported trip cause | analytical / self-consistency | trip window 300-340 ms; <0.01 A after latch |
| `zrel` | apparent-Z accuracy; mho zone-1 trip; out-of-reach hold; start-up hold; 1-ph mode rejected with a validation error | analytical / self-consistency | zone boundary, trip vs hold |
| `zrel` (out-of-step) | classical double blinder: way-out and way-in both trip on a real slip; steady load flow with the element armed holds; a fault stepping inside the blinders is not called a swing | self-consistency | binary trip/hold |
| `gnd` | grounded node pins to 0 V | self-consistency | <1e-6 V |
| `probe` | two probes on same node agree, no loading | self-consistency | <1e-9 V |
| `powerflow` | converge + machine init at nonzero angle + flat-start swing < cold; series relay stamped (downstream bus connected); unstampable series block rejected | analytical / self-consistency | swing <30 mHz; 0.05 Hz; 0.5% |
| `solver` | demo derived P/Q/RMS + energy balance (Tellegen); dt convergence; plot-step spacing; demo independent nodal cross-check; first-step NaN guard | analytical / independent-solver | 2-3%; dt 2%; plot exact |

### Integration fixtures

Saved schematics exercised end-to-end. Their reference is the hand-verified
steady state of the file; they guard wiring typos and cross-block regressions.

| Fixture | File | What it guards |
|---|---|---|
| `fixture:showcase` | `examples/showcase.json` | every AC block in one circuit + pivoting-LU regression |
| `fixture:dcbus` | `tests/fixtures/dcbus.json` | PFC hold, battery catch, CPL, PFC current limit |
| `fixture:hybrid` | `tests/fixtures/hybrid.json` | AC/DC bridge: breaker trip to UV shutdown to battery catch |
| `fixture:bess_soc` | `tests/fixtures/bess_soc.json` | charge then discharge ride-through |
| `fixture:grid_export` | `tests/fixtures/grid_export.json` | named DC bus + reverse PFC grid export |
| `fixture:gfm_bess` | `tests/fixtures/gfm_bess.json` | GFM GFL DC port + named bus + SOC |
| `fixture:dcdc_charger` | `tests/fixtures/dcdc_charger.json` | DC/DC CC onto PFC-held 380 V bus |
| `fixture:pv_mppt` | `tests/fixtures/pv_mppt.json` | PV under cloud charges battery |
| `fixture:pq_piline` | `tests/fixtures/pq_piline.json` | PI line into PQ load sag |
| `fixture:central_ups` | `examples/central_ups.json` | UPS trip blackout + 360 V battery catch + IT ride-through |
| `fixture:central_ups_sag` | `examples/central_ups_sag.json` | sag ~24% retained + DC handoff + IT >95% (case-study numbers) |

| `example:ieee39bus` | `examples/ieee39bus.json` | 147-block system: PF converges, all 39 buses inside 0.9 to 1.1 pu, all 10 machines on nominal after an undisturbed PF-initialized run |
| `example:radial_feeder` | `examples/radial_feeder.json` | selectivity: the tripped lateral drops to ~0 V, the other two stay within 10% of pre-trip |
| `example:single_phase_lateral` | `examples/single_phase_lateral.json` | PF refuses the tap (documented behaviour); only the tapped phase sags; a lateral fault collapses the 240 V service while A and C ride through |
| `example:single_phase_gfm_lateral` | `examples/single_phase_gfm_lateral.json` | single-phase inverter is present on phase B only and its PI converges onto the 4 kW setpoint within 2% |

The last four are **integration guards, not analytical checks**: they assert
the one behaviour each example is shipped to demonstrate, so that a solver or
example change cannot silently break the storefront. They deliberately do not
gate on incidental decimals. The `single_phase_gfm_lateral` per-phase current
unbalance is a case in point: it is real but is a ~0.03% effect, so it is
printed rather than gated, because writing this guard showed that the sign of
that ordering depends on where the RMS window falls.

Every RMS window in these four is an **integer number of cycles**. This is not
a stylistic preference: a 2.7-cycle window on `single_phase_lateral` reported
the tapped phase as the highest of the three and changed which phase looked
sagged from one window to the next, which is exactly the failure mode the
integer-cycle rule exists to prevent.

The remaining large `examples/` (ieee9bus, syncgen_droop) are covered by their
own entries above; the two PSS/E load-flow imports are checked against their
source cases' own bus voltages rather than against an analytical reference.

## Tolerance rationale

Tolerances fall into three bands, and the band a check is in is the review
signal for any future loosening:

- **Sub-1% / exact (0.00%, 0.01%, 1e-9 V)**: linear circuitry against an exact
  phasor or a node-identity property. Anything above sub-1% here is a real
  regression, not numerical noise.
- **A few percent (1 to 5%)**: checks that extract a phasor from a settling
  time-domain waveform or depend on an RMS/quarter-cycle measurement window.
  The slack is measurement, not physics. Q tolerances (pq 8%, wt4 6%) are
  wider because the quarter-cycle shift leaks a little real power into the
  reactive estimate when P >> Q.
- **10%+ / structural (relay curve window, gfm limiter 10%, >50x suppression)**:
  either a control-loop convergence target with deliberate design headroom
  (the GFM limiter holds ~2% high by design, SPEC §2) or a binary structural
  property (suppression ratio, distinct poles). These should not be tightened
  without re-reading the SPEC §2 derivation they encode.

## Remaining work

The **reference-tool** class is not yet present for any block, which is the
last piece before item 9 can be struck from SPEC §5. The scoreboard above ranks
where it would matter most; the three sharpest cases are the
saturable-transformer inrush transient, the MOV clamp dynamics, and the GFM
limiter's EMF-backoff trajectory, because for each of those no closed form
exists and the current analytical check is the same steady-state fact the
solver converges to.

**How to contribute one.** Pick a block from the High row, build the equivalent
case in your tool, and send the waveform CSV plus enough of the case to
reproduce it. It does not need to be exhaustive: one disturbance, one trace,
and the parameters is a real result. Open an issue using the
*Block validation report* template. A cross-check that **disagrees** with
OpenEMT is more valuable than one that agrees, and will be published either
way: the point of this file is to be accurate about what is known, not
flattering.

The independent-solver helper (`tests/reference/phasor.js`) currently backs
two checks (pi-line, demo cross-check). Pointing more multi-node checks at
it, instead of their hand-rolled closed forms, is incremental hardening, not
a gap.