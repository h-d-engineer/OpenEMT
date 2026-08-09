# OpenEMT — session guidance

- Build: `python build.py` (assembles src/ into standalone index.html).
- Test: `node smoke_test.js` — must pass before and after any solver/example change.
- Read `SPEC.md` before touching solver physics; read `DECISIONS.md` before
  changing anything it covers.
- **IP screening before new methods.** Before implementing any NEW numerical
  method, solver technique, or component/control model (physics + equations),
  check its intellectual-property and licensing status first — prefer classical
  published methods old enough to be unencumbered (20+ years), and verify the
  specific variant, not just the family (a base algorithm can be free while its
  modern variants are not). Findings are recorded off-repo, never in tracked
  files; the standing screening baseline lives there and lists the areas that
  require a real search before entering.

## Git workflow
Commit directly to `main` for small, same-day work that keeps the smoke test
green. Use a short-lived feature branch for anything multi-session or risky
(solver internals, a new block family, a UI rework), merged back as soon as
it is green. Do NOT keep long-lived per-subsystem branches (feature/solver,
feature/gui, ...): for a solo project they only drift and merge badly. `main`
must always pass `node smoke_test.js`.

## Decision log discipline
Whenever a significant design decision is made in a session — a modeling choice,
a numerical-method choice, a deliberate removal, a convention (like ID-based
probe lookup) — append a dated entry to `DECISIONS.md` with a 1–3 sentence why.
Correct old entries with a new dated entry, never by rewriting history. This is
the project's defense against context compaction and session boundaries.

`DECISIONS.md` is committed and this repo is public, so it is **engineering
only**. Commercial, legal, personal and IP decisions (funding, licensing
strategy, named third parties) go in `legal/BUSINESS_DECISIONS.md`, which is
gitignored. Never put a funding figure, personal circumstance, or third-party
name in a tracked file: git history is permanent and survives in every clone
and fork.

## Writing style for deliverables
- **No em dashes (—), en dashes (–), or double dashes (--) in any report,
  document, or user-facing deliverable.** Rewrite with a colon, comma,
  semicolon, or parentheses instead; use "X to Y" for numeric ranges.
  This includes text inside SVG figures (it becomes real text in PDFs).
  Mathematical minus signs (U+2212) in equations are operators, not
  punctuation - keep them.

## Known traps (details in DECISIONS.md)
- Constant-power loads behind impedance oscillate/sustain phantom voltages.
- RMS windows must be integer cycles.
- Probe/bus signals: look up by block ID, never positional index.
- **`pfInit` / `pfV` on a block are DERIVED state and must never be committed.**
  Saving after a power-flow solve writes the operating point onto every block,
  and reloading STARTS the EMT run from it. A committed example then ships one
  session's solve instead of a model, goes stale on any edit, and silently
  changes results (a GFM came back injecting 11 kW against its own 5 kW
  setpoint). Strip them from `examples/` and `tests/fixtures/`.
- **Absent parameter ≠ parameter at its default.** Saving a circuit in the app
  materialises every `DEFS` default, and an absent param reads as 0/NaN at the
  use site, so a re-save can change physics (a battery gained `Ichg: 10` and
  started charging). Never write a test that depends on a key being missing;
  set the value you rely on explicitly.
- **A current-source block wired to ground does NOT ground a node.** `pq`,
  `zip`'s constant-power part, `cpl`, `im`, `svc`, `wt4`, `hvdc` and `gfl` are
  stamped `G = 0`: infinite impedance, no contribution to the conductance
  matrix, so they cannot fix a node voltage no matter what they connect to. The
  node still needs something that conducts (an `rlc`/`rlcp` shunt, a line with
  shunt C, or a grounded transformer winding).
- **A delta winding with nothing grounded on its own side floats in EMT.**
  `Yd11` fails where `Yy0` solves, and a magnetizing branch does not rescue it.
  The power flow is unaffected (positive sequence has no such node), so "PF
  converges but EMT says singular" is the signature. This is the
  isolated-secondary limit in SPEC section 5 item 4, not a bug.
- **`S.vconv` is global and leaks between tests.** Any test that loads a case
  file must set `S.vconv = ex.vconv || 'ph'`, and any test that clears the
  circuit must reset it to `'ph'`. A line-to-line file read as phase volts is
  off by sqrt(3) with no other symptom.
- **`api/core.js`'s `runSimulation()` does not auto-run the power flow**, even
  when the case carries `sim.pfinit: true` (that flag drives the browser
  checkbox). Scripted checks must call `runPowerFlow()` explicitly or they
  measure a cold start and can wrongly look like a regression.
- **After writing a guard, break the thing it guards and confirm it complains.**
  The `build.py` licence-notice guard searched the whole output for an SPDX tag
  that every `src/` module also carries, so it could never fail. A guard that
  cannot fail is worse than none.
- A machine started cold (rotor angle 0) must swing to its load angle, and at a
  weak bus it can slip and never synchronize. Solve the power flow first
  (`solvePowerFlow()` / the "Init from PF" checkbox) rather than fighting it.
- `"webemt": 1` in example JSON is the internal schema version marker, not
  branding. Leave it: renaming breaks every saved example for zero benefit.
- `legal/` is gitignored and holds only the local business log. Anything whose
  file timestamps matter is kept outside the repo entirely: git does not
  preserve mtimes, so a checkout restamps every file.

## Where things go
- `SPEC.md` §2 physics derivations, §5 roadmap (committed, prioritized work).
- `DECISIONS.md` why a decision was made, after the fact. Engineering only.
- `IDEAS.md` speculative backlog, not commitments. Engineering only.
- `legal/BUSINESS_DECISIONS.md` (gitignored) commercial/legal/IP decisions.
- `examples/` curated, shipped examples only (each earns a README table row).
- `tests/fixtures/` regression circuits loaded by `smoke_test.js`; never edit
  one without checking the assertions that load it.
- `studies/` (gitignored) scratch space for exploratory/dev cases; promotion
  criteria are in `examples/README.md`. Never commit half-baked cases: the
  repo is heading public and git history is permanent.
Lifecycle: idea in IDEAS.md, promote to the SPEC §5 roadmap when committed to,
implement, then record the why in DECISIONS.md and mark the roadmap item done.

## Headless / API
- The agent and script API is `api/core.js` (the `OpenEMT` class), with
  `api/cli.js` and `api/mcp-server.js` as thin fronts. It loads
  `src/blocks.js + src/solver.js` in a `vm` sandbox with minimal DOM stubs,
  the same load `smoke_test.js` and the worker bootstrap use. Do NOT add a
  second headless loader; extend `api/core.js` instead.
- `runEMT()` (solver.js) is DOM-coupled and for the browser only. The API
  calls `simulate()` and `solvePowerFlow()` directly, which are pure.
- Look up probe/bus/branch signals by BLOCK ID, never positional index (the
  `query` method and `_listSignals` enforce this). RMS/P/Q windows are
  integer cycles.
- `node smoke_test.js` AND `node api/test_api.js` must both pass before any
  solver/example/API change. `python build.py` output must stay byte-identical
  when `src/` is untouched (the API never touches `src/`).
- The MCP server is registered in `.mcp.json` at the repo root (Claude
  Code's project-scoped MCP config location; the earlier `.claude/mcp.json`
  was the wrong path and was ignored). Relative path `api/mcp-server.js` is
  portable because Claude Code spawns project MCP servers with cwd at the
  repo root and sets `CLAUDE_PROJECT_DIR`. Project-scoped servers require a
  one-time approval prompt on first use; after approval and a client restart
  the `mcp__openemt__*` tools appear. Tool schemas are generated from `DEFS`,
  so do not hand-duplicate block param lists in the server.
