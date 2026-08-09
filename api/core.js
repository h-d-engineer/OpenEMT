// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Hiva Nasiri. Commercial licensing: see LICENSING.md
// api/core.js - the OpenEMT headless contract.
//
// Loads the pure solver core (src/blocks.js + src/solver.js) into a Node vm
// sandbox with the minimal DOM stubs the source needs to parse, exactly the
// way smoke_test.js and the Web Worker bootstrap (build.py) already load it.
// The browser build (build.py -> index.html) and the smoke test are not
// touched; this file is the stable interface agents and scripts use instead
// of the eval-and-stub-the-DOM convention.
//
// Why a vm sandbox instead of refactoring src/ to modules: src/ is plain
// global-scope script (top-level `const DEFS`, `function simulate`, ...),
// concatenated by build.py into the browser. Refactoring it would change the
// worker and the byte-identical index.html. Loading the same source as text
// in a vm keeps src/ the single source of truth and the build unchanged.
//
// All public methods look up results by BLOCK ID, never positional index
// (the CLAUDE.md trap). RMS / P / Q windows are integer cycles (CLAUDE.md
// trap). See SPEC.md section 1 for the hybrid node indexing this wraps.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC_DIR = path.resolve(__dirname, '..', 'src');
const ROOT = path.resolve(__dirname, '..');

// Minimal DOM stub. simulate() and solvePowerFlow() never touch the DOM; only
// runEMT() does, and we do not call it. The stub exists so the source parses
// and so any defensive top-level reference does not throw.
function makeDocumentStub() {
  const el = { value: '', textContent: '', style: {}, appendChild() {}, click() {}, setAttribute() {} };
  return {
    getElementById: () => el,
    querySelector: () => ({}),
    querySelectorAll: () => [],
    createElement: () => ({ style: {}, appendChild() {}, click() {}, setAttribute() {}, set href(v){}, set download(v){} }),
  };
}

// Integer-cycle moving-average / RMS helpers, ported from smoke_test.js:54-67.
// win MUST be an integer number of samples per cycle (CLAUDE.md trap).
function movAvg(s, win) {
  let sum = 0; const out = new Array(s.length);
  for (let i = 0; i < s.length; i++) { sum += s[i] || 0; if (i >= win) sum -= (s[i - win] || 0); out[i] = sum / Math.min(i + 1, win); }
  return out;
}
function rmsSeries(s, win) {
  let sumsq = 0; const out = new Array(s.length);
  for (let i = 0; i < s.length; i++) { const v = s[i] || 0; sumsq += v * v; if (i >= win) { const o = s[i - win] || 0; sumsq -= o * o; } out[i] = Math.sqrt(Math.max(0, sumsq) / Math.min(i + 1, win)); }
  return out;
}
function pSeries(v, i, win) {
  const n = Math.min(v.length, i.length); const p = new Array(n);
  for (let k = 0; k < n; k++) p[k] = (v[k] || 0) * (i[k] || 0);
  return movAvg(p, win);
}
function qSeries(v, i, win, shift) {
  const n = Math.min(v.length, i.length); const prod = new Array(n);
  for (let k = 0; k < n; k++) { const j = Math.min(n - 1, k + shift); prod[k] = (v[k] || 0) * (i[j] || 0); }
  return movAvg(prod, win);
}
function avgAfter(arr, t, lo) {
  const s = arr.filter((_, i) => t[i] > lo);
  return s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0;
}

// Power sign convention: src/gfm inject at terminal 0 (opposite of passive
// elements), so their raw v*i must be negated to read as delivered power.
// Mirrors smoke_test.js:75 signFor (els[idx].kind).
function signFor(kind) { return (kind === 'src' || kind === 'gfm') ? -1 : 1; }

class OpenEMT {
  constructor() {
    this._sandbox = {
      S: { blocks: [], wires: [], nextId: 1, sel: [], wireFrom: null },
      document: makeDocumentStub(),
      getComputedStyle: () => ({ getPropertyValue: () => '' }),
      matchMedia: () => ({ matches: false }),
      drawPlots: () => {},
      console,
    };
    vm.createContext(this._sandbox);
    const blocksSrc = fs.readFileSync(path.join(SRC_DIR, 'blocks.js'), 'utf8');
    const solverSrc = fs.readFileSync(path.join(SRC_DIR, 'solver.js'), 'utf8');
    // import.js is a pure (DOM-free) module like blocks.js/solver.js, so it loads
    // into the same sandbox and its importCase() is callable headless exactly as
    // in the browser bundle. Its module.exports guard is a no-op here (no module).
    const importSrc = fs.readFileSync(path.join(SRC_DIR, 'import.js'), 'utf8');
    // Expose the const-bound top-level bindings (DEFS) and the functions the
    // API wraps. const does not attach to the context global, so we lift them
    // explicitly. S is already on the sandbox as a global.
    const bridge = '\n;globalThis.__openemt = { DEFS, simulate, solvePowerFlow, buildNodes, importCase };\n';
    vm.runInContext(blocksSrc + '\n' + solverSrc + '\n' + importSrc + bridge, this._sandbox);
    const api = this._sandbox.__openemt;
    this._DEFS = api.DEFS;
    this._simulate = api.simulate;
    this._solvePowerFlow = api.solvePowerFlow;
    this._importCase = api.importCase;
    this._runs = new Map();
    this._nextRunId = 1;
    // Run settings carried by the loaded file (`sim` block: duration, dtUs,
    // plotUs, nph, pfinit). null when the circuit was built programmatically or
    // imported from a RAW. runSimulation() defaults from this; see _simDefaults.
    this._sim = null;
    // Whether a power flow has been solved on the CURRENT circuit. Used only to
    // warn when a file asks for PF init and none was run (runSimulation never
    // auto-solves; that is deliberate, see runSimulation).
    this._pfRan = false;
  }

  get S() { return this._sandbox.S; }

  // ---- catalog: introspect the block library straight from DEFS ----
  catalog() {
    return Object.keys(this._DEFS).map(type => {
      const d = this._DEFS[type];
      const params = Object.keys(d.params).map(name => ({
        name, default: d.params[name].v, label: d.params[name].l,
      }));
      return { type, label: d.label, w: d.w, h: d.h, terms: d.terms.length, params };
    });
  }

  // ---- circuit load / build ----
  loadCircuit(input) {
    let d;
    if (typeof input === 'string') {
      // Heuristic: treat as a file path if it ends in .json or resolves to an
      // existing file; otherwise treat as a JSON string.
      let parsed = null;
      if (/\.json$/i.test(input) || fs.existsSync(input)) {
        parsed = JSON.parse(fs.readFileSync(input, 'utf8'));
      } else {
        parsed = JSON.parse(input);
      }
      d = parsed;
    } else if (input && typeof input === 'object') {
      d = input;
    } else {
      return { err: 'loadCircuit: expected a circuit object, JSON string, or file path.' };
    }
    if (!d || d.webemt !== 1 || !Array.isArray(d.blocks) || !Array.isArray(d.wires)) {
      return { err: 'Not an OpenEMT circuit file (missing webemt:1 / blocks / wires).' };
    }
    const bad = d.blocks.find(b => !this._DEFS[b.type]);
    if (bad) return { err: 'Unknown block type "' + bad.type + '".' };
    // Backfill params added since the file was saved (mirrors ui.js:1363-1370).
    d.blocks.forEach(b => {
      const defaults = Object.fromEntries(Object.entries(this._DEFS[b.type].params).map(([k, p]) => [k, p.v]));
      b.params = { ...defaults, ...b.params };
      if (typeof b.rot !== 'number') b.rot = 0;
    });
    this.S.blocks = d.blocks;
    this.S.wires = d.wires;
    this.S.nextId = d.blocks.reduce((m, b) => Math.max(m, b.id), 0) + 1;
    this.S.vconv = d.vconv === 'll' ? 'll' : 'ph'; // absent => 'ph' (legacy files stay phase)
    // The UI honours the file's saved run settings (ui.js applySimSettings);
    // so must the headless surface, or `run examples/central_ups.json` stops at
    // the 120 ms hard default and never reaches the 150 ms utility trip that is
    // the whole point of the case. Explicit runSimulation options still win.
    this._sim = (d.sim && typeof d.sim === 'object') ? { ...d.sim } : null;
    this._pfRan = false;
    return { nextId: this.S.nextId, nBlocks: this.S.blocks.length, nWires: this.S.wires.length,
      vconv: this.S.vconv, sim: this.simSettings() };
  }

  // The loaded file's run settings, normalised and validated, or null if the
  // circuit carries none. Same acceptance rules as ui.js applySimSettings:
  // positive finite numbers only, nph restricted to 1 or 3, pfinit a boolean.
  simSettings() {
    const s = this._sim;
    if (!s) return null;
    const pos = (v) => (Number.isFinite(+v) && +v > 0 ? +v : undefined);
    const out = {};
    if (pos(s.duration) !== undefined) out.duration = pos(s.duration);
    if (pos(s.dtUs) !== undefined) out.dtUs = pos(s.dtUs);
    if (pos(s.plotUs) !== undefined) out.plotUs = pos(s.plotUs);
    if (+s.nph === 1 || +s.nph === 3) out.nph = +s.nph;
    if (typeof s.pfinit === 'boolean') out.pfinit = s.pfinit;
    return Object.keys(out).length ? out : null;
  }

  // Import an external case file (currently PSS/E RAW) and load it as the live
  // circuit. `input` is a .raw file path or the raw text itself. Reuses the same
  // validate/backfill path as loadCircuit (no second loader). Returns the import
  // metadata plus a warnings array (generic-dynamics, unverified-revision, ...),
  // or { err } on a parse/format failure with the current circuit left untouched.
  importCase(input) {
    let text = input, name = '';
    if (typeof input === 'string' && (/\.(raw|RAW)$/.test(input) || fs.existsSync(input))) {
      name = input; text = fs.readFileSync(input, 'utf8');
    } else if (typeof input !== 'string') {
      return { err: 'importCase: expected a .raw file path or raw text.' };
    }
    const res = this._importCase(text, name);
    if (res.err) return { err: res.err };
    const lr = this.loadCircuit(res.circuit);
    if (lr.err) return { err: lr.err };
    return { nBlocks: lr.nBlocks, nWires: lr.nWires, vconv: lr.vconv,
      warnings: res.warnings || [], meta: res.meta };
  }

  getCircuit() {
    // Return a safe copy so external code cannot mutate the live circuit.
    return JSON.parse(JSON.stringify({ webemt: 1, vconv: this.S.vconv, blocks: this.S.blocks, wires: this.S.wires }));
  }

  // Voltage convention for AC source/bus params (SPEC §2): 'ph' (phase RMS,
  // legacy) or 'll' (line-to-line RMS). The solver divides an LL value by
  // sqrt(3) at the boundary in 3-ph. A fresh API circuit defaults to 'ph'
  // (legacy, so existing scripts keep working); opt into LL via setVconv.
  // Loaded files inherit their stored convention. Setting reinterprets
  // existing values, it does not convert them.
  setVconv(v) {
    this.S.vconv = (v === 'll') ? 'll' : 'ph';
    return this.S.vconv;
  }

  addBlock(type, params, opts) {
    if (!this._DEFS[type]) throw new Error('Unknown block type "' + type + '"');
    const o = opts || {};
    const defaults = Object.fromEntries(Object.entries(this._DEFS[type].params).map(([k, p]) => [k, p.v]));
    const b = {
      id: this.S.nextId++,
      type,
      x: o.x || 0, y: o.y || 0, rot: o.rot || 0,
      params: { ...defaults, ...(params || {}) },
    };
    this.S.blocks.push(b);
    return b.id;
  }

  addWire(aBlockId, aTerm, bBlockId, bTerm) {
    const w = { a: [aBlockId, aTerm], b: [bBlockId, bTerm] };
    this.S.wires.push(w);
    return this.S.wires.length;
  }

  removeBlock(id) {
    this.S.blocks = this.S.blocks.filter(b => b.id !== id);
    this.S.wires = this.S.wires.filter(w => w.a[0] !== id && w.b[0] !== id);
  }

  reset() {
    this.S.blocks = []; this.S.wires = []; this.S.nextId = 1; this.S.sel = []; this.S.wireFrom = null;
    // vconv is intentionally preserved across reset (a convention preference
    // survives clearing the canvas). A fresh `new OpenEMT()` has no vconv =>
    // 'ph' (legacy), so existing scripts keep working; opt into LL via setVconv.
    this._runs.clear();
    this._sim = null;
    this._pfRan = false;
  }

  // ---- runs ----
  // Option precedence: explicit opt > the loaded file's `sim` block > the
  // hard defaults below. That mirrors the UI, where loading a file fills the
  // run toolbar and the user can then override any field.
  //
  // NOT auto-run: the power flow. `sim.pfinit` drives the browser checkbox, and
  // silently solving here would make a scripted result depend on a hidden step
  // (CLAUDE.md trap). Instead, when the file asks for PF init and no
  // runPowerFlow() has been called on this circuit, the result carries a
  // `warnings` entry saying so.
  runSimulation(opt) {
    const o = opt || {};
    const f = this.simSettings() || {};
    const pick = (explicit, fromFile, dflt) => {
      if (explicit != null) return { v: explicit, src: 'option' };
      if (fromFile != null) return { v: fromFile, src: 'file' };
      return { v: dflt, src: 'default' };
    };
    const nph = pick(o.nph, f.nph, 3);
    const Tms = pick(o.Tms, f.duration, 120);
    const dtUs = pick(o.dtUs, f.dtUs, 50);
    const plotUs = pick(o.plotUs, f.plotUs, 0);
    const settingsFrom = { nph: nph.src, Tms: Tms.src, dtUs: dtUs.src, plotUs: plotUs.src };
    const r = this._simulate(nph.v, Tms.v, o.onChunk, dtUs.v, plotUs.v);
    if (r && r.err) return { err: r.err, stat: r.stat };
    const warnings = [];
    if (f.pfinit === true && !this._pfRan) {
      warnings.push('This case is saved with "Init from PF" on, but no power flow has been solved. '
        + 'runSimulation does not solve it automatically: call runPowerFlow() first, or the machines '
        + 'start cold (rotor angle 0) and swing into position.');
    }
    const runId = this._nextRunId++;
    this._runs.set(runId, r);
    return { runId, stat: r.stat, nph: r.nph, Tms: r.Tms, freqHz: r.freqHz,
      nT: r.t.length, tStart: r.t[0], tEnd: r.t[r.t.length - 1], signals: this._listSignals(r),
      settingsFrom, warnings, result: r };
  }

  // opt.busType overrides a block's pfType. opt.method ('nr' | 'gs' | 'auto')
  // pins the solve method; opt.tol / opt.maxIter / opt.nrTol / opt.nrIter /
  // opt.gsWarm / opt.accel tune it. Everything is forwarded explicitly rather
  // than by spreading `opt`, so a typo is inert instead of silently reaching
  // the solver — but note the earlier trap: before 2026-07-24 ONLY busType was
  // forwarded, so a tolerance override was accepted and dropped, which looked
  // exactly like a modeling discrepancy.
  runPowerFlow(opt) {
    const o = opt || {};
    const res = this._solvePowerFlow({
      busType: o.busType, method: o.method, tol: o.tol, maxIter: o.maxIter,
      accel: o.accel, nrTol: o.nrTol, nrIter: o.nrIter, gsWarm: o.gsWarm,
      qRounds: o.qRounds,
    });
    if (res && res.err) return { err: res.err };
    this._pfRan = true; // suppresses runSimulation's "saved with Init from PF" warning
    return {
      converged: res.converged, iters: res.iters, maxMismatch: res.maxMismatch,
      unit: res.unit, method: res.method, diverged: res.diverged,
      islands: res.islands, deadBuses: res.deadBuses, nDead: res.nDead, note: res.note,
      nQlim: res.nQlim,
      f0: res.f0, Vnom: res.Vnom, buses: res.buses, busBlocks: res.busBlocks, genInit: res.genInit,
    };
  }

  // List every block id an agent can query from a run result, with what it
  // supports. V comes from probes/buses (probeMeta); I/P/Q from branches
  // (curMeta). Per ui.js:2032-2033 both meta arrays carry the block id.
  _listSignals(r) {
    const out = [];
    const pMeta = r.probeMeta || (r.probes || []).map(p => ({ id: p.b.id, dc: false }));
    // ph1/ph0 (SPEC §2 phase tap): which phase a single-phase lateral signal
    // actually is. null/0 for ordinary 3-phase and DC signals, so existing
    // consumers see no change.
    (pMeta || []).forEach(m => out.push({ blockId: m.id, hasV: true, hasI: false, hasF: !!m.hasF, fSat: !!m.fSat, fDead: !!m.fDead, dc: !!m.dc, ph1: m.ph1 == null ? null : m.ph1 }));
    const cMeta = r.curMeta || (r.curEls || []).map((e, i) => ({ id: e.b.id, type: e.b.type, kind: e.kind, np: r.ic[i].length, dc: false }));
    // cause: which element (59/27/81O/81U) tripped a gtrip relay, null if it
    // never tripped (or is not a gtrip). Metadata about the run, like kind/dc/
    // ph0 above, not a queryable time series, so it rides in _listSignals
    // rather than being a fake 8th `query` signal.
    (cMeta || []).forEach((m, i) => {
      const ex = out.find(o => o.blockId === m.id);
      if (ex) { ex.hasI = true; ex.kind = m.kind; ex.np = m.np; ex.dc = ex.dc || m.dc; ex.ph0 = m.ph0 || 0; ex.cause = m.kind === 'gtrip' ? (m.cause != null ? m.cause : null) : null; }
      else out.push({ blockId: m.id, hasI: true, hasV: false, kind: m.kind, np: m.np, dc: !!m.dc, ph0: m.ph0 || 0, cause: m.kind === 'gtrip' ? (m.cause != null ? m.cause : null) : null });
    });
    return out;
  }

  // query by BLOCK ID (CLAUDE.md rule). Accepts a runId (number), a raw result
  // from runSimulation, or nothing (uses the most recent run on this OpenEMT).
  // signal: 'V' | 'Vrms' | 'I' | 'Irms' | 'P' | 'Q'. Returns per-phase arrays
  // (numbers only, safe to serialize) plus a steady-state scalar sampled at
  // the end of the run (last cycle average).
  query(blockId, signal, opt) {
    const o = opt || {};
    let r = o.runId != null ? this._runs.get(o.runId)
      : (o.result || (this._runs.size ? this._runs.get(this._nextRunId - 1) : null));
    if (!r) return { err: 'No run result available. Call runSimulation first.' };
    const sig = (signal || 'V');
    if (!['V', 'Vrms', 'f', 'I', 'Irms', 'P', 'Q'].includes(sig)) {
      return { err: 'Unknown signal "' + sig + '". Use V, Vrms, f, I, Irms, P, or Q.' };
    }
    const t = r.t;
    const dtOut = t.length > 1 ? (t[1] - t[0]) : 0;
    const freqHz = r.freqHz || 60;
    const win = dtOut > 0 ? Math.max(1, Math.round(1000 / freqHz / dtOut)) : 1;
    const shift = Math.max(1, Math.round(win / 4));

    const pMeta = r.probeMeta || (r.probes || []).map(p => ({ id: p.b.id, dc: false }));
    const cMeta = r.curMeta || (r.curEls || []).map((e, i) => ({ id: e.b.id, type: e.b.type, kind: e.kind, np: r.ic[i].length, dc: false }));

    // Voltage signals: probes / buses.
    if (sig === 'V' || sig === 'Vrms') {
      const pi = pMeta.findIndex(m => m.id === blockId);
      if (pi < 0) return { err: 'Block ' + blockId + ' has no voltage signal (it is not a probe/bus).' };
      const phases = r.vp[pi];
      // A node on a single-phase lateral (SPEC §2 phase tap) has ONE real
      // reading; the solver repeats it across the phase slots the same way it
      // does for DC. Return the single series, tagged with its actual phase,
      // rather than three identical copies labeled 0/1/2.
      const lat = pMeta[pi].ph1;
      const phs = lat == null ? phases : phases.slice(0, 1);
      const out = { blockId, signal: sig, dc: !!pMeta[pi].dc, ph1: lat == null ? null : lat, phases: phs.length, series: phs.map(p => sig === 'Vrms' ? rmsSeries(p, win) : p.slice()) };
      out.steadyState = out.series.map(s => avgAfter(s, t, t[t.length - 1] - (1000 / freqHz)));
      return out;
    }

    // Node frequency: probes / buses on a 3-ph AC node (solver.js nodePLL).
    // One series, not per-phase: a positive-sequence PLL has a single output.
    if (sig === 'f') {
      const pi = pMeta.findIndex(m => m.id === blockId);
      if (pi < 0) return { err: 'Block ' + blockId + ' has no frequency signal (it is not a probe/bus).' };
      const ser = r.fp && r.fp[pi];
      if (!ser) return { err: 'Block ' + blockId + ' has no frequency signal: node frequency is measured on 3-phase AC nodes only (a positive-sequence PLL needs three phases), not on DC nodes or single-phase laterals.' };
      // saturated: the PLL hit its tracking stop somewhere in this run, so
      // parts of the trace are the clamp, not a measurement.
      const out = { blockId, signal: 'f', dc: false, ph1: null, phases: 1, saturated: !!pMeta[pi].fSat, deEnergized: !!pMeta[pi].fDead, series: [ser.slice()] };
      out.steadyState = out.series.map(x => avgAfter(x, t, t[t.length - 1] - (1000 / freqHz)));
      return out;
    }

    // Current / power signals: branch elements (curEls).
    const ci = cMeta.findIndex(m => m.id === blockId);
    if (ci < 0) return { err: 'Block ' + blockId + ' has no branch current signal.' };
    const kind = cMeta[ci].kind;
    const np = cMeta[ci].np;
    const ic = r.ic[ci];           // per-phase current arrays
    const bv = r.bv ? r.bv[ci] : null; // per-phase branch voltage arrays (for P/Q)
    const sgn = signFor(kind);

    if (sig === 'I' || sig === 'Irms') {
      const series = [];
      for (let p = 0; p < np; p++) series.push(sig === 'Irms' ? rmsSeries(ic[p] || [], win) : (ic[p] || []).slice());
      const out = { blockId, signal: sig, kind, np, ph0: cMeta[ci].ph0 || 0, phases: np, series };
      out.steadyState = out.series.map(s => avgAfter(s, t, t[t.length - 1] - (1000 / freqHz)));
      return out;
    }

    if (sig === 'P' || sig === 'Q') {
      if (!bv) return { err: 'No branch voltage captured for block ' + blockId + ' (P/Q unavailable).' };
      const series = [];
      for (let p = 0; p < np; p++) {
        const v = bv[p] || [], i = ic[p] || [];
        const s = sig === 'P' ? pSeries(v, i, win) : qSeries(v, i, win, shift);
        series.push(s.map(x => x * sgn));
      }
      const out = { blockId, signal: sig, kind, np, ph0: cMeta[ci].ph0 || 0, phases: np, series };
      out.steadyState = out.series.map(s => avgAfter(s, t, t[t.length - 1] - (1000 / freqHz)));
      return out;
    }

    return { err: 'Unknown signal "' + sig + '". Use V, Vrms, I, Irms, P, or Q.' };
  }

  listExamples() {
    const dir = path.join(ROOT, 'examples');
    return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''));
  }

  loadExample(name) {
    const file = path.join(ROOT, 'examples', name.replace(/\.json$/, '') + '.json');
    if (!fs.existsSync(file)) return { err: 'No such example: ' + name };
    return this.loadCircuit(file);
  }
}

module.exports = { OpenEMT };