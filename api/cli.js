#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Hiva Nasiri. Commercial licensing: see LICENSING.md
// api/cli.js - thin CLI front over api/core.js.
//
// Lets a human, a shell script, or CI drive the same pure solver core the UI
// and the MCP server use, without eval-and-stub-the-DOM gymnastics. Output is
// human tables by default and machine-readable JSON with --json.
//
// Usage:
//   openemt catalog [--json]
//   openemt examples
//   openemt pf <case> [--busType <json>] [--json]
//   openemt run <case> [--nph 3] [--Tms 200] [--dt 50] [--plot 0] [--pf] [--json]
//   openemt query <case> --block <id> --signal V|Vrms|I|Irms|P|Q
//                  [--nph 3] [--Tms 200] [--dt 50] [--pf] [--tail] [--json]
//
// <case> is a path to a circuit .json OR the bare name of a shipped example
// (see `openemt examples`); resolveCase() below explains why both.
//
// run/query take their duration, time step, plot step and phase mode from the
// circuit file's saved `sim` block, exactly as the UI does. The flags below
// therefore carry NO commander default: an unset flag must arrive at
// runSimulation() as undefined so the file's value wins. Giving them a default
// here would silently re-impose 120 ms / 3-ph on every case.

'use strict';

const { Command } = require('commander');
const fs = require('fs');
const path = require('path');
const { OpenEMT } = require('./core.js');
// Single source of truth for the version. `require` resolves relative to this
// module, not the working directory, so it finds the package root whether the
// CLI runs from a clone or from inside node_modules. Never restate the version
// as a literal: api/mcp-server.js did, and was still reporting 0.1.0 to every
// client after the package shipped 0.1.1.
const { version: VERSION } = require('../package.json');

const program = new Command();
program.name('openemt')
  .description('OpenEMT headless solver CLI (catalog, power flow, simulation, query).')
  .version(VERSION, '-v, --version', 'Print the OpenEMT version and exit.');


// pf/run/query accept either a path to a circuit file or the bare name of a
// shipped example, as printed by `openemt examples`. Installed from npm there
// is no examples/ directory in the user's cwd, so that name is the only handle
// they have: without this, `openemt examples` advertises names that every
// other command then rejects. A path always wins over an example of the same
// name, and anything containing a separator is treated as a path only.
function resolveCase(em, file) {
  const p = path.resolve(file);
  if (fs.existsSync(p)) return em.loadCircuit(p);
  if (!/[\\/]/.test(file)) {
    // A bare word: the user meant an example name, so answer in those terms.
    // Reporting a resolved absolute path they never typed is just confusing.
    const bare = file.replace(/\.json$/i, '');
    const ex = em.listExamples();
    if (ex.includes(bare)) return em.loadExample(bare);
    return { err: 'No such file or example: ' + file + '\nShipped examples: ' + ex.join(', ') };
  }
  return em.loadCircuit(p); // yields the clean "File not found" error
}


// A single-phase lateral (SPEC §2 phase tap) has ONE real reading, on its own
// phase, so print that phase's index rather than a bare 0 -- a phase-C lateral
// must not read as "phase 0". Ordinary 3-phase and DC signals are unchanged.
function phLbl(q, p) {
  if (q.ph1 !== undefined && q.ph1 !== null) return String(q.ph1);
  return String((q.ph0 || 0) + p);
}

function emit(obj, asJson) {
  if (asJson) { process.stdout.write(JSON.stringify(obj, null, 1) + '\n'); return; }
  // Human tables for known shapes; fallback to JSON for anything else.
  if (Array.isArray(obj) && obj.length && obj[0] && typeof obj[0] === 'object') {
    const cols = Object.keys(obj[0]);
    const w = {}; cols.forEach(c => { w[c] = Math.max(c.length, ...obj.map(r => String(r[c] ?? '').length)); });
    const line = (r) => cols.map(c => String(r[c] ?? '').padEnd(w[c])).join('  ');
    console.log(line(Object.fromEntries(cols.map(c => [c, c]))));
    console.log(cols.map(c => '-'.repeat(w[c])).join('  '));
    obj.forEach(r => console.log(line(r)));
    return;
  }
  console.log(JSON.stringify(obj, null, 1));
}

function fail(msg) { console.error('error: ' + msg); process.exit(1); }

// Where each run setting came from (a --flag, the file's `sim` block, or the
// built-in default). Printed so a headless result is never silently shorter
// than the study the file describes.
function settingsLine(r) {
  const s = r.settingsFrom || {};
  const tag = (k) => (s[k] ? ' (' + s[k] + ')' : '');
  return r.Tms + ' ms' + tag('Tms') + ', ' + r.nph + '-ph' + tag('nph');
}

// ---- catalog ----
program.command('catalog')
  .description('List every block type with its parameters and terminals.')
  .option('--json', 'Emit machine-readable JSON.')
  .action((opts) => {
    const em = new OpenEMT();
    const rows = em.catalog().map(b => ({
      type: b.type, label: b.label, terms: b.terms,
      params: b.params.map(p => p.name + (p.default !== undefined ? '=' + p.default : '')).join(','),
    }));
    emit(rows, opts.json);
  });

// ---- examples ----
program.command('examples')
  .description('List shipped example circuits (examples/*.json).')
  .action(() => {
    const em = new OpenEMT();
    em.listExamples().forEach(n => console.log(n));
  });

// ---- import ----
program.command('import')
  .description('Import a PSS/E RAW case (.raw, revisions 30-36) and convert it to an OpenEMT circuit. Generators become synchronous machines with generic placeholder dynamics.')
  .argument('<file>', 'PSS/E .raw file')
  .option('--out <file>', 'Write the converted circuit JSON to this path (so pf/run can use it).')
  .option('--json', 'Emit machine-readable JSON (conversion metadata + warnings).')
  .action((file, opts) => {
    const em = new OpenEMT();
    const r = em.importCase(path.resolve(file));
    if (r && r.err) fail(r.err);
    if (opts.out) {
      fs.writeFileSync(path.resolve(opts.out), JSON.stringify(em.getCircuit(), null, 1));
    }
    if (opts.json) {
      emit({ nBlocks: r.nBlocks, nWires: r.nWires, vconv: r.vconv, meta: r.meta, warnings: r.warnings, out: opts.out || null }, true);
    } else {
      const m = r.meta || {};
      console.log('imported ' + (m.format || 'case') + ' v' + m.rev + ': ' + m.buses + ' buses, ' +
        m.gens + ' gens, ' + m.loads + ' loads, ' + m.branches + ' branches, ' + m.xfmrs + ' xfmrs, ' + m.shunts + ' shunts');
      console.log('-> ' + r.nBlocks + ' blocks, ' + r.nWires + ' wires (vconv=' + r.vconv + ')');
      (r.warnings || []).forEach(w => console.log('warning: ' + w));
      if (opts.out) console.log('written: ' + opts.out);
      else console.log('(use --out <file.json> to save the converted circuit for pf/run)');
    }
  });

// ---- power flow ----
program.command('pf')
  .description('Solve the positive-sequence power flow of a circuit file.')
  .argument('<file>', 'circuit JSON (webemt:1), or the name of a shipped example')
  .option('--bus-type <json>', 'JSON object {blockId: "slack"|"PV"|"PQ"} overriding block pfType.')
  .option('--json', 'Emit machine-readable JSON.')
  .action((file, opts) => {
    const em = new OpenEMT();
    const lr = resolveCase(em, file);
    if (lr && lr.err) fail(lr.err);
    let busType = undefined;
    if (opts.busType) { try { busType = JSON.parse(opts.busType); } catch (e) { fail('--bus-type: ' + e.message); } }
    const r = em.runPowerFlow({ busType });
    if (r && r.err) fail(r.err);
    if (!r.converged) { console.error('power flow did not converge (iters=' + r.iters + ', mismatch=' + r.maxMismatch + ')'); process.exit(2); }
    const rows = r.buses.map(b => ({
      node: b.node, Vmag: +b.Vmag.toFixed(3), Vpu: +b.Vpu.toFixed(4), angDeg: +b.ang.toFixed(3), type: b.type,
    }));
    // Per-bus rows use each bus block's own Vbase, so pu is correct across mixed
    // voltage levels (the node rows above divide by a single flat Vnom).
    const busRows = (r.busBlocks || []).map(b => ({
      bus: b.name, Vmag: +b.Vmag.toFixed(1), Vpu: +b.Vpu.toFixed(4), angDeg: +b.ang.toFixed(3),
    }));
    if (opts.json) {
      emit({ converged: r.converged, iters: r.iters, maxMismatch: r.maxMismatch, f0: r.f0, Vnom: r.Vnom, buses: rows, busBlocks: busRows }, true);
    } else {
      console.log('converged in ' + r.iters + ' iters, maxMismatch=' + r.maxMismatch.toExponential(2) + ', f0=' + r.f0 + ' Hz, Vnom=' + r.Vnom + ' V');
      if (busRows.length) emit(busRows, false); else emit(rows, false);
    }
  });

// ---- simulation ----
program.command('run')
  .description('Run a time-domain simulation of a circuit file.')
  .argument('<file>', 'circuit JSON (webemt:1), or the name of a shipped example')
  .option('--nph <n>', 'phase count (1 or 3); default: the file\'s saved setting, else 3', v => parseInt(v, 10))
  .option('--Tms <ms>', 'simulation duration in ms; default: the file\'s saved setting, else 120', v => parseFloat(v))
  .option('--dt <us>', 'solver time step in microseconds; default: the file\'s saved setting, else 50', v => parseFloat(v))
  .option('--plot <us>', 'plot decimation in microseconds (0 = auto); default: the file\'s saved setting', v => parseFloat(v))
  .option('--pf', 'Solve the power flow first and start machines at that operating point (the "Init from PF" checkbox).')
  .option('--json', 'Emit machine-readable JSON.')
  .action((file, opts) => {
    const em = new OpenEMT();
    const lr = resolveCase(em, file);
    if (lr && lr.err) fail(lr.err);
    if (opts.pf) {
      const pf = em.runPowerFlow();
      if (pf && pf.err) fail('power flow: ' + pf.err);
      if (!pf.converged) fail('power flow did not converge (iters=' + pf.iters + ', mismatch=' + pf.maxMismatch + ')');
    }
    const r = em.runSimulation({ nph: opts.nph, Tms: opts.Tms, dtUs: opts.dt, plotUs: opts.plot });
    if (r && r.err) fail(r.err);
    const summary = {
      runId: r.runId, stat: r.stat, nph: r.nph, Tms: r.Tms, freqHz: r.freqHz,
      nT: r.nT, tStart: r.tStart, tEnd: r.tEnd, settingsFrom: r.settingsFrom, warnings: r.warnings,
      signals: r.signals.map(s => ({
        blockId: s.blockId, hasV: !!s.hasV, hasI: !!s.hasI, kind: s.kind || null, np: s.np || null,
      })),
    };
    if (opts.json) emit(summary, true);
    else {
      console.log('stat: ' + r.stat);
      console.log('run ' + r.runId + ': ' + r.nT + ' samples, ' + r.tStart + ' to ' + r.tEnd + ' ms, ' + r.freqHz + ' Hz');
      console.log('settings: ' + settingsLine(r));
      (r.warnings || []).forEach(w => console.log('warning: ' + w));
      console.log('queryable signals (blockId, kind, V/I):');
      emit(r.signals.map(s => ({ blockId: s.blockId, kind: s.kind || 'bus/probe', V: s.hasV ? 'Y' : '', I: s.hasI ? 'Y' : '' })), false);
    }
  });

// ---- coord ----
program.command('coord')
  .description('Protective device coordination: time-current curves and selectivity margins.')
  .argument('<file>', 'circuit JSON (webemt:1), or the name of a shipped example')
  .option('--chain <ids>', 'relay block IDs, downstream first: e.g. 3,2', v => v.split(',').map(x => parseInt(x, 10)))
  .option('--currents <amps>', 'currents to check, comma separated', v => v.split(',').map(parseFloat))
  .option('--cti <s>', 'required coordination time interval in seconds (default 0.3)', parseFloat)
  .option('--json', 'Emit machine-readable JSON (includes the full curves).')
  .action((file, opts) => {
    const em = new OpenEMT();
    const lr = resolveCase(em, file);
    if (lr && lr.err) fail(lr.err);
    const r = em.coordination({ chain: opts.chain, currents: opts.currents, cti: opts.cti });
    if (r && r.err) fail(r.err);
    if (opts.json) { emit(r, true); return; }
    console.log((r.pass === null ? 'NOT ASSESSED' : r.pass ? 'SELECTIVE' : 'MISCOORDINATED')
      + ': ' + r.nDevices + ' devices, required interval ' + r.cti + ' s');
    if (r.note) console.log(r.note);
    r.pairs.forEach(p2 => {
      console.log('');
      console.log('#' + p2.downstream + ' backed up by #' + p2.upstream
        + (p2.pass === null ? '  (not assessed)' : p2.pass ? '  selective' : '  MISCOORDINATED'));
      p2.at.forEach(x => {
        const tD = x.tDown == null ? '   -  ' : x.tDown.toFixed(3);
        const tU = x.tUp == null ? '   -  ' : x.tUp.toFixed(3);
        console.log('   ' + String(Math.round(x.I)).padStart(7) + ' A   down ' + tD + ' s   up ' + tU
          + ' s   interval ' + (x.interval == null ? 'n/a' : x.interval.toFixed(3) + ' s')
          + (x.pass === null ? '   (' + x.note + ')' : x.pass ? '' : '   BELOW CTI'));
      });
      if (p2.worst) console.log('   worst: ' + Math.round(p2.worst.I) + ' A, interval '
        + p2.worst.interval.toFixed(3) + ' s, margin ' + p2.worst.margin.toFixed(3) + ' s');
    });
    if (r.pass === false) process.exitCode = 1;
  });

// ---- study ----
// A study takes a JSON spec (see api/core.js runStudy) and returns a verdict
// table rather than a waveform. The spec is a file or inline JSON because it is
// structured enough that flags would be worse than a document.
program.command('study')
  .description('Run a multi-case study with assertions and report pass/fail margins.')
  .argument('<file>', 'circuit JSON (webemt:1), or the name of a shipped example')
  .requiredOption('--spec <path-or-json>', 'study spec: a .json file path, or inline JSON')
  .option('--json', 'Emit machine-readable JSON.')
  .action((file, opts) => {
    const em = new OpenEMT();
    const lr = resolveCase(em, file);
    if (lr && lr.err) fail(lr.err);
    let spec;
    const raw = opts.spec;
    try {
      spec = /^\s*[{[]/.test(raw) ? JSON.parse(raw)
        : JSON.parse(require('fs').readFileSync(raw, 'utf8'));
    } catch (e) { fail('Could not read the study spec: ' + e.message); }
    const r = em.runStudy(spec);
    if (r && r.err) fail(r.err);
    if (opts.json) { emit(r, true); return; }
    console.log((r.pass ? 'PASS' : 'FAIL') + ': ' + r.passed + ' of ' + r.nCases + ' cases passed');
    if (r.worst) {
      console.log('worst margin: ' + r.worst.assert + '  (case "' + r.worst.case + '", measured '
        + fmt(r.worst.measured) + ' vs limit ' + fmt(r.worst.limit) + ', margin ' + fmt(r.worst.margin) + ')');
    }
    console.log('');
    r.cases.forEach(c => {
      console.log((c.pass ? 'PASS ' : 'FAIL ') + c.name + (c.err ? '  [' + c.err + ']' : ''));
      (c.results || []).forEach(x => {
        if (x.err) { console.log('    ERR  ' + x.assert + ': ' + x.err); return; }
        console.log('    ' + (x.pass ? 'ok   ' : 'FAIL ') + x.assert
          + '  measured ' + fmt(x.measured) + ', limit ' + fmt(x.limit) + ', margin ' + fmt(x.margin));
      });
    });
    if (!r.pass) process.exitCode = 1; // usable as a CI gate
  });
function fmt(v) { return v == null ? '-' : (Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(3)); }

// ---- query ----
program.command('query')
  .description('Query a signal from a simulation run by block ID.')
  .argument('<file>', 'circuit JSON (webemt:1), or the name of a shipped example')
  .requiredOption('--block <id>', 'block ID to query', v => parseInt(v, 10))
  .requiredOption('--signal <s>', 'V | Vrms | I | Irms | P | Q')
  .option('--nph <n>', 'phase count (1 or 3); default: the file\'s saved setting, else 3', v => parseInt(v, 10))
  .option('--Tms <ms>', 'simulation duration in ms; default: the file\'s saved setting, else 120', v => parseFloat(v))
  .option('--dt <us>', 'solver time step in microseconds; default: the file\'s saved setting, else 50', v => parseFloat(v))
  .option('--pf', 'Solve the power flow first and start machines at that operating point (the "Init from PF" checkbox).')
  .option('--tail', 'Print only the steady-state (last-cycle) values per phase.')
  .option('--json', 'Emit machine-readable JSON.')
  .action((file, opts) => {
    const em = new OpenEMT();
    const lr = resolveCase(em, file);
    if (lr && lr.err) fail(lr.err);
    if (opts.pf) {
      const pf = em.runPowerFlow();
      if (pf && pf.err) fail('power flow: ' + pf.err);
      if (!pf.converged) fail('power flow did not converge (iters=' + pf.iters + ', mismatch=' + pf.maxMismatch + ')');
    }
    const sim = em.runSimulation({ nph: opts.nph, Tms: opts.Tms, dtUs: opts.dt });
    if (sim && sim.err) fail(sim.err);
    if (!opts.json) (sim.warnings || []).forEach(w => console.error('warning: ' + w));
    const q = em.query(opts.block, opts.signal, { runId: sim.runId });
    if (q && q.err) fail(q.err);
    if (opts.json) emit(q, true);
    else if (opts.tail) {
      console.log('block ' + q.blockId + ' ' + q.signal + ' steady-state per phase:');
      q.steadyState.forEach((v, p) => console.log('  phase ' + phLbl(q, p) + ': ' + (+v).toFixed(4)));
    } else {
      console.log('block ' + q.blockId + ' ' + q.signal + ' (' + q.phases + ' phases), steady-state per phase:');
      q.steadyState.forEach((v, p) => console.log('  phase ' + phLbl(q, p) + ': ' + (+v).toFixed(4)));
      console.log('series length: ' + (q.series[0] ? q.series[0].length : 0) + ' samples (use --json for full arrays)');
    }
  });

program.parseAsync(process.argv).catch(e => { console.error('error: ' + (e.stack || e.message || e)); process.exit(1); });