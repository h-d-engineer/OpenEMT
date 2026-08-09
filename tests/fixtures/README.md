# Test fixtures

Regression circuits loaded directly by `smoke_test.js` (run from the repo
root: `node smoke_test.js`). These started life as per-block demo examples
during development and were moved here on 2026-07-16 so `examples/` stays a
curated set; the test suite asserts against their exact block IDs, wiring,
and parameters.

**Do not edit these files casually**: any change to a block ID, probe, or
parameter can break an assertion. Check `smoke_test.js` first. They are still
ordinary schematics and can be opened in the app with the **Load** button;
they double as minimal working demos of the block features listed below.

| File | Mode | What it exercises |
|---|---|---|
| [`bess_soc.json`](bess_soc.json) | 1-ph | Battery SOC on a DC bus: PFC charges the battery for 50 ms, grid lost, battery discharges into a constant-power load (SOC up, then down). |
| [`dcbus.json`](dcbus.json) | 1-ph | DC rack backup: PFC holds a 380 V bus feeding a 10 kW CPL; grid lost at 60 ms, battery DC/DC catches the bus at 360 V. |
| [`dcdc_charger.json`](dcdc_charger.json) | 3-ph | Dedicated DC/DC converter in CC mode: battery discharges at its native 48 V onto a 380 V bus at a fixed set-point current. |
| [`gfm_bess.json`](gfm_bess.json) | **3-ph only** | GFM inverter DC port + grid-following mode: battery on the DC port, inverter dispatches 5 kW / 1 kvar into a stiff grid. |
| [`grid_export.json`](grid_export.json) | 3-ph | Battery-to-grid export: battery holds a named DC bus above a reversed PFC's setpoint; PFC exports to the AC grid at unity pf. |
| [`hybrid.json`](hybrid.json) | 3-ph | Hybrid AC/DC in one run: grid, breaker (per-pole current-zero clearing), PFC bridge, DC bus, battery catch. Predates the Bus block (documented flow-arrow limitation). |
| [`pq_piline.json`](pq_piline.json) | 1-ph or 3-ph | PI-equivalent (RLC) line into a PQ (constant-power) load: realistic bus sag while the load holds setpoint power. |
| [`pv_mppt.json`](pv_mppt.json) | 1-ph or 3-ph | PV panel with embedded P&O MPPT under partial cloud (G=800) charging a battery: Vop hunts near Vmpp. |

## Importer fixture

Three hand-written, IP-clean PSS/E RAW cases feed the importer regression in
`api/test_api.js` (not `smoke_test.js`). Do not commit any vendor-distributed RAW
file here; keep these synthetic. Editing either will break assertions.

[`psse_3bus.raw`](psse_3bus.raw) (REV 33) is the happy path: a slack + PV + PQ
bus set, a load, one branch, one 138/13.8 kV 2-winding transformer, and both a
capacitive and an inductive fixed shunt. Asserts the parsed record counts and
that the converted circuit **power-flows** with the slack/PV buses landing on
their RAW setpoints and the 13.8 kV bus behind the transformer at ~1.0 pu.

[`psse_features.raw`](psse_features.raw) (REV 33) covers the record variants the
first one does not reach, each asserted against a hand-computed value: a **CW=2**
transformer (winding data in kV rather than pu of bus base, the case that
silently squares the turns ratio if `CW` is ignored), a **3-winding** transformer
exercising the star/T conversion, a **ZIP load** (IP/IQ + YP/YQ alongside PL/QL),
a **switched shunt** imported at `BINIT` via the pre-v35 field-layout fallback,
and a **fixed shunt with both G and B** mapping to a parallel RLC. Since
2026-07-23 it also asserts that the case **power-flows**: `solvePowerFlow` gained
the `xfmr3w` star stamp, so the slack bus holds its RAW setpoint, the tertiary
bus is energized through the star arm, and the delta tertiary (ANG3=30, imported
as Yy0d11) leads winding 2 by 30 degrees.

[`psse_rev36.raw`](psse_rev36.raw) (REV 36, added 2026-07-24) is the only fixture
carrying `@!` header-comment lines, and it exists to hold the **field lookup by
name** honest. REV 34 inserted `NREG` after `IREG` in the generator record, so
`MBASE`, `ZR`, `ZX`, `STAT` and `PT` all sit one field later than they do in the
REV 33 layout the other two fixtures use. Read positionally, a v34+ file yields a
machine resistance around 100 pu instead of 0.004, the wrong machine rating, and
`GTAP` where `STAT` belongs, which imports an out-of-service generator as if it
were running. This case asserts the corrected `MBASE`/`Ra`/`Ld` against
hand-computed values, that both the out-of-service generator and the
out-of-service branch are dropped, and that the case power-flows. Keep
`psse_3bus.raw` free of `@!` lines: it is what guards the positional fallback.
