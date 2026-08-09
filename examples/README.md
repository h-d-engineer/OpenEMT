# Examples

Each file is a schematic you can load with the **Load** button in the toolbar.
Every entry below lists which phase mode to run it in. `central_ups.json`,
`central_ups_sag.json`, `showcase.json`, and `syncgen_droop.json` **require**
3-ph mode — the GFM inverter's and synchronous generator's controllers both
measure 3-phase p/q and the solver refuses to run them in 1-ph. The other
"3-ph" entries solve fine in 1-ph too, but were designed/verified in 3-ph (a
few rely on per-phase breaker/fault behavior or 3-phase power measurement
that isn't meaningful in 1-ph). See the main [README](../README.md) for what
each block does; this file is just a one-line-per-example index.

**Run settings travel with the file.** Every example carries its own duration,
time step, phase mode, and "Init from PF" setting, so loading one and pressing
**Run** gives the intended study without hunting for the right duration. Earlier
versions of this page told you to set a duration by hand for each case; that is
no longer needed, and the values in the files supersede any duration mentioned
in the descriptions below. Change them freely once loaded.

Most examples also ship with **Init from PF** on: the run starts from the solved
power-flow operating point rather than energising a dead network, which is why
several of them need far less run time than they used to.

This directory is the curated example set. The smaller per-block demo
circuits that used to live here are regression fixtures loaded by
`smoke_test.js` and now live in [`tests/fixtures/`](../tests/fixtures/):
still loadable with the Load button, see that directory's README for the
list and run modes.

| File | Mode | What it shows |
|---|---|---|
| [`central_ups.json`](central_ups.json) | **3-ph only** | Centralized-UPS data center (topology follows the double-conversion central-UPS arrangement described in PNNL-38817, `DML_DC2_Central_UPS`): 2.4 kV utility → main breaker → 8.66:1 service transformer → named 480 V switchgear bus carrying chiller-pump / fan / site-support loads plus a double-conversion UPS — PFC rectifier holding a 380 V DC link, battery on the link, GFM inverter re-forming 277 V for a ~10 kW IT load. The utility trips at 150 ms (rectifier drops with it, per its grid-lost protection), the bus and cooling loads black out, the battery catches the DC link at 360 V, and the IT load rides through the whole event without a dent — the saved plots show exactly that story. |
| [`central_ups_sag.json`](central_ups_sag.json) | **3-ph only** | Same facility as `central_ups.json`, but the disturbance is a physics-driven **grid fault** instead of a scripted outage: a 0.3 Ω 3-phase fault on the 2.4 kV feeder (200–300 ms) sags the 480 V bus to ~24% of nominal, which trips the PFC rectifier's own undervoltage protection — the battery catches the DC link at 360 V and the IT load never drops below ~99.7% of nominal. Guarded numerically by a smoke-test fixture so the case study cannot silently drift. |
| [`ieee39bus.json`](ieee39bus.json) | **3-ph only** | The standard IEEE 39-bus New England system (10 generators, 12 transformers, 34 lines, 21 loads — 147 blocks total). Built from verified primary sources (MATPOWER `case39.m` for topology/dispatch, ANDES's GENROU sheet for generator H/Ra/Xd'), not reconstructed from memory. Loads are modeled as constant-impedance (`rlc` with R only, sized at nominal voltage; originally the standalone R block, since removed) rather than constant-power (`pq`) — at this system's per-phase power levels, `pq`'s cold-start behavior drove several buses to multi-million-volt divergence within the first cycle (see the 2026-07-15 DECISIONS.md entry); reactive load is therefore not represented, only real power. All 39 bus voltages settle between 164.5 kV and 199 kV phase (nominal 199.2 kV) and all 10 generator frequencies within 0.15 Hz of 60 Hz. Second large-scale stress test after `ieee9bus.json`; largest model in this project to date. |
| [`iec60909_hv_network.json`](iec60909_hv_network.json) | **Load flow** (3-ph) | The IEC 60909-4 high-voltage test network (Figure 16), imported from a PSS/E RAW case: 11 buses spanning 380 / 110 / 30 / 21 / 10 kV, 8 machines, and **two three-winding transformers**. Two firsts for this directory: the only **50 Hz** example, and the only one using the `xfmr3w` block, so it is the working demonstration of the 3-winding star stamp added in July 2026. Press **Power flow**: Newton-Raphson converges in 3 iterations and the bus magnitudes land within **0.001 pu** of the voltages the source case itself carries. Bus 7 carries three motors on one bus, each written with a fixed reactive output (`QT` equals `QB` in the RAW), so it is the example of a bus that starts as PQ and of several machines aggregating onto one bus. This is a **load-flow example, not an EMT study** (see the note below the table): a RAW file has no dynamic data, so the machine H and governor droop are the importer's generic placeholders and a transient run from this file would not mean anything without replacing them. Note also that two of its transformers have a phase shift the importer does not model, so bus angles are only meaningful within a voltage level. |
| [`ieee_harmonics_14bus.json`](ieee_harmonics_14bus.json) | **Load flow** (3-ph) | The IEEE harmonics-modeling task force test system (an IEEE 14-bus variant with two extra filter buses, 16 in total), imported from a PSS/E RAW case: 3 machines, 15 lines, 7 transformers, 11 loads, and a shunt capacitor bank. Newton-Raphson converges in 7 iterations. It is the demonstration case for **generator reactive limits**: both of its machines sit exactly on their limits in the source case (`QG` equals `QT` in the RAW), so the solve converts those buses to PQ and pins them at 50.000 and 44.200 Mvar. It is also the project's **closest agreement with a vendor solution**: every one of its 16 buses reproduces the magnitude AND angle the source case carries, to the five decimals the RAW writes them in. Getting there took the July 2026 vector-group fix (BUS 8 and BUS 302 are the only two buses fed by a delta-wye unit, and the delta had been landing on the wrong winding, which flipped the 30 deg shift and divided that transformer's impedance by 3); the residual ~0.001 pu spread on the other 14 buses turned out to be that same error feeding back through the network. Same load-flow-only caveat as the entry above. |
| [`ieee9bus.json`](ieee9bus.json) | **3-ph only** | The standard IEEE/WSCC 9-bus, 3-machine test system (Anderson-Fouad dynamic data): 3 synchronous generators (247.5/192/128 MVA) through step-up transformers into a 230 kV, 6-bus meshed network carrying 315 MW / 115 Mvar of load. Network R/L/C and transformer leakage are converted from the published per-unit data on a 100 MVA base; governor droop, damping, and AVR droop aren't part of that dataset and are engineering estimates scaled to each machine's rating (see the file's block params, not literal published values). Includes a scripted disturbance: one breaker on G1's (the largest, 247.5 MVA) link to its step-up transformer opens at 200 ms and recloses at 250 ms, using the multi-operation breaker (`nOps`). Earlier versions needed two breakers in parallel here because a single breaker latched open and could not reclose; `nOps` removed that workaround and the second breaker has been deleted. The case ships with "Init from PF" on, which starts it at the power-flow operating point instead of energising a dead network, so the outage no longer has to wait out a multi-second cold-start swing: 500 ms is enough for the whole event. Given the system's inertia, a 50 ms outage produces only a small, physically-correct excursion (frequency stays within ~0.03 Hz, Bus 4 voltage within ~0.5%) — lengthen `topen`/`tclose` on breaker 34 for a more dramatic swing if wanted. First large-scale (34-block, meshed-topology) stress test of the solver and layout engine. |
| [`radial_feeder.json`](radial_feeder.json) | 1-ph or 3-ph | A 2.4 kV feeder fans out through a **Bus** to three step-down transformers (10:1) and their loads; one feeder's breaker opens at 50 ms, dropping just that load while the other two ride through — a plain linear distribution study (no converters), good for seeing Bus fan-out, transformers, and a breaker trip together at a slightly larger scale. |
| [`single_phase_gfm_lateral.json`](single_phase_gfm_lateral.json) | **3-ph only** | A single-phase grid-following **GFM inverter** on a **phase-B** lateral (think rooftop solar or a battery inverter on one leg of a 277 V service), dispatching a 4 kW setpoint next to a balanced 3-phase service load. The 200 ms run gives the grid-following PI a few hundred milliseconds to settle. The inverter delivers its 4 kW on phase B alone, which lifts phase B's service-load current slightly above A and C (15.16 vs 15.13 A): genuine single-phase unbalance from distributed generation, which no earlier block could produce. Probe #6 is the 277 V service bus, #14 the lateral. The inverter's DC port is left unwired here (idealized source); wire it to a battery-held bus for a real energy-limited study. Its AC current limiter is 3-phase only, so leave I ac max at 0. |
| [`single_phase_lateral.json`](single_phase_lateral.json) | **3-ph only** | A single-phase lateral tapped off **phase B** of a 2.4 kV feeder: tap -> lateral line -> breaker -> 2400/240 V pole-top transformer -> a 240 V service load, alongside a balanced 3-phase feeder load. The point is the unbalance it creates for free: at rest the feeder reads 2383 / 2370 / 2383 V (only the tapped phase sags, and the two untapped phases stay identical), and the 240 V service sits at 235 V under load. A 0.5 ohm fault on the lateral from 60 to 100 ms then collapses just that phase while A and C ride through untouched, something no combination of the older blocks could represent: without a tap every phase carried the same elements. Probe #7 is the feeder bus, probe #16 the 240 V secondary; the lateral's signals appear as ONE trace labeled B, not three. Note `solvePowerFlow()` refuses any circuit with a tap (positive sequence cannot represent an unbalanced lateral); run the EMT solve directly. |
| [`showcase.json`](showcase.json) | **3-ph only** | Exercises every AC block in one circuit: source → breaker (closes 10 ms) → coupled 3-ph line → 2:1 transformer → load + filter cap, with a GFM droop inverter dispatching 5 kW into the secondary bus and a phase-A-to-ground fault at 55 ms that self-clears at 85 ms. Probes on primary and secondary buses. Open with the **Load** button. |
| [`syncgen_droop.json`](syncgen_droop.json) | **3-ph only** | Two classical synchronous generators (15 kW / 10 kW mechanical, different ratings/droop) share a base load through a **Bus**; a breaker adds a second load at 2000 ms, and the case runs 5 s because the natural swing period is around half a second, far slower than the other examples. Watch both machines' `f` signals dip together and settle to a new shared frequency in proportion to governor droop — the first multi-generator example, and the only block with genuine inertial (not algebraic-droop) frequency dynamics. |

## Load-flow examples

`iec60909_hv_network.json` and `ieee_harmonics_14bus.json` are a different kind
of entry from the rest: they are **steady-state load-flow cases**, meant for the
**Power flow** button, not for Run. Both were produced by importing a PSS/E RAW
case (File to Import) and saving the result, which is also the shortest
demonstration of what the importer does.

They are not EMT studies, deliberately, and both of them demonstrate that
concretely if you press **Run**:

- `ieee_harmonics_14bus.json` **cannot** run in EMT at all. It stops with a
  singular-matrix error naming BUS 8 and transformer #67. Two of its units are
  `Yd11`, wye primary into a **delta secondary**, and a delta has no neutral: if
  nothing else on that side reaches ground, the winding set genuinely has no
  voltage reference and the system has no unique solution. The power flow is
  unaffected because positive-sequence has no such node. Modelling an
  ungrounded/isolated secondary needs modified nodal analysis, which this solver
  does not do yet (SPEC section 5 item 4).
- `iec60909_hv_network.json` runs, but **diverges at about 630 ms**. It stops
  with a divergence error rather than returning nonsense. This is the
  placeholder-dynamics problem below made visible: eight machines with invented
  inertia and droop on a real network is not a stable dynamic model. Runs
  shorter than that complete normally and still mean nothing dynamically.

A RAW file carries no dynamic data at
all, so the importer fills in generic inertia and governor droop and says so in
a warning; a transient run started from those placeholders would produce a
plausible-looking answer that means nothing. Their loads are also constant-power
(`pq`), which at transmission power levels hits the cold-start divergence
documented for `ieee39bus.json`. Turning either into a real EMT example means
supplying per-machine dynamics and reconsidering the load model, at which point
it stops being a faithful import. Left as load flow, they are honest and they
are checked: `smoke_test.js` asserts the bus voltages of both against the source
cases.

Note the ceiling while you are here. Both of these are small. The genuinely
large cases in the same vendor example set (1648 and 7917 buses) import in
milliseconds and then do not power-flow in any usable time, because the Ybus and
the Jacobian are both dense. That is the "Sparse solver" item in `IDEAS.md`, and
it is what stands between this importer and a utility-scale case.

## Data sources and attribution

The example schematics are original to this project, but several are
parameterized from published test-system data. Parameter values (impedances,
ratings, dispatch, inertia constants) are factual engineering data; no source
code from any of the projects below is included in this repository.

- `ieee9bus.json`: the classic WSCC 9-bus, 3-machine test system, with dynamic
  data from P. M. Anderson and A. A. Fouad, *Power System Control and
  Stability* (IEEE Press). Per-unit network data converted to physical units on
  a 100 MVA base; governor/AVR settings are this project's engineering
  estimates, as noted in the table row.
- `ieee39bus.json`: topology, branch data, and dispatch from
  [MATPOWER](https://matpower.org)'s `case39.m` (MATPOWER is BSD-licensed; the
  underlying New England 39-bus dataset traces to T. Athay, R. Podmore, and
  S. Virmani, "A Practical Method for the Direct Analysis of Transient
  Stability," 1979, and M. A. Pai, *Energy Function Analysis for Power System
  Stability*). Generator dynamic parameters (H, Ra, Xd') from
  [ANDES](https://github.com/CURENT/andes)'s `ieee39_full.xlsx` GENROU sheet.
- `iec60909_hv_network.json`: the high-voltage a.c. test network published as
  Figure 16 of **IEC 60909-4** ("Short-circuit currents in three-phase a.c.
  systems", examples for the calculation of short-circuit currents). Network
  data only: impedances, ratings and dispatch are factual engineering data. The
  schematic, block set and layout are this project's.
- `ieee_harmonics_14bus.json`: the test system published by the **IEEE Task
  Force on Harmonics Modeling and Simulation**, "Test Systems for Harmonics
  Modeling and Simulation", *IEEE Transactions on Power Delivery*, Vol. 4,
  No. 2, April 1999. Same terms as above.
- Both of the two entries above were produced by reading a PSS/E `.raw` encoding
  of the published network with this project's own importer (`src/import.js`).
  No vendor file is included in this repository, and none should be: the
  regression fixtures in `tests/fixtures/` are hand-written.
- `central_ups.json` / `central_ups_sag.json`: facility topology modeled after
  the `DML_DC2_Central_UPS` PSCAD example described in PNNL report PNNL-38817
  (rebuilt on this project's block set, not converted from the PSCAD file).

## Notes on maintenance

- Three examples were removed as no longer working: `DC_CENTRAL_UPS.json`
  threw a hard solver error (AC and DC sides tied directly together without
  going through a PFC/GFM port); `DC_CENTRAL_UPS_1.json` solved without error
  but its transformer ratios collapsed almost every bus to ~0 V, so it never
  actually demonstrated anything; `Hybrid_Organized.json` was a redundant
  reorganization of `hybrid.json` onto **Bus** blocks — `hybrid.json` itself
  is left untouched (`smoke_test.js` asserts against its exact probe/id
  layout; it now lives in `tests/fixtures/`), so this was dropped rather than
  promoted. `central_ups.json` is the working replacement for the two removed
  UPS files — rebuilt from the PNNL topology on the current block set instead
  of patched. On 2026-07-16 the eight per-block demo circuits were moved to
  `tests/fixtures/` and this directory was reduced to the curated set (see
  that date's DECISIONS.md entry).
- New cases start in `studies/` (gitignored scratch space; create it if it
  does not exist). Promote a case here only when it demonstrates something no
  existing example shows: run it in its intended phase mode(s), check
  `node ../smoke_test.js` doesn't regress, add a row to the table above, and
  ideally add a smoke-test assertion for it. If a scratch case exposes a
  solver bug, distill the minimal circuit into `tests/fixtures/` with an
  assertion instead of promoting the whole case.
- If you change an existing example's probe/bus IDs or structure, check
  `smoke_test.js` first — it loads several files from here and from
  `tests/fixtures/` directly and asserts against specific probe/id positions.
- Removals get a dated `DECISIONS.md` entry.
