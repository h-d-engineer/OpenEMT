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

// ---- subcircuits ----
//
// A datacenter is the same UPS chain repeated, and the interesting question is
// always what happens BETWEEN chains during a transfer. The `scale` block
// cannot answer that by construction: it represents N copies as one aggregate
// and deliberately does not conserve power at the coupling, so there is no
// second chain to transfer to. Subcircuits give real, separately simulated
// units, and they are also how an agent composes a large model without losing
// the thread: four instances of one verified module rather than 200 blocks.
//
// A circuit may carry a `defs` map of reusable definitions and instantiate one
// with a `subckt` block. Flattening expands every instance into ordinary blocks
// and wires BEFORE the solver sees it, so nothing downstream changes.
//
//   "defs": {
//     "ups": {
//       "ports":  [ { "name": "AC in", "block": 1, "term": 0 } ],
//       "params": { "battAh": { "default": 0.02, "to": [ { "block": 4, "param": "Ah" } ] } },
//       "blocks": [ ... ],      // ids are LOCAL to the definition
//       "wires":  [ ... ]
//     }
//   }
//   { "id": 7, "type": "subckt", "params": { "def": "ups", "battAh": 0.05 } }
//
// An outer wire to (instance, terminal k) is rewritten to the inner block and
// terminal that port k names. Parameter overrides are explicit bindings rather
// than name matching, so a definition's public knobs are a declared surface
// instead of whatever its internals happen to be called.
//
// Lives here rather than in src/ because this is the agent path: an agent
// composes JSON, and the canvas cannot yet draw or edit a subcircuit. Promoting
// it to src/ is what browser support would need.
function flattenCircuit(circuit) {
  const defs = circuit.defs || {};
  const out = { blocks: [], wires: [] };
  const map = {};   // "instancePath/localId" -> flattened id (or a port list)
  let nextId = 1;
  (circuit.blocks || []).forEach(b => { if (+b.id >= nextId) nextId = +b.id + 1; });

  const expand = (blocks, wires, pathPrefix, depth, chain) => {
    if (depth > 8) return 'Subcircuit nesting is deeper than 8 levels at "' + pathPrefix
      + '"; this is almost certainly a definition that instantiates itself.';
    for (const b of blocks) {
      if (b.type !== 'subckt') {
        const nb = JSON.parse(JSON.stringify(b));
        nb.id = nextId++;
        map[pathPrefix + b.id] = nb.id;
        out.blocks.push(nb);
        continue;
      }
      const dname = b.params && b.params.def;
      const d = defs[dname];
      if (!d) return 'Block #' + b.id + ' instantiates definition "' + dname + '", which is not in defs.';
      if (chain.includes(dname)) return 'Definition "' + dname + '" instantiates itself (via '
        + chain.concat(dname).join(' -> ') + '), which cannot be flattened.';
      if (!Array.isArray(d.ports) || !d.ports.length) return 'Definition "' + dname
        + '" declares no ports, so nothing can connect to it.';
      const inner = JSON.parse(JSON.stringify({ blocks: d.blocks || [], wires: d.wires || [] }));
      const decl = d.params || {};
      for (const [pname, pdef] of Object.entries(decl)) {
        const val = (b.params && pname in b.params) ? b.params[pname] : pdef.default;
        if (val === undefined) continue;
        for (const bind of (pdef.to || [])) {
          const target = inner.blocks.find(x => x.id === bind.block);
          if (!target) return 'Definition "' + dname + '" binds parameter "' + pname + '" to block '
            + bind.block + ', which it does not contain.';
          if (!(bind.param in target.params)) return 'Definition "' + dname + '" binds "' + pname
            + '" to ' + target.type + ' #' + bind.block + '.' + bind.param + ', which that block does not have.';
          target.params[bind.param] = val;
        }
      }
      const sub = pathPrefix + b.id + '/';
      const e = expand(inner.blocks, inner.wires, sub, depth + 1, chain.concat(dname));
      if (e) return e;
      const resolved = d.ports.map(p => {
        const fid = map[sub + p.block];
        return typeof fid === 'number' ? [fid, p.term || 0] : null;
      });
      if (resolved.some(x => x == null)) return 'Definition "' + dname + '" has a port naming a block it does not contain (ports reference '
        + JSON.stringify(d.ports.map(p => p.block)) + ').';
      map[pathPrefix + b.id] = resolved;  // an instance maps to its port list
    }
    for (const w of wires) {
      const end = (e2) => {
        const m = map[pathPrefix + e2[0]];
        if (m == null) return null;
        if (Array.isArray(m)) { const p = m[e2[1]]; return p ? p.slice() : null; }
        return [m, e2[1]];
      };
      const a = end(w.a), b2 = end(w.b);
      if (!a || !b2) return 'A wire references terminal ' + JSON.stringify(!a ? w.a : w.b)
        + ', which does not resolve: the block is missing, or a subcircuit has no such port.';
      out.wires.push({ a, b: b2 });
    }
    return null;
  };

  const e = expand(circuit.blocks || [], circuit.wires || [], '', 0, []);
  if (e) return { err: e };
  return { blocks: out.blocks, wires: out.wires, map };
}

// ---- protection coordination ----
// The same IEEE C37.112 constants the relay block integrates (blocks.js
// RELAY_CURVES). Duplicated deliberately rather than imported: core.js loads
// src/ in a vm sandbox and reaching into it for a constant would couple the
// study layer to the solver's internals. api/test_api.js asserts the two
// tables agree, so the copy cannot drift silently.
const TCC_CURVES = {
  MI: { A: 0.0515, B: 0.1140, p: 0.02, tr: 4.85 },
  VI: { A: 19.61, B: 0.491, p: 2, tr: 21.6 },
  EI: { A: 28.2, B: 0.1217, p: 2, tr: 29.1 },
};
// Operating time at current I, in seconds. Below pickup the relay never
// operates, which is null rather than Infinity so it reads as "not applicable"
// instead of "very slow". The instantaneous element (50) short-circuits the
// inverse-time element (51) exactly as the solver's step() does.
function tccTime(d, I) {
  if (d.Iinst != null && I >= d.Iinst) return 0;
  const M = I / d.Ipu;
  if (!(M > 1)) return null;
  return d.TD * (d.cv.A / (Math.pow(M, d.cv.p) - 1) + d.cv.B);
}
function logSpace(lo, hi, n) {
  if (!(hi > lo) || n < 2) return [lo];
  const out = [];
  const a = Math.log(lo), b = Math.log(hi);
  for (let i = 0; i < n; i++) out.push(Math.exp(a + (b - a) * i / (n - 1)));
  return out;
}

// ---- study metrics and comparisons ----
// Reduce one series over a sample window to the single number an assertion
// compares. 'steady' is the last full cycle, which is what you want for "where
// did it settle"; 'final' is the last sample, which is not the same thing on an
// AC waveform and is a common way to accidentally assert against a zero
// crossing.
function metricOf(ser, t, i0, i1, metric, q, r) {
  if (!ser || !ser.length) return null;
  const lo = Math.max(0, i0), hi = Math.min(ser.length - 1, i1);
  if (hi < lo) return null;
  if (metric === 'final') return ser[hi];
  if (metric === 'steady') {
    const freqHz = (r && r.freqHz) || 60;
    return avgAfter(ser.slice(lo, hi + 1), t.slice(lo, hi + 1), t[hi] - (1000 / freqHz));
  }
  let mn = Infinity, mx = -Infinity, sum = 0, n = 0, amx = 0;
  for (let i = lo; i <= hi; i++) {
    const v = ser[i];
    if (v == null || !isFinite(v)) continue;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
    if (Math.abs(v) > amx) amx = Math.abs(v);
    sum += v; n++;
  }
  if (!n) return null;
  if (metric === 'min') return mn;
  if (metric === 'max') return mx;
  if (metric === 'absmax') return amx;
  if (metric === 'mean') return sum / n;
  return null;
}

// Margin is signed and in the signal's own units: positive means room to
// spare, negative means by how much it failed. relMargin normalises by the
// limit so a voltage and a time can be ranked against each other, which is
// what makes "the worst margin in the whole study" a meaningful single number.
function compareAssert(op, measured, value, value2, tol) {
  const rel = (m, ref) => {
    const d = Math.abs(ref) > 1e-12 ? Math.abs(ref) : 1;
    return m / d;
  };
  let margin, pass;
  switch (op) {
    case '>=': case '>':
      margin = measured - value; pass = op === '>' ? measured > value : measured >= value; break;
    case '<=': case '<':
      margin = value - measured; pass = op === '<' ? measured < value : measured <= value; break;
    case 'between': {
      const lo = Math.min(value, value2), hi = Math.max(value, value2);
      margin = Math.min(measured - lo, hi - measured);
      pass = measured >= lo && measured <= hi;
      break;
    }
    case 'approx': {
      const tolerance = tol == null ? Math.abs(value) * 0.01 : Math.abs(tol);
      margin = tolerance - Math.abs(measured - value);
      pass = Math.abs(measured - value) <= tolerance;
      return { margin, rel: rel(margin, tolerance), pass };
    }
    default:
      return { margin: null, rel: null, pass: false };
  }
  return { margin, rel: rel(margin, op === 'between' ? (value2 - value) / 2 : value), pass };
}

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
      // Discriminate on CONTENT SHAPE, not on the extension: serialized JSON
      // always opens with { or [, and no filesystem path does. The old test
      // (".json suffix or existing file, else JSON.parse") sent a mistyped or
      // non-existent path into JSON.parse, so `run ieee9bus` reported
      // "Unexpected token 'C'" about the user's own path instead of saying the
      // file was missing. Both branches return an err rather than throwing.
      if (/^\s*[{[]/.test(input)) {
        try { d = JSON.parse(input); }
        catch (e) { return { err: 'Could not parse circuit JSON: ' + e.message }; }
      } else {
        if (!fs.existsSync(input)) return { err: 'File not found: ' + input };
        try { d = JSON.parse(fs.readFileSync(input, 'utf8')); }
        catch (e) { return { err: 'Could not parse ' + input + ': ' + e.message }; }
      }
    } else if (input && typeof input === 'object') {
      d = input;
    } else {
      return { err: 'loadCircuit: expected a circuit object, JSON string, or file path.' };
    }
    if (!d || d.webemt !== 1 || !Array.isArray(d.blocks) || !Array.isArray(d.wires)) {
      return { err: 'Not an OpenEMT circuit file (missing webemt:1 / blocks / wires).' };
    }
    // Subcircuits are expanded here, before anything else looks at the model.
    // Flattening at load rather than at solve keeps every downstream consumer
    // (the solver, the study layer, query-by-block-id, coordination) working on
    // ordinary blocks with no knowledge that a hierarchy ever existed. The
    // price is that getCircuit() returns the flattened form, which is honest:
    // the canvas cannot draw a subcircuit yet, so round-tripping a hierarchical
    // file through the editor would silently lose the structure anyway.
    let hier = null;
    if (d.defs || d.blocks.some(b => b.type === 'subckt')) {
      const fl = flattenCircuit(d);
      if (fl.err) return { err: 'Subcircuit: ' + fl.err };
      hier = { defs: Object.keys(d.defs || {}), instances: d.blocks.filter(b => b.type === 'subckt').length,
        blocksBefore: d.blocks.length, blocksAfter: fl.blocks.length, map: fl.map };
      d = { ...d, blocks: fl.blocks, wires: fl.wires };
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
    this._hier = hier;
    return { nextId: this.S.nextId, nBlocks: this.S.blocks.length, nWires: this.S.wires.length,
      vconv: this.S.vconv, sim: this.simSettings(),
      // Only present when the file actually used subcircuits, so the common
      // case is unchanged. `map` translates "instance/localId" to the flattened
      // block id, which is what makes query-by-id usable on a hierarchical
      // model: probe 3 inside instance 7 is map["7/3"].
      ...(hier ? { subcircuits: hier } : {}) };
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

  // ---- studies ----
  //
  // A run produces a waveform. A decision needs a verdict, and the gap between
  // them is where an agent adds leverage a person does not have: nobody hand-
  // runs twelve contingencies and tabulates the margins, but that is exactly
  // what a design review asks for.
  //
  // A study is: a base circuit, a list of cases that each perturb it, and a
  // list of assertions evaluated against every case. The output is a table of
  // pass/fail with the margin to each limit, and the single worst margin across
  // the whole study, which is the number an engineer actually wants.
  //
  // The same shape is a validation harness (a case, a criterion, an expected
  // value), which is deliberate: SPEC section 5 item 9 needs exactly this, so
  // it is built once and serves both.
  //
  //   spec = {
  //     cases:  [ { name, set: [{block, param, value}], remove: [blockId] } ]
  //     sweep:  { block, param, values: [...] }        // sugar for cases
  //     run:    { Tms, dtUs, nph, plotUs, pf: true }
  //     assert: [ { name, block, signal, metric, op, value, value2,
  //                 phase, window: {from, to}, tol } ]
  //   }
  //
  // metric: min | max | absmax | final | mean | steady   (steady = last cycle)
  // op:     >= | <= | > | < | between | approx           (approx uses tol)
  runStudy(spec) {
    const s = spec || {};
    if (!this.S.blocks.length) return { err: 'No circuit loaded. Load one before running a study.' };
    const asserts = Array.isArray(s.assert) ? s.assert : [];
    if (!asserts.length) return { err: 'A study needs at least one assertion, or it cannot reach a verdict.' };

    let cases = Array.isArray(s.cases) ? s.cases.slice() : [];
    if (s.sweep) {
      const sw = s.sweep;
      if (sw.block == null || !sw.param || !Array.isArray(sw.values)) {
        return { err: 'sweep needs { block, param, values: [...] }.' };
      }
      sw.values.forEach(v => cases.push({
        name: sw.param + ' = ' + v,
        set: [{ block: sw.block, param: sw.param, value: v }],
      }));
    }
    // No cases means "the circuit as it stands", which is a legitimate study of
    // one: it is how a validation check is written.
    if (!cases.length) cases = [{ name: 'base' }];

    const base = this.getCircuit();
    const run = s.run || {};
    const out = [];
    try {
      for (const c of cases) {
        out.push(this._runStudyCase(base, c, run, asserts));
      }
    } finally {
      // Leave the instance exactly as it was found. Each case mutates the live
      // circuit (that is how overrides and removals are applied), so without
      // this the LAST case's perturbation becomes the state every subsequent
      // study, run and query sees. It bit immediately: a study that removed a
      // ground made the next study report a singular matrix on a circuit the
      // caller had never touched. Silent state leakage between studies is
      // exactly the kind of defect that makes a verdict layer untrustworthy,
      // so restoring is not best-effort, it is in a finally.
      this.loadCircuit(JSON.stringify(base));
    }

    const failed = out.filter(c => !c.pass);
    // Worst margin across every assertion of every case. Normalised, so a
    // voltage in volts and a time in ms can be ranked against each other.
    let worst = null;
    out.forEach(c => (c.results || []).forEach(r => {
      if (r.relMargin == null) return;
      if (!worst || r.relMargin < worst.relMargin) worst = { case: c.name, ...r };
    }));
    return {
      nCases: out.length,
      passed: out.length - failed.length,
      failed: failed.length,
      pass: failed.length === 0,
      worst,
      failedCases: failed.map(c => c.name),
      cases: out,
    };
  }

  _runStudyCase(base, c, run, asserts) {
    const name = c.name || 'case';
    // Every case starts from a clean reload of the base, so one case cannot
    // leak a parameter edit or a solved operating point into the next.
    const lr = this.loadCircuit(JSON.stringify(base));
    if (lr.err) return { name, pass: false, err: 'Could not rebuild the base circuit: ' + lr.err };

    const applied = [];
    for (const set of (c.set || [])) {
      const b = this.S.blocks.find(x => x.id === set.block);
      if (!b) return { name, pass: false, err: 'No block with id ' + set.block + ' to set ' + set.param + ' on.' };
      if (!(set.param in b.params)) {
        return { name, pass: false, err: 'Block ' + set.block + ' (' + b.type + ') has no parameter "'
          + set.param + '". It has: ' + Object.keys(b.params).join(', ') + '.' };
      }
      applied.push(b.type + ' #' + set.block + '.' + set.param + ' = ' + set.value);
      b.params[set.param] = set.value;
    }
    for (const id of (c.remove || [])) {
      if (!this.S.blocks.some(b => b.id === id)) {
        return { name, pass: false, err: 'No block with id ' + id + ' to remove.' };
      }
      applied.push('removed #' + id);
      this.removeBlock(id);
    }

    if (run.pf) {
      const pf = this.runPowerFlow();
      if (pf.err) return { name, pass: false, applied, err: 'Power flow: ' + pf.err };
      if (pf.converged === false) {
        return { name, pass: false, applied, err: 'Power flow did not converge, so the run would start from a meaningless operating point.' };
      }
    }
    const sim = this.runSimulation({ Tms: run.Tms, dtUs: run.dtUs, nph: run.nph, plotUs: run.plotUs });
    if (sim.err) return { name, pass: false, applied, err: sim.err };

    const results = asserts.map(a => this._evalAssert(a, sim.runId));
    return { name, applied, pass: results.every(r => r.pass), stat: sim.stat, results };
  }

  _evalAssert(a, runId) {
    const label = a.name || ((a.block != null ? '#' + a.block + ' ' : '') + (a.signal || 'V') + ' '
      + (a.metric || 'min') + ' ' + (a.op || '>=') + ' ' + a.value);
    const q = this.query(a.block, a.signal || 'V', { runId });
    if (q.err) return { assert: label, pass: false, err: q.err };
    const r = this._runs.get(runId);
    const t = r.t;
    // Restrict to a time window when given: "recovers above 0.9 pu within
    // 200 ms" is a statement about a window, not about the whole run.
    const w = a.window || {};
    let i0 = 0, i1 = t.length - 1;
    if (w.from != null) { while (i0 < t.length && t[i0] < w.from) i0++; }
    if (w.to != null) { while (i1 >= 0 && t[i1] > w.to) i1--; }

    // Skip the measurement filter's fill region. Vrms, Irms, P and Q are all
    // windowed over one cycle, and rmsSeries divides by min(i+1, win), so the
    // first cycle of every one of them ramps up from zero. Those samples are
    // the filter filling, not the circuit doing anything.
    //
    // This matters more here than anywhere else in the API: `metric: 'min'` on
    // a Vrms signal would otherwise return roughly zero for EVERY case of every
    // study, and report a confident FAIL that has nothing to do with the
    // design. A verdict that is wrong for an invisible reason is worse than no
    // verdict. Reported as `skippedFillMs` rather than done silently, and an
    // explicit window.from is always respected as-is.
    let skippedFillMs = null;
    const WINDOWED = ['Vrms', 'Irms', 'P', 'Q'];
    if (w.from == null && WINDOWED.includes(a.signal)) {
      const dtOut = t.length > 1 ? (t[1] - t[0]) : 0;
      const cyc = 1000 / ((r && r.freqHz) || 60);
      const fill = dtOut > 0 ? Math.min(t.length - 1, Math.ceil(cyc / dtOut)) : 0;
      if (fill > i0) { i0 = fill; skippedFillMs = +(t[i0] - t[0]).toFixed(3); }
    }
    if (i1 < i0) return { assert: label, pass: false, err: 'Window ' + JSON.stringify(w) + ' selects no samples.' };

    // Reduce across phases to the worst case unless one is named, because a
    // criterion that holds on two phases and fails on the third has failed.
    const chosen = a.phase != null ? [q.series[a.phase]].filter(Boolean) : q.series;
    if (!chosen.length) return { assert: label, pass: false, err: 'Phase ' + a.phase + ' not present on this signal.' };
    const metric = a.metric || 'min';
    const per = chosen.map(ser => metricOf(ser, t, i0, i1, metric, q, r));
    if (per.some(v => v == null || !isFinite(v))) {
      return { assert: label, pass: false, err: 'Metric "' + metric + '" produced no finite value.' };
    }
    // Worst case depends on which way the limit points.
    const op = a.op || '>=';
    const measured = (op === '>=' || op === '>') ? Math.min(...per)
      : (op === '<=' || op === '<') ? Math.max(...per)
        : per[0];
    const cmp = compareAssert(op, measured, a.value, a.value2, a.tol);
    return {
      assert: label, metric, op, measured, limit: a.value,
      phase: a.phase == null ? 'worst of ' + chosen.length : a.phase,
      window: (w.from != null || w.to != null) ? w : null,
      skippedFillMs,
      margin: cmp.margin, relMargin: cmp.rel, pass: cmp.pass,
    };
  }

  // ---- protection coordination ----
  //
  // The elements were already here: relay blocks integrate the IEEE C37.112
  // inverse-time law and trip a breaker by id. What was missing is the study
  // that engineers actually deliver, which is not a waveform at all: the
  // time-current curves of a device chain on one log-log axis, and the
  // selectivity margin between each adjacent pair at every current of interest.
  //
  // The verdict is "selective or not, and by how many milliseconds at what
  // current". A pair is selective when the downstream device clears far enough
  // ahead of its upstream backup that the backup never operates for a fault the
  // downstream one owns. The interval is the coordination time interval (CTI),
  // conventionally 0.2 to 0.4 s for electromechanical upstream devices and
  // tighter for static relays; 0.3 s is a common default and is used here
  // unless the caller says otherwise.
  //
  //   spec = {
  //     chain:    [downstreamId, ..., upstreamId]   // ordered, closest to the fault first
  //     currents: [amps, ...]                       // where to check the margin
  //     cti:      0.3                               // required interval, seconds
  //   }
  //
  // The chain is explicit rather than inferred. Coordination is defined by
  // which device backs up which, and guessing that from topology is exactly the
  // sort of assumption a protection engineer must not have made for them.
  coordination(spec) {
    const s = spec || {};
    const relays = this.S.blocks.filter(b => b.type === 'relay');
    if (!relays.length) return { err: 'No overcurrent relay blocks in this circuit; there is nothing to coordinate.' };
    let chain = Array.isArray(s.chain) ? s.chain.slice() : null;
    if (!chain) {
      if (relays.length === 1) chain = [relays[0].id];
      else {
        return { err: 'This circuit has ' + relays.length + ' relays (' + relays.map(r => '#' + r.id).join(', ')
          + '). Give the chain explicitly, ordered from the device closest to the fault to its backup: '
          + '{ chain: [downstream, ..., upstream] }. Which device backs up which is a protection '
          + 'decision, not something to infer from topology.' };
      }
    }
    const devices = [];
    for (const id of chain) {
      const b = this.S.blocks.find(x => x.id === id);
      if (!b) return { err: 'No block with id ' + id + '.' };
      if (b.type !== 'relay') return { err: 'Block ' + id + ' is a ' + b.type + ', not an overcurrent relay.' };
      const p = b.params;
      const key = String(p.curve || 'VI').toUpperCase().trim();
      const cv = TCC_CURVES[key];
      if (!cv) return { err: 'Relay #' + id + ' has curve "' + p.curve + '"; expected MI, VI or EI.' };
      devices.push({
        blockId: id, curve: key, Ipu: Math.max(+p.Ipu, 1e-6), TD: Math.max(+p.TD || 0.5, 0.01),
        Iinst: +p.Iinst > 0 ? +p.Iinst : null, brkId: p.brkId, cv,
      });
    }

    // Currents to evaluate at. Default to a decade either side of the highest
    // pickup, which is the range a coordination plot conventionally covers.
    const maxPickup = Math.max(...devices.map(d => d.Ipu));
    const currents = Array.isArray(s.currents) && s.currents.length
      ? s.currents.slice().sort((a, b2) => a - b2)
      : logSpace(maxPickup * 1.1, maxPickup * 20, 12);
    const cti = s.cti == null ? 0.3 : +s.cti;

    const curves = devices.map(d => ({
      blockId: d.blockId, curve: d.curve, Ipu: d.Ipu, TD: d.TD, Iinst: d.Iinst, brkId: d.brkId,
      points: logSpace(d.Ipu * 1.01, Math.max(maxPickup * 20, d.Ipu * 20), 60)
        .map(I => ({ I, t: tccTime(d, I) })).filter(pt => pt.t != null),
    }));

    // Pairwise margins, downstream against its immediate backup.
    const pairs = [];
    for (let k = 0; k + 1 < devices.length; k++) {
      const dn = devices[k], up = devices[k + 1];
      const at = currents.map(I => {
        const tDn = tccTime(dn, I), tUp = tccTime(up, I);
        // A device that does not pick up at this current cannot be the one that
        // clears, and saying "selective" about that is meaningless rather than
        // reassuring, so it is reported as not-applicable.
        if (tDn == null || tUp == null) {
          return { I, tDown: tDn, tUp, interval: null, pass: null,
            note: tDn == null ? 'downstream #' + dn.blockId + ' does not pick up at this current'
              : 'upstream #' + up.blockId + ' does not pick up at this current' };
        }
        const interval = tUp - tDn;
        return { I, tDown: tDn, tUp, interval, margin: interval - cti, pass: interval >= cti };
      });
      const checked = at.filter(x => x.pass !== null);
      const worst = checked.length ? checked.reduce((a, b2) => (b2.margin < a.margin ? b2 : a)) : null;
      pairs.push({
        downstream: dn.blockId, upstream: up.blockId,
        pass: checked.length ? checked.every(x => x.pass) : null,
        worst, at,
      });
    }
    const graded = pairs.filter(p => p.pass !== null);
    return {
      cti, nDevices: devices.length,
      pass: graded.length ? graded.every(p => p.pass) : null,
      curves, pairs,
      note: graded.length ? undefined
        : 'No current in the checked range picks up both devices of any pair, so selectivity was not assessed. Give explicit `currents` covering the fault levels you care about.',
    };
  }

  // ---- survivability-weighted availability ----
  //
  // Not a reliability tool. A simulator cannot produce five nines: that number
  // comes from failure rates, repair times and topology, and the data comes
  // from IEEE 493 or vendor MTBF sheets, none of which is in a circuit file.
  //
  // What a simulator can supply is the term every availability calculation
  // silently sets to 1. A 2N system is scored as 2N because the analyst assumes
  // the transfer succeeds; real datacenter outages are dominated by the
  // opposite, the transfer that did not complete. So the caller brings the
  // statistics and OpenEMT brings the conditional probability they get
  // multiplied by, taken from a study that actually ran.
  //
  //   spec = {
  //     hoursPerYear: 8766,
  //     model: <node>
  //   }
  //   node = { name, lambda, mttr }                          // a component
  //        | { name, series:   [node, ...] }                 // all must work
  //        | { name, parallel: [node, ...],                  // redundancy
  //            transfer: { successProb } | { study } }
  //
  // lambda is failures per year, mttr is hours to repair.
  //
  // Redundancy is credited as: you always have the primary, and the BENEFIT of
  // the standby materialises only when the transfer works.
  //   A = A_primary + (A_ideal - A_primary) * p
  // with A_ideal = 1 - prod(1 - Ai), the textbook parallel result. p = 1
  // reduces to the textbook answer and p = 0 to the primary alone, which is the
  // physically right pair of limits: a standby you cannot switch to is worth
  // nothing.
  availability(spec) {
    const s = spec || {};
    if (!s.model) return { err: 'availability needs a { model } describing the topology.' };
    const H = s.hoursPerYear || 8766; // mean Gregorian year
    const assumptions = [];
    const walk = (node, path2) => {
      if (!node || typeof node !== 'object') return { err: 'Malformed node at ' + path2 };
      const here = path2 ? path2 + ' / ' + (node.name || '?') : (node.name || 'system');
      if (Array.isArray(node.series) || Array.isArray(node.parallel)) {
        const kids = (node.series || node.parallel).map(k => walk(k, here));
        const bad = kids.find(k => k.err);
        if (bad) return bad;
        if (node.series) {
          const A = kids.reduce((a, k) => a * k.A, 1);
          return { name: here, kind: 'series', A, of: kids };
        }
        const ideal = 1 - kids.reduce((a, k) => a * (1 - k.A), 1);
        const primary = kids[0].A;
        const tr = node.transfer || {};
        let p, evidence;
        if (tr.study) {
          // The join. A study that ran and passed makes the transition
          // verified; one that failed means the redundancy does not exist in
          // practice, however the block diagram is drawn.
          const st = tr.study;
          p = st.pass ? 1 : 0;
          evidence = 'EMT study: ' + (st.passed != null ? st.passed + ' of ' + st.nCases + ' cases passed' : String(st.pass))
            + (st.worst ? ', worst margin ' + (+st.worst.margin).toPrecision(3) + ' on "' + st.worst.assert + '"' : '');
        } else if (tr.successProb != null) {
          p = +tr.successProb;
          evidence = null;
        } else {
          p = 1;
          evidence = null;
        }
        assumptions.push({
          at: here,
          transferSuccessProbability: p,
          verified: !!tr.study,
          evidence: evidence || (tr.successProb != null
            ? 'ASSUMED: supplied as a number, not backed by a simulation'
            : 'ASSUMED: no transfer probability given, so the redundancy is credited in full'),
        });
        const A = primary + (ideal - primary) * p;
        return { name: here, kind: 'parallel', A, idealA: ideal, primaryA: primary, transferP: p, of: kids };
      }
      const lambda = +node.lambda, mttr = +node.mttr;
      if (!isFinite(lambda) || !isFinite(mttr)) {
        return { err: 'Component "' + here + '" needs numeric lambda (failures/year) and mttr (hours).' };
      }
      const U = Math.min(1, lambda * mttr / H);
      return { name: here, kind: 'component', lambda, mttr, A: 1 - U, U };
    };
    const root = walk(s.model, '');
    if (root.err) return { err: root.err };
    const A = root.A;
    const downMin = (1 - A) * H * 60;
    const unverified = assumptions.filter(a => !a.verified);
    return {
      availability: A,
      nines: A >= 1 ? Infinity : -Math.log10(1 - A),
      downtimeMinutesPerYear: downMin,
      downtimeHoursPerYear: downMin / 60,
      hoursPerYear: H,
      tree: root,
      assumptions,
      // The honest headline. An availability figure whose transfer terms were
      // assumed is the analyst's own assumption reflected back at them, and
      // saying so is the whole point of computing it here rather than in a
      // spreadsheet.
      verdict: assumptions.length === 0
        ? 'No redundancy in this model, so no transfer assumptions were needed.'
        : unverified.length === 0
          ? 'Every redundancy transition in this model is backed by an EMT study that ran.'
          : unverified.length + ' of ' + assumptions.length + ' redundancy transitions are ASSUMED, not '
            + 'simulated. Those are the terms this figure is most sensitive to, and the ones real '
            + 'outages come from.',
    };
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