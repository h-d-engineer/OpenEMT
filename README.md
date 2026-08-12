# OpenEMT

[![CI](https://github.com/h-d-engineer/OpenEMT/actions/workflows/ci.yml/badge.svg)](https://github.com/h-d-engineer/OpenEMT/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40openemt%2Fopenemt.svg)](https://www.npmjs.com/package/@openemt/openemt)
[![Licence: AGPL v3](https://img.shields.io/badge/licence-AGPL--3.0--only-blue.svg)](LICENSE)
[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.21857083.svg)](https://doi.org/10.5281/zenodo.21857083)

**The electromagnetic transient simulator built for AI agents.**

OpenEMT is an EMT (electromagnetic transient) simulator for power systems: an
EMTP-style trapezoidal nodal solver with a positive-sequence power flow, a
36-block catalog spanning lines, transformers, machines, converters and
protection, breaker switching events, and single-phase, 3-phase and DC studies.

What makes it different is that the solver core is **pure and deterministic,
and has three coequal frontends**. Humans get a drag-and-drop canvas in a
single self-contained HTML file, with no install and no server. Scripts and CI
get a CLI. Agents get an MCP server whose tool schemas are generated from the
block catalog itself, so an agent always sees the true parameter space rather
than a hand-maintained summary of it. All three call the same `simulate()` and
`solvePowerFlow()`. An agent can enumerate the physics catalog, build a
circuit, solve it, and query results by stable block ID: the same loop an
engineer runs in the canvas, not a wrapper bolted onto one.

Maturity: **beta, v0.1.1.** The block models are averaged and simplified by
design (the concept-validation layer that runs *before* anyone opens PSCAD),
every block is checked against an analytical or independent-solver reference,
and every known limitation is written down. Read
[`VALIDATION.md`](VALIDATION.md) for what has been checked against what, and
[SPEC.md](SPEC.md) section 7 for what this tool does not do.

> **Provided AS IS, without warranty of any kind** (see [LICENSE](LICENSE)
> sections 15 to 16). Results are **not certified for engineering decisions**.
> An external reference-tool cross-check is still open (SPEC.md section 5,
> item 9), so treat OpenEMT as a concept-validation and teaching tool, not as
> a system of record.

![The OpenEMT canvas running examples/central_ups.json: a data-center UPS
schematic above three result plots](docs/screenshot.png)

*[`examples/central_ups.json`](examples/central_ups.json) mid-study. The
utility breaker opens at 150 ms: the 480 V switchgear bus (orange) collapses
while the UPS output (purple) keeps swinging, the DC link hands off from the
rectifier's 380 V to the battery's 360 V, and the battery's state of charge
starts draining. Everything on screen came from one **Load** and one **Run**.*

## Quick start

**Humans.** Try it right now at
**[h-d-engineer.github.io/OpenEMT](https://h-d-engineer.github.io/OpenEMT/)**,
or download `index.html` and double-click it: no install, no server, works
offline, and it is the same file either way. Every example is built into that
one file, so pick one from the **Examples** menu with nothing to download, or
open a link straight to a solved case:

**[IEEE 39-bus](https://h-d-engineer.github.io/OpenEMT/?example=ieee39bus&pf=1&run=1)**
&middot;
**[IEEE 9-bus](https://h-d-engineer.github.io/OpenEMT/?example=ieee9bus&pf=1&run=1)**
&middot;
**[UPS on a utility trip](https://h-d-engineer.github.io/OpenEMT/?example=central_ups&pf=1&run=1)**
&middot;
[the rest](examples/README.md)

Those links take `?example=<name>` with optional `&pf=1` and `&run=1`. The app
makes no network requests of any kind, so all of it works from `file://` too.

**Agents and scripts.** Node 18+, nothing to clone. One command, start to
finish:

```bash
npx @openemt/openemt query central_ups --block 15 --signal Vrms --pf --tail
```

That answers the question the `central_ups` example exists to ask: the utility
trips at 150 ms and the 480 V switchgear bus (block 4) collapses to zero, while
the UPS output (block 15) still reads 277 V at the end of the run.

For more than a one-off, install once and drop the prefix. The package is
`@openemt/openemt`; the command it installs is `openemt`:

```bash
npm install -g @openemt/openemt

openemt examples                      # the shipped example circuits
openemt catalog                       # every block type and its parameters
openemt pf ieee9bus                   # steady-state power flow
openemt run central_ups --pf          # EMT study from that operating point
openemt --help                        # every command
```

Every command takes either the name of a shipped example, as listed by
`openemt examples`, or a path to a circuit `.json` of your own. Run settings
(duration, time step, phase mode) travel inside the circuit file, so a shipped
example runs its intended study without being told how long to run.

**From a clone** instead, to contribute or to run the test suites:

```bash
npm install                                          # the API layer's 2 deps
node api/cli.js run examples/central_ups.json --pf
```

Only the API layer has dependencies; the browser build has none.

## Using the canvas

The rest of this section is the user manual for the browser frontend.

The solver runs in a Web Worker (built from an inline Blob, so it's still one file) and
streams plot data back as it computes — long `Duration (ms)` runs animate
progressively instead of freezing the tab, and can be cancelled with Stop.

The run toolbar has three time controls, PSCAD-style: **Duration** (total
simulated time, ms), **Time step** (the solver's internal trapezoidal step,
µs — smaller is more accurate but slower; defaults to 50 µs), and **Plot
step** (how finely output is kept for plotting, µs — leave blank for
automatic decimation that keeps every solver sample on normal runs and
only thins very long runs to cap storage, or set it explicitly for a
fixed sample spacing). Zoomed-out plots downsample per pixel by min/max
bucketing so narrow spikes still show at their true amplitude.

The block palette is grouped into four category dropdowns — **Sources/Loads**,
**Passive**, **Power Electronics**, **Protection/Meas** — instead of one long
row of buttons; click a category to flip open a flyout of its blocks, click a
block to drop it on the canvas (the flyout stays open so you can drop several
of the same kind in a row), and click elsewhere to close it. Each block also
gets a small colored corner tick on the canvas matching its palette category,
so a dense schematic is scannable by category at a glance.

After a run, small animated markers march along each wire showing which way
power is actually flowing — into a load, out of a source, or reversing
direction on a battery as it switches between charging and discharging. AC
wires show **both** components independently, since a real AC branch carries
them simultaneously and they can even point opposite ways: a blue half-arrow
on the **top** of the wire for active power, a yellow half-arrow on the
**bottom** for reactive power — the two ride the same wire as one line with
two independent halves rather than separate marker trains. A **Flow arrows**
checkbox in the toolbar turns the whole thing on or off (it was called "Power
flow" before that name was given to the steady-state solve below). Only wires with an
unambiguous reading get a marker: a pure measurement probe never shows one,
and neither does a wire on a node shared by several devices with no explicit
Bus block (splitting that current per-wire isn't attempted).

Blocks draw as standard IEC-style schematic symbols (AC-source circle, inductor
coil, capacitor plates, two-circle transformer, breaker blade, converter
squares…), so the canvas reads like a real single-line diagram.

Canvas editing: scroll or use the +/− buttons to zoom, drag empty canvas to
pan, select a block and press `R` (or click the ↻ button) to rotate it 90°,
or hit the ⛶ button to take the canvas fullscreen (Esc exits). Select several
blocks at once by shift/ctrl-clicking each one, or shift/ctrl-dragging a
rectangle over them — then drag any of them to move the whole group, press
`R` to rotate all of them, or `Delete`/`Backspace` (or the Delete button) to
remove them together. `Escape` clears the selection. **Undo/Redo** buttons
(or `Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y`) cover every schematic edit —
adding, deleting, dragging, rotating, rewiring, editing a parameter,
clearing the canvas, running auto-layout, or loading a file over your
current work. A **project-name badge** above the canvas (next to the status
line) always names the circuit you're looking at — `Demo` on startup, the
file name after a Load, `Untitled` after Clear — and grows a `•` the moment
you edit anything, clearing again when you Save (which also downloads under
that name instead of a generic `circuit.json`).
**Finding a block.** On a large model, hunting for one component by eye stops
being practical: IEEE39 is 147 blocks spread wide enough that fitting it on
screen makes the symbols unreadable. Press `/` (or click the **Find block**
box next to the status line) and type a name, a block type, or an id: `Bus 14`,
`xfmr`, `#201`. Matching is substring and case insensitive, every match is
haloed on the canvas so you can see where they all are, and the counter reads
`3/12`. `Up`/`Down` walks the matches with the camera following, `Enter`
selects the one you are on and opens its parameter rail (`Enter` again steps to
the next), and `Esc` leaves the search and puts the view back where it was
unless you already committed to a match. Browsing never changes the circuit or
the selection, so an abandoned search costs nothing. `Ctrl+F` is left alone
deliberately: it belongs to the browser, and it cannot see into the canvas
anyway, since the schematic is SVG drawn at world coordinates rather than page
text.

For nodes with more than two connections, drop a **Bus** block — a thick,
nameable junction bar with one or more taps — instead of routing many wires
to one point. Every bus is also a measurement point: its node voltage shows
up automatically in the plot Signals picker under the bus's name (AC or DC
detected from the circuit), so you rarely need a separate probe on a bus.

As your circuit grows, use the **Layout** button to auto-arrange blocks in a
left-to-right or top-to-bottom hierarchy (power source at top/left, branches
flowing outward with even spacing) — a quick way to declutter before manual
fine-tuning. In top-to-bottom mode, components rotate to run vertically with
the flow (a bus stays a horizontal bar; ground/probe/fault keep their natural
orientation), so wires between them run as clean straight lines instead of
sideways elbows.

Plots are fully customizable: add/rename/remove plot cards, and use each plot's
**Signals** button to pick which probe voltages and branch currents (per phase,
A/B/C — a DC node shows one "DC" signal instead of three duplicates) appear
from a grouped, filterable tree. Each signal can go on the plot's left or right
y-axis, so signals with very different scales (a 12 kV bus and a 480 V bus, or
a voltage and a current) stay legible together.

Every probe voltage and branch current also offers an **RMS** trace (one
fundamental cycle, sliding window), and every branch element offers **active
(P) and reactive (Q) power**, right alongside its current in the picker — true
power needs a voltage and current pair, which only a branch has (a bare probe
doesn't have an associated current). Unlike voltage/current, P and Q on a
genuine 3-phase branch are a single **total 3-phase value**, not three A/B/C
entries — that's how 3-phase power is normally quoted, and per-phase current
is still there if you need to check for imbalance. A branch that only exists
on one phase (a single-phase fault, say) still reports its one real reading
labeled by that phase.

Each branch offers **two distinct power quantities**, because they answer
different questions: plain **P/Q** (`W`/`VAR`) is what the element itself
**absorbs** — a closed breaker reads ~0 and a line only its own I²R loss,
which is correct but surprising if you expected to see the feeder's power
there. **P/Q in / out** (`W in`/`W out`) is the power actually **flowing
through** the branch, measured at terminal 0 (in) and terminal 1 (out):
along a series chain, one element's "out" equals the next one's "in", and
in − out = absorbed exactly. A terminal wired to ground reads 0 through
power (no power flows through a node at 0 V), so read a source's delivered
power from its "out" side. Through power isn't offered on the PFC and DC/DC
converter blocks — their two sides carry different currents, so the series
in/out identity doesn't apply to them. Sign convention is the same for
**every** block, no exceptions: positive = **absorbing** power, negative =
**delivering** it — a discharging battery or a generating PV panel read
negative, same as any other source, and a charging battery reads positive,
same as any other load.

All plots share one zoomable time window, so zooming in on one lines up the
same window on every other plot — useful for correlating a voltage dip with
a current spike at the same instant. **Drag** on any plot to zoom into a time
range; **Shift+drag** to pan; **scroll** to zoom at the cursor; or use the
+/−/Reset controls above the plots. The y-axis auto-rescales to whatever's
currently visible.

## Power flow

Alongside the time-domain solver there is a **positive-sequence steady-state
power flow**. It answers a different question: instead of integrating the
network forward in time, it solves the algebraic operating point directly.

Press **Power flow** in the toolbar and every bus is annotated on the canvas
with its solved voltage magnitude (pu) and angle, colored green inside the
0.95 to 1.05 pu band and red outside it. The status line reports convergence,
total generation, the bus-voltage range, and how many buses fall outside the
band, which makes the canvas a quick voltage-screening view.

The more valuable use is **initialization**. Time-domain runs otherwise start
cold, with every machine at rotor angle 0, so a generator that needs a real
load angle to export its power has to swing into position; at a weak point of
interconnection it can swing past its pull-out and never synchronize at all.
With **Init from PF** checked (the default), Run solves the power flow first
and starts every machine at the operating point: correct rotor angle, internal
EMF, and filtered P/Q, with the governor and AVR centered so mechanical equals
electrical power at t = 0. The run then begins flat instead of swinging in.
On the IEEE 39-bus case the residual frequency movement over an undisturbed run
drops from about 110 mHz (cold) to about 3 mHz (initialized).

Generators and inverters carry two power-flow parameters in the inspector:
`pfType` (`slack`, `PV`, or `PQ`) and `Vset` (the scheduled terminal voltage in
volts; 0 means "use E0"). Exactly one machine should be the slack; if none is
marked, the largest machine is promoted automatically. Constant-impedance
elements (lines, transformers, caps, RLC loads) fold into the admittance
matrix, and AC PQ (and ZIP) load blocks are treated as P+Q injections.

Honest limits of the current MVP: it initializes **machine** states only, not
passive-element histories (line currents and cap voltages still start at zero),
so a brief electrical inrush over the first cycles remains even from a
power-flow start. The solve is Gauss-Seidel rather than Newton-Raphson, and
there is no reactive-limit enforcement, tap changing, or N-1 contingency
screening yet. See SPEC.md section 5.

## Driving it from an agent (MCP)

The solver core is exposed as an MCP server (`api/mcp-server.js`) with 14
tools, so an agent (Claude Code, Claude Desktop, Cursor, others) can enumerate
the block catalog, build a circuit, import a PSS/E case, run power flow and
time-domain simulations, and query results by block ID over the Model Context
Protocol. Two design rules make it usable rather than decorative: the tool
schemas are **generated from `DEFS`**, so the parameter space an agent sees is
the one the solver actually implements, and every result is addressed by
**stable block ID**, never by positional index, so an agent can edit a circuit
without invalidating the query it wrote earlier. The solver is deterministic,
so a run is reproducible from the circuit file alone.

Any MCP client can run the server straight from npm, with no clone and no
absolute paths to get wrong:

```json
{
  "mcpServers": {
    "openemt": {
      "command": "npx",
      "args": ["-y", "--package", "@openemt/openemt", "openemt-mcp"]
    }
  }
}
```

Working from a clone, Claude Code is zero-config instead: the repo ships a
`.mcp.json` at the root and you approve the one-time prompt on first use.
Prerequisites, exact snippets per client, and troubleshooting are in
[`docs/MCP.md`](docs/MCP.md).

## Development

```
src/blocks.js       block catalog + companion models       <- add new blocks here
src/solver.js       union-find, LU, time loop, events,
                    power flow + machine init              <- numerics
src/import.js       PSS/E RAW importer (DOM-free)
src/ui.js           canvas, wiring, plots, demo            <- browser frontend
src/shell.html      page shell + styles
build.py            assembles index.html from src/         (python3 build.py)

api/core.js         the OpenEMT class: the headless contract <- extend this
api/cli.js          thin CLI front over core.js
api/mcp-server.js   thin MCP front over core.js
api/test_api.js     regression guard for all three
```

`src/` is the single source of truth. It is plain global-scope script that
`build.py` concatenates into the one-file browser build, and that `api/core.js`
loads as text into a Node `vm` sandbox: same code, two hosts, no second copy of
the physics and no duplicated block list (the MCP tool schemas are generated
from `DEFS` at startup). There is deliberately only one headless loader; extend
`api/core.js` rather than adding another.

Read `SPEC.md` before changing anything: it contains the companion-model
derivations, solver invariants, and the roadmap. The intended workflow with a
local model (Claude Code + qwen or similar):

1. Point Claude Code at this folder.
2. Give it SPEC.md as context and a single roadmap item as the task
   (e.g. "implement the capacitor block per SPEC section 2").
3. After each change: `python3 build.py && node smoke_test.js && node api/test_api.js`
   must pass, and the build must leave `index.html` byte-identical if `src/` was
   not touched.
4. Physics that is not already derived in SPEC section 2 should be derived
   in a frontier-model session first, added to SPEC, then implemented locally.

## Examples

**[`examples/README.md`](examples/README.md) is the index**: one table row per
shipped example, with the run mode, what it demonstrates, and where its data
came from. Eleven curated cases ship in [`examples/`](examples/):

| | |
|---|---|
| `showcase` | every AC block in one circuit, plus a self-clearing phase-A fault |
| `central_ups`, `central_ups_sag` | a data-center UPS riding through a utility trip and, separately, a grid fault |
| `ieee9bus`, `ieee39bus` | the WSCC 9-bus and IEEE 39-bus New England benchmarks, from primary sources |
| `iec60909_hv_network`, `ieee_harmonics_14bus` | PSS/E RAW imports checked against the source cases' own bus voltages (load-flow only, deliberately) |
| `radial_feeder` | the gentlest starting point: a feeder, three transformers, one breaker trip |
| `single_phase_lateral`, `single_phase_gfm_lateral` | genuine single-phase unbalance on a tapped lateral |
| `syncgen_droop` | two synchronous machines sharing a load step by governor droop |

Run settings travel inside each file, so **Load** then **Run** gives the
intended study. Every case also loads headlessly:
`node api/cli.js run examples/showcase.json`.

The rest of this section is a tour of the **block library**, using the smaller
regression circuits in [`tests/fixtures/`](tests/fixtures/) as illustrations.
Those are loadable with the **Load** button too; they are the circuits
`smoke_test.js` asserts against, which is why each one exercises exactly one
idea.

`tests/fixtures/hybrid.json` — hybrid AC/DC study (3-ph mode): 277 V grid → breaker →
line feeds an AC load and, through the PFC bridge, a 380 V DC bus with a 10 kW
constant-power load. The breaker trips at 60 ms (per-pole current-zero
clearing), the PFC shuts down on undervoltage, and the battery catches the DC
bus at 360 V — one simulation across both domains.

`tests/fixtures/dcbus.json` — DC rack backup study (run in 1-ph mode): PFC rectifier
holds a 380 V bus feeding a 10 kW constant-power load; grid is lost at 60 ms
and the battery DC/DC catches the bus at its 360 V setpoint.

The battery is a full bidirectional store with state of charge: it discharges
to hold its V ref when the bus sags (and dies at SOC 0), and charges at up to
`I charge` whenever the bus sits above V ref (stopping at SOC 100) — plot the
SOC from the Signals picker. Capacity defaults to a deliberately tiny 0.02 Ah
so charge/discharge is visible on millisecond EMT timescales. The PFC gains a
`reverse` flag: set rev=1 and its V ref below the battery's, and it exports
battery power back into the AC grid at unity power factor — enough for simple
BESS charge/export studies from either a DC or an AC link.

`tests/fixtures/bess_soc.json` (run in 1-ph mode) — battery SOC demo on a DC link:
the PFC holds the bus and charges the battery (soc0 = 40%) for the first
50 ms, then the grid is lost and the battery discharges into the CPL —
watch SOC ramp up, then down, in the Signals picker.

`tests/fixtures/grid_export.json` (3-ph mode) — battery-to-grid export: a battery
(Vref 380 V) holds a named **Bus** on the DC link above the PFC's setpoint
(Vref 360 V, reverse = 1), so the PFC continuously exports the battery's
power to the AC grid at unity pf. The bus is auto-monitored (no probe
needed) and SOC drains as it discharges into the grid.

The **GFM inverter** is now a real AC/DC device, not just an idealized AC
source: its optional bottom DC+ terminal draws or delivers exactly the power
its AC side is measured to exchange, so wiring a battery there shows genuine
charge/discharge flow instead of free energy. It also has a `mode` switch —
**mode 0** (default) is the original grid-forming droop (sets its own
V/f, can island); **mode 1** is grid-following: it locks onto an existing
grid and PI-dispatches a fixed P0/Q0 setpoint instead of drooping away from
it. GFL mode's tracking speed and damping depend on the tie being reasonably
inductive (a well-filtered inverter, larger `Lf`, tracks faster and tighter
— see SPEC.md for the derivation); defaults are tuned conservative so it
won't misbehave out of the box.

`tests/fixtures/gfm_bess.json` (3-ph mode) — a battery wired to a GFM inverter's DC
port, with the inverter in grid-following mode dispatching 5 kW / 1 kvar into
a stiff grid: watch the GFM's DC current and the battery's SOC move together
as the setpoint is delivered.

The **Sync gen** block is a real rotating-machine model — a classical
synchronous generator (round rotor, constant transient EMF behind Ra + Xd'),
not another inverter-based source. Unlike the GFM inverter, whose frequency
is an algebraic function of filtered measured power (droop or PI), a sync
gen's frequency is a genuine **dynamic state**: its rotor is a spinning mass
with inertia (`H`), so after a disturbance it actually swings — a real
oscillation that decays over a few cycles, not an instant jump to a new
setpoint. A governor (`Kgov`, kW/Hz droop; 0 = fixed mechanical power, no
governor) adjusts mechanical power as frequency sags or rises, and multiple
machines on the same system automatically share a load in proportion to
their droop, exactly like real turbine governors — no coordination logic
needed, it falls straight out of the physics. An AVR (`mq`/`Q0`, same
Q-droop form as the GFM's) holds terminal voltage. Frequency (`f`) is
plotted automatically from the Signals picker — watching it dip and recover
after a load step is the actual point of this block. Classical model only:
no subtransient reactances, saturation, or exciter dynamics (see SPEC.md for
the full derivation and the numerical-stability checks behind the defaults).

`examples/syncgen_droop.json` (3-ph mode; the file carries its own 5 s run,
because the natural swing period here is around half a second)
— two sync gens (15 kW / 10 kW mechanical, different ratings and governor
droop) share a base load through a common **Bus**; a breaker adds a second,
larger load at 2000 ms. Watch both machines' `f` signals dip together and
settle to a new, slightly lower shared frequency as their governors pick up
the extra demand in proportion to droop — a textbook primary-frequency-
response demo, and the first example in this tool with more than one
generation source.

The **DC/DC** block is a dedicated bidirectional converter, separate from a
battery's own built-in regulation — the way industry actually controls
charge/discharge, letting a battery sit at its own native voltage while a
converter steps it to a bus at a different level. **mode 0 (CV)** PI-holds
its OUT terminal at a V ref; **mode 1 (CC)** dispatches a fixed current
directly (the classic constant-current charge/discharge pattern) — its IN
current is always the lossless power-balance consequence of whatever OUT is
doing. Either side needs a capacitor (or another regulating element) to
hold its voltage — a bare current source can't stabilize a node by itself.

`tests/fixtures/dcdc_charger.json` (3-ph mode) — a DC/DC converter in CC mode
discharges a battery at its own native 48 V onto a 380 V DC bus (held by a
reversible PFC/grid tie) at a fixed, controlled current: watch the battery's
higher current on its own 48 V side against the converter's smaller,
set-point current on the 380 V side, and its SOC drain accordingly.

The **PV array** block is a panel with its DC/DC converter and MPPT
controller embedded as one block, the way real solar installations are
built. It runs a genuine Perturb & Observe search — its internal operating
voltage (**Vop**, plot it from the Signals picker) hunts around the panel's
max-power point, completely decoupled from whatever the DC bus is actually
at. `G` (irradiance, W/m², 1000 = full sun) is a static "current weather"
knob scaling delivered power; Voc/Isc/Vmpp/Impp are the datasheet numbers
every panel ships with. Generation-only — it never absorbs — so pair it with
something that actively regulates its bus (a battery, or another converter).

`tests/fixtures/pv_mppt.json` — a PV panel under partial cloud (G=800) charges a
battery on a small DC bus: watch Vop hunt near Vmpp while the battery's SOC
climbs from the panel's MPP power.

The **Line RL** block can now model a full **nominal π-equivalent (RLC)
line**: give it a `C` (total, µF) and it splits that evenly as a shunt
capacitor to ground at each end — the standard way medium-length
transmission lines are modeled, adding charging-current effects a plain
series R+L can't. Not combinable with mutual coupling (Rm/Lm) in this
version. The **PQ load** block is the standard power-flow load model —
constant real+reactive power regardless of bus voltage (unlike Load R's
fixed impedance), with Q>0 lagging/inductive and Q<0 leading/capacitive.

`tests/fixtures/pq_piline.json` — a source feeds a PI (RLC) line into a PQ load
(8 kW / 3 kvar): watch the load bus sag realistically under the line
impedance while the load still draws its full setpoint power.

`examples/showcase.json` (open with the Load button) exercises every AC block:
source → breaker (closes 10 ms) → coupled 3-ph line → 2:1 transformer →
load + filter cap, with a GFM droop inverter dispatching 5 kW into the
secondary bus and a phase-A-to-ground fault at 55 ms that self-clears at the
first current zero after 85 ms. Probes on primary and secondary buses.

`examples/radial_feeder.json` — a plain linear distribution study (no
converters): a 2.4 kV feeder fans out through a **Bus** to three step-down
(10:1) transformers and their loads, and one feeder's breaker opens at 50 ms
— watch that one probe's voltage drop to zero at 50 ms while the other two
ride through unaffected. A good one for seeing Bus fan-out, transformers, and
the power-flow arrows together at a slightly larger scale than the other
examples.

`examples/central_ups.json` (3-ph mode; the file carries its own 300 ms run
settings) — a centralized-UPS data center whose topology follows PNNL's
`DML_DC2_Central_UPS` PSCAD example system (Data Center Model Library, report
PNNL-38817). It was **rebuilt on this block set, not converted**, so treat it
as illustrative of that architecture rather than as a validated replica of the
PNNL model. A 2.4 kV utility feeds an 8.66:1 service transformer onto a named **480 V
switchgear Bus** carrying chiller-pump, fan, and site-support loads plus a
**double-conversion UPS** — PFC rectifier holding a 380 V DC link, battery
on the link, GFM inverter re-forming a tightly regulated 277 V island for a
~10 kW IT load. The utility breaker trips at 150 ms and the rectifier drops
with it (its grid-lost protection — the same trip PNNL describes for a
grid-side sag); the switchgear bus and all the cooling load black out, the
battery catches the DC link at its 360 V setpoint, and the IT load rides
through the entire event without a dent. The saved plots show the whole
story: bus vs UPS-output voltage, DC-link handoff 380 → 360 V, and battery
SOC ramping down once it carries the load.

## Validation

`node smoke_test.js` runs every block in canned circuits headless and checks
the results against analytical or independent-solver references (134 checks,
per-block PASS/FAIL summary). [`VALIDATION.md`](VALIDATION.md) is the
manifest: per-block checks, reference types, tolerances, and the rationale
for each tolerance band. Every new block ships with its checks appended to
the smoke test and a row in that manifest.

**What is not verified, stated plainly.** All of those references are in-house:
closed-form phasors, a self-contained nodal helper, and structural properties.
**Zero of the 36 blocks have been cross-checked against a commercial or
independently-developed EMT program**, because I do not have a licence for one.
The [scoreboard](VALIDATION.md) triages every block by how much an external
reference would actually settle. If you have PSCAD, PSS/E, PowerFactory or
similar and twenty minutes, that is the single most useful thing anyone can
contribute here: see
[issue #9](https://github.com/h-d-engineer/OpenEMT/issues/9). A result that
disagrees is worth more than one that agrees, and gets published either way.

`node api/test_api.js` is the second suite: it guards the headless contract
(`api/core.js`, the CLI, and the MCP server) and ties its results to the same
analytical values, so the agent path is proven to reproduce the solver path
rather than merely to run. Both suites must pass before any solver, example,
or API change, and `python build.py` must reproduce the committed `index.html`
byte for byte.

The power flow is guarded by a **flat-start** test, which is its real
acceptance criterion: solve, initialize, then run with no disturbance at all
and confirm nothing moves. It checks convergence, that the machine actually
starts at a nonzero load angle, that the undisturbed run stays flat (under
30 mHz, against roughly 519 mHz for the same circuit cold-started), and that
the final frequency lands on nominal.

## Status

Version 0.1.1. Roadmap (SPEC.md section 5) complete through item 37, with one
exception: item 9 (the per-block validation suite) stays open until an external
reference-tool cross-check exists. The analytical and independent-solver checks
are in place (see VALIDATION.md), but that last class is non-negotiable before
any client-facing use, which is why the AS-IS notice at the top of this page is
not boilerplate.

Studies can be single-phase or 3-phase (balanced, or unbalanced via coupled
lines, per-phase faults, or single-phase laterals tapped off one phase with the
Phase Tap block, including single-phase loads, transformers, and
grid-forming/following inverters on a lateral), plus DC bus studies and hybrid
AC/DC circuits bridged through the PFC and GFM blocks. The **36-block catalog**
(full table in SPEC.md section 4): source, ground, probe, bus, phase tap; lines
(RL/π, Bergeron traveling-wave, frequency-dependent JMarti); passives (C,
series RLC, parallel RLC); transformers (two-winding with opt-in saturation,
3-phase vector-group, three-winding), all entered as nameplate winding
voltages; loads (AC PQ, ZIP composite, DC constant-power, induction motor);
machines and converters (synchronous generator with governor/AVR, GFM inverter
with droop/grid-following modes + DC port + current limiter, transmission-grade
GFL solar with an explicit PLL, Type 4 wind, VSC-HVDC link, SVC/STATCOM, PFC
rectifier, battery DC/DC, dedicated DC/DC, PV with MPPT); protection and
switching (breaker with multi-op reclose, fault, overcurrent relay, distance
relay with out-of-step blinders, latching generation-trip relay, switched-shunt
controller, surge arrester); and the aggregation current-scaling coupler for
N-replica studies.

A positive-sequence **power flow** (Newton-Raphson with a Gauss-Seidel
fallback, generator reactive limits, PSS/E RAW import) solves the steady-state
operating point, annotates bus voltages on the canvas, and initializes
time-domain runs so they start flat instead of swinging in from a cold start.
The browser build runs the solver in a Web Worker with streaming plots, so run
duration is not limited by UI freezing.

See SPEC.md section 7 for the honest limitations register.

## Licence

OpenEMT is free software under the **GNU Affero General Public License v3**
(`AGPL-3.0-only`). See [LICENSE](LICENSE).

A **commercial licence** is available from PEN LLC for uses the AGPL does not
suit, including proprietary redistribution and hosted services built on a
modified version. See [LICENSING.md](LICENSING.md), or enquire at
licensing@openemt.pro.

Contributions are welcome and require a signed [CLA](CLA.md); see
[CONTRIBUTING.md](CONTRIBUTING.md). There are
[good first issues](https://github.com/h-d-engineer/OpenEMT/labels/good%20first%20issue)
open, and the most valuable contribution needs no code at all: cross-check one
block against a commercial tool you already have
([#9](https://github.com/h-d-engineer/OpenEMT/issues/9)). The licences cover
the code, not the name: see [TRADEMARK.md](TRADEMARK.md).

To cite OpenEMT, use the concept DOI
[10.5281/zenodo.21857083](https://doi.org/10.5281/zenodo.21857083), which always
resolves to the newest archived release; each release also has its own version
DOI if you need to pin one. GitHub's "Cite this repository" button reads
[CITATION.cff](CITATION.cff) and will format it for you.

Copyright (C) 2026 Hiva Nasiri.
