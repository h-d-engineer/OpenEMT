// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Hiva Nasiri. Commercial licensing: see LICENSING.md
// api/test_api.js - regression guard for the headless API surface.
//
// Exercises the core contract, the CLI, and the MCP server, and ties results
// to analytical/known values so it is a real guard, not just "it ran":
//   - power flow on examples/ieee9bus.json: converged, slack Vmag == syncgen E0
//   - the smoke_test demo circuit built programmatically through the API and
//     checked against the same analytical steady-state formula smoke_test.js
//     uses (proves the API path reproduces the solver path)
//   - by-block-ID query (V, I, P), error paths, programmatic build
//   - CLI: catalog + pf --json
//   - MCP server: 14 tools, run_power_flow converges
//
// Run: node api/test_api.js   (also wired into npm test after smoke_test.)

'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { OpenEMT } = require('./core.js');

const { version: PKG_VERSION } = require('../package.json');

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log('PASS ' + name); }
  else { console.log('FAIL ' + name + (detail ? ' :: ' + detail : '')); failures++; }
}
function approxPct(sim, exp) { return Math.abs(sim - exp) / Math.abs(exp) * 100; }

// ---- power flow on ieee9bus: hard-known slack voltage (syncgen E0) ----
{
  const em = new OpenEMT();
  const lr = em.loadCircuit(path.resolve(__dirname, '..', 'examples', 'ieee9bus.json'));
  // 34, not 35: the outage used to need TWO parallel breakers because a single
  // breaker latched open and could not reclose. The multi-operation breaker
  // (nOps) removed that workaround, so block 35 is gone and breaker 34 now
  // opens and recloses on its own.
  check('load ieee9bus', !(lr && lr.err) && lr.nBlocks === 34, JSON.stringify(lr));
  const pf = em.runPowerFlow();
  check('PF converged', pf.converged, 'iters=' + pf.iters + ' mismatch=' + pf.maxMismatch);
  const slack = pf.buses.find(b => b.type === 'slack') || pf.buses[0];
  check('PF slack Vmag == syncgen E0', approxPct(slack.Vmag, 9526.3) < 0.01, 'Vmag=' + slack.Vmag);
  check('PF has 10 buses', pf.buses.length === 10, 'n=' + pf.buses.length);
}

// ---- PSS/E RAW import (tests/fixtures/psse_3bus.raw): parse -> map -> solve ----
// Hand-written IP-clean 3-bus case (slack + PV + PQ, one line, one 138/13.8
// transformer, a load, and a capacitive + an inductive fixed shunt). Guards the
// parser field maps, the pu->engineering conversions, and the wiring topology:
// the converted circuit must power-flow, the slack/PV buses must hold their RAW
// setpoints, and the 13.8 kV bus behind the transformer must read ~1.0 pu.
{
  const em = new OpenEMT();
  const r = em.importCase(path.resolve(__dirname, '..', 'tests', 'fixtures', 'psse_3bus.raw'));
  check('import psse_3bus', !(r && r.err), JSON.stringify(r && r.err));
  const m = r.meta || {};
  check('import counts (3 bus/2 gen/1 load/1 branch/1 xfmr/2 shunt)',
    m.buses === 3 && m.gens === 2 && m.loads === 1 && m.branches === 1 && m.xfmrs === 1 && m.shunts === 2,
    JSON.stringify(m));
  check('import surfaces generic-dynamics warning', (r.warnings || []).some(w => /dynamics/.test(w)),
    'n=' + (r.warnings || []).length);
  check('import vconv is ll', r.vconv === 'll', r.vconv);
  const pf = em.runPowerFlow();
  check('import PF converged', pf.converged, 'iters=' + pf.iters + ' mismatch=' + pf.maxMismatch);
  const byName = Object.fromEntries((pf.busBlocks || []).map(b => [b.name, b]));
  check('import slack bus at VS=1.03', byName['BUS-1'] && approxPct(byName['BUS-1'].Vpu, 1.03) < 0.5,
    byName['BUS-1'] && byName['BUS-1'].Vpu);
  check('import PV bus at VS=1.01', byName['BUS-2'] && approxPct(byName['BUS-2'].Vpu, 1.01) < 0.5,
    byName['BUS-2'] && byName['BUS-2'].Vpu);
  check('import 13.8kV bus (behind xfmr) ~1.0 pu',
    byName['BUS-3'] && byName['BUS-3'].Vpu > 0.95 && byName['BUS-3'].Vpu < 1.05,
    byName['BUS-3'] && byName['BUS-3'].Vpu);
}

// ---- PSS/E import feature coverage (tests/fixtures/psse_features.raw) ----
// Guards the record variants the basic fixture does not reach, each checked
// against a hand-computed value:
//   CW=2 transformer (winding data in kV, NOT pu of bus base: reading CW wrong
//     silently squares the ratio), 3-winding star/T conversion, ZIP load split,
//     switched shunt at BINIT, and a fixed shunt with both G and B.
// Since 2026-07-23 this case also POWER-FLOWS: buildYbus gained the xfmr3w star
// stamp, so a 3-winding unit no longer blocks the solve.
{
  const em = new OpenEMT();
  const r = em.importCase(path.resolve(__dirname, '..', 'tests', 'fixtures', 'psse_features.raw'));
  check('import psse_features', !(r && r.err), JSON.stringify(r && r.err));
  const m = r.meta || {};
  check('features counts (4 bus/1 zip load/1 2w/1 3w/2 shunt)',
    m.buses === 4 && m.loads === 1 && m.xfmrs === 1 && m.xfmrs3w === 1 && m.shunts === 2,
    JSON.stringify(m));
  const blocks = em.getCircuit().blocks;
  const one = t => blocks.filter(b => b.type === t)[0];

  // ZIP: PL/QL=50/20, IP/IQ=10/4, YP/YQ=5/2 -> totals 65 MW / 26 Mvar,
  // fractions Z=5/65, I=10/65, P=50/65.
  const zip = one('zip');
  check('ZIP load mapped to zip block', !!zip, 'missing');
  check('ZIP totals P=65MW Q=26Mvar', zip && zip.params.P === 65000 && zip.params.Q === 26000,
    zip && (zip.params.P + '/' + zip.params.Q));
  check('ZIP fractions (Z/I/P = 5/10/50 of 65)',
    zip && approxPct(zip.params.az, 5 / 65) < 0.01 && approxPct(zip.params.ai, 10 / 65) < 0.01
      && approxPct(zip.params.ap, 50 / 65) < 0.01,
    zip && [zip.params.az, zip.params.ai, zip.params.ap].join(','));

  // Fixed shunt GL=2 MW, BL=30 Mvar at 230 kV -> parallel RLC:
  // R = V_LL^2/P = 230e3^2/2e6 = 26450 ohm; C = (Q/V^2)/(2*pi*f) = 1.5043 uF.
  const rlcp = one('rlcp');
  check('G+B fixed shunt mapped to rlcp', !!rlcp, 'missing');
  check('rlcp R = V^2/G = 26450 ohm', rlcp && approxPct(rlcp.params.R, 26450) < 0.01, rlcp && rlcp.params.R);
  check('rlcp C = 1.5043 uF', rlcp && approxPct(rlcp.params.C, 1.5043) < 0.1, rlcp && rlcp.params.C);

  // Switched shunt BINIT=15 Mvar at 13.8 kV -> 208.93 uF (pre-v35 field layout,
  // exercising the revision fallback since a v33 file has no "@!" header).
  const cap = one('cap');
  check('switched shunt imported at BINIT', !!cap && approxPct(cap.params.C, 208.93) < 0.1,
    cap && cap.params.C);
  check('switched-shunt warning surfaced', (r.warnings || []).some(w => /switched shunt/i.test(w)),
    JSON.stringify(r.warnings));

  // CW=2: WINDV is already kV. Treating it as pu-of-bus-base would give
  // 230*230 kV. CZ=1 on 100 MVA, 230 kV -> Zbase 529 ohm, R=0.006pu=3.174 ohm.
  const x2 = one('xfmr3');
  check('CW=2 transformer V1=230kV (not 230^2)',
    x2 && approxPct(x2.params.V1, 230000) < 0.01, x2 && x2.params.V1);
  check('CW=2 transformer V2=13.8kV', x2 && approxPct(x2.params.V2, 13800) < 0.01, x2 && x2.params.V2);
  check('CZ=1 leakage R = 0.006pu * 529 = 3.174 ohm',
    x2 && approxPct(x2.params.R, 3.174) < 0.1, x2 && x2.params.R);

  // 3-winding star: X12=0.1, X23=0.2, X31=0.15 pu (CZ=2 on 100 MVA = system
  // base) -> X1=0.025, X2=0.075, X3=0.125 pu; Zbase 529 ohm; /(2*pi*60)*1000 mH.
  const x3 = one('xfmr3w');
  check('3-winding mapped to xfmr3w', !!x3, 'missing');
  check('3W star arms 35.08/105.24/175.40 mH',
    x3 && approxPct(x3.params.L1, 35.08) < 0.1 && approxPct(x3.params.L2, 105.24) < 0.1
      && approxPct(x3.params.L3, 175.40) < 0.1,
    x3 && [x3.params.L1, x3.params.L2, x3.params.L3].join(','));
  check('3W tertiary delta from ANG3=30 -> Yy0d11', x3 && x3.params.conn === 'Yy0d11',
    x3 && x3.params.conn);
  check('3W winding kV 230/13.8/69',
    x3 && x3.params.V1 === 230000 && x3.params.V2 === 13800 && x3.params.V3 === 69000,
    x3 && [x3.params.V1, x3.params.V2, x3.params.V3].join('/'));

  // A case containing a 3-winding unit must now SOLVE (it was refused outright
  // before the xfmr3w star stamp). Slack/PV hold their RAW setpoints, and the
  // delta tertiary (ANG3=30 -> Yy0d11) leads the 13.8 kV winding by ~30 deg,
  // which is the stamp's clock number surviving into the power flow.
  const pf = em.runPowerFlow();
  check('features PF converged (3-winding no longer refused)', pf.converged && !pf.err,
    pf.err || ('iters=' + pf.iters));
  const bn = Object.fromEntries((pf.busBlocks || []).map(b => [b.name, b]));
  check('features PF slack at VS=1.02', bn['FEAT-SLACK'] && approxPct(bn['FEAT-SLACK'].Vpu, 1.02) < 0.5,
    bn['FEAT-SLACK'] && bn['FEAT-SLACK'].Vpu);
  check('features PF tertiary bus energized through the star arm',
    bn['FEAT-TERT'] && bn['FEAT-TERT'].Vpu > 0.95 && bn['FEAT-TERT'].Vpu < 1.05,
    bn['FEAT-TERT'] && bn['FEAT-TERT'].Vpu);
  check('features PF delta tertiary leads winding 2 by ~30 deg',
    bn['FEAT-TERT'] && bn['FEAT-LOAD'] &&
      Math.abs((bn['FEAT-TERT'].ang - bn['FEAT-LOAD'].ang) - 30) < 2,
    bn['FEAT-TERT'] && bn['FEAT-LOAD'] && (bn['FEAT-TERT'].ang - bn['FEAT-LOAD'].ang));
}

// ---- Vector groups (tests/fixtures/psse_vecgrp.raw) -------------------------
// Four identical radial 230/13.8 kV units off one slack, differing only in
// VECGRP and ANG1. Guards the July 2026 delta-winding fix (DECISIONS.md), which
// had three separate ways to go wrong:
//   * WHICH winding is the delta. ANG1 cannot say; VECGRP can. xfmr3's R/L are
//     PER-WINDING, so a delta side's line-basis impedance is 3x its winding
//     value, and putting the delta on the wrong side is a factor-3 impedance
//     error, not a cosmetic phase shift. The two delta units here carry the
//     same nameplate leakage and the same load, so their solved MAGNITUDES must
//     be identical, and they only are if the delta-primary unit's leakage was
//     rebased by 3. (Skip the rebasing and VG-DYN11 reads 0.99749 against
//     VG-YND1's 0.99244: a third of the drop.)
//   * The SIGN. The shift onto winding k is ANGk - ANG1, so ANG1 = -30 puts
//     winding 2 AHEAD, which is what the IEEE harmonics vendor case's own
//     solved angles show.
//   * VECGRP naming a delta while ANG1 = 0, which is how a positive-sequence
//     case normally writes a delta-wye unit. That must stay Yy0 (matching the
//     source case's angles) and be warned about, not silently rotated 30 deg.
// The fixture has no "@!" section headers, so it also guards the positional
// fallback that locates VECGRP past the four optional owner pairs.
{
  const em = new OpenEMT();
  const r = em.importCase(path.resolve(__dirname, '..', 'tests', 'fixtures', 'psse_vecgrp.raw'));
  check('import psse_vecgrp', !(r && r.err), JSON.stringify(r && r.err));
  const xs = em.getCircuit().blocks.filter(b => b.type === 'xfmr3');
  check('vecgrp case has 4 two-winding units', xs.length === 4, 'n=' + xs.length);
  // CZ=1 on 100 MVA, 230 kV -> Zbase 529 ohm: R = 0.006pu = 3.174 ohm,
  // X = 0.06pu = 31.74 ohm -> L = 84.19 mH. A delta primary carries 3x.
  const byConn = c => xs.filter(b => b.params.conn === c);
  check('VECGRP YNd1 + ANG1=-30 -> Yd11 (delta on winding 2, leading)',
    byConn('Yd11').length === 2, xs.map(b => b.params.conn).join(','));
  check('blank VECGRP + ANG1=-30 -> Yd11 (delta assumed on winding 2)',
    byConn('Yd11').length === 2 && byConn('Yd11').every(b => approxPct(b.params.R, 3.174) < 0.1
      && approxPct(b.params.L, 84.19) < 0.1),
    byConn('Yd11').map(b => b.params.R + '/' + b.params.L).join(' '));
  check('VECGRP Dyn11 + ANG1=+30 -> Dy1 (delta on winding 1, lagging)',
    byConn('Dy1').length === 1, xs.map(b => b.params.conn).join(','));
  check('delta primary rebases leakage by 3 (9.522 ohm / 252.6 mH)',
    byConn('Dy1').length === 1 && approxPct(byConn('Dy1')[0].params.R, 9.522) < 0.1
      && approxPct(byConn('Dy1')[0].params.L, 252.58) < 0.1,
    byConn('Dy1').map(b => b.params.R + '/' + b.params.L).join(' '));
  check('VECGRP delta with ANG1=0 stays Yy0', byConn('Yy0').length === 1,
    xs.map(b => b.params.conn).join(','));
  check('silent-delta warning surfaced', (r.warnings || []).some(w => /VECGRP but carry ANG = 0/.test(w)),
    JSON.stringify(r.warnings));

  const pf = em.runPowerFlow();
  check('vecgrp case converges', pf.converged && !pf.err, pf.err || ('iters=' + pf.iters));
  const bn = Object.fromEntries((pf.busBlocks || []).map(b => [b.name, b]));
  const ang = n => bn[n] && bn[n].ang;
  check('Yd11 bus leads the slack by ~30 deg', Math.abs(ang('VG-YND1') - 30) < 1, ang('VG-YND1'));
  check('Dy1 bus lags the slack by ~30 deg', Math.abs(ang('VG-DYN11') + 30) < 1, ang('VG-DYN11'));
  check('blank-VECGRP bus matches the labeled one', Math.abs(ang('VG-BLANK') - ang('VG-YND1')) < 1e-9,
    ang('VG-BLANK') + ' vs ' + ang('VG-YND1'));
  check('ANG1=0 delta label carries no shift', Math.abs(ang('VG-NOANG')) < 1, ang('VG-NOANG'));
  // The sharp one: same leakage, same load, so the delta-primary and
  // delta-secondary units must drop exactly the same voltage.
  const vm = n => bn[n] && bn[n].Vpu;
  check('delta primary and secondary drop the same voltage',
    Math.abs(vm('VG-DYN11') - vm('VG-YND1')) < 1e-9, vm('VG-DYN11') + ' vs ' + vm('VG-YND1'));
  check('...and that drop is real, not a no-load case', vm('VG-YND1') < 0.995, vm('VG-YND1'));
}

// ---- HVDC as scheduled injection (tests/fixtures/psse_hvdc.raw) -------------
// Eleven radial 230 kV spurs off one slack, each carrying a single converter
// terminal, so every terminal's scheduled power is readable straight off the pq
// block wired to its bus. The fixture covers all three DC record types and the
// two rules that are not simply "copy SETVL across":
//   * a link whose DC voltage is regulated at one end (VSC TYPE=1, and the
//     multi-terminal converter named by VCONV) has no schedule of its own and
//     must take exactly minus the sum of the scheduled ends.
//   * SETVL is amps, not MW, when MDC=2, and a blocked link (MDC=0) must inject
//     nothing at all rather than its stale setpoint.
// The scheduled powers are chosen to net to zero across the whole case, so the
// slack is left carrying nothing but network losses: if any sign or any
// balancing rule were wrong the slack would have to make up hundreds of MW.
{
  const em = new OpenEMT();
  const r = em.importCase(path.resolve(__dirname, '..', 'tests', 'fixtures', 'psse_hvdc.raw'));
  check('import psse_hvdc', !(r && r.err), JSON.stringify(r && r.err));
  const cir = em.getCircuit();
  const byId = Object.fromEntries(cir.blocks.map(b => [b.id, b]));
  // pq block -> the name of the bus block it is wired to
  const atBus = {};
  cir.wires.forEach(w => {
    const a = byId[w.a[0]], b = byId[w.b[0]];
    if (a && b && a.type === 'pq' && b.type === 'bus') atBus[b.params.name] = a;
    if (a && b && b.type === 'pq' && a.type === 'bus') atBus[a.params.name] = b;
  });
  const mw = n => atBus[n] && atBus[n].params.P / 1000;
  const pqs = cir.blocks.filter(b => b.type === 'pq');
  check('hvdc case has 9 converter terminals (blocked link contributes none)',
    pqs.length === 9, 'n=' + pqs.length);
  check('two-terminal MDC=1: SETVL is MW, rectifier draws it',
    mw('T2-MW-REC') === 200, mw('T2-MW-REC'));
  check('two-terminal MDC=1: inverter injects the same MW',
    mw('T2-MW-INV') === -200, mw('T2-MW-INV'));
  check('two-terminal MDC=2: 500 A x 400 kV VSCHD -> 200 MW',
    mw('T2-AMP-REC') === 200 && mw('T2-AMP-INV') === -200,
    mw('T2-AMP-REC') + '/' + mw('T2-AMP-INV'));
  check('blocked link (MDC=0) injects nothing at either end',
    mw('T2-OFF-REC') === undefined && mw('T2-OFF-INV') === undefined,
    mw('T2-OFF-REC') + '/' + mw('T2-OFF-INV'));
  check('VSC TYPE=2: DCSET is MW, negative = inverter',
    mw('VSC-MW-INV') === -150, mw('VSC-MW-INV'));
  check('VSC TYPE=1 (DC voltage control) balances the scheduled end',
    mw('VSC-VDC-REC') === 150, mw('VSC-VDC-REC'));
  check('multi-terminal: scheduled converters take SETVL (120 + 80 MW)',
    mw('MT-REC-A') === 120 && mw('MT-REC-B') === 80,
    mw('MT-REC-A') + '/' + mw('MT-REC-B'));
  check('multi-terminal: the VCONV converter balances the other two (-200 MW)',
    mw('MT-VDC-INV') === -200, mw('MT-VDC-INV'));
  check('hvdc warning reports the rectified/inverted totals',
    (r.warnings || []).some(w => /750 MW rectified, 750 MW inverted/.test(w)),
    JSON.stringify(r.warnings));
  check('DC sections no longer counted as skipped',
    !(r.warnings || []).some(w => /Not modeled and skipped.*HVDC/.test(w)),
    JSON.stringify(r.warnings));

  const pf = em.runPowerFlow();
  check('hvdc case converges', pf.converged && !pf.err, pf.err || ('iters=' + pf.iters));
  // 750 MW in, 750 MW out: the slack carries losses only, which on eleven
  // 0.02 pu spurs is single-digit MW. A flipped sign anywhere is hundreds.
  const slackP = pf.genInit[0].pf.P / 1e6;
  check('scheduled injections balance: slack carries losses only',
    slackP > 0 && slackP < 20, slackP + ' MW');
  const bn = Object.fromEntries((pf.busBlocks || []).map(b => [b.name, b]));
  const ang = n => bn[n] && bn[n].ang;
  check('rectifier buses lag the slack, inverter buses lead it',
    ang('T2-MW-REC') < -1 && ang('VSC-VDC-REC') < -1 && ang('MT-REC-A') < -1 &&
    ang('T2-MW-INV') > 1 && ang('VSC-MW-INV') > 1 && ang('MT-VDC-INV') > 1,
    ['T2-MW-REC', 'VSC-VDC-REC', 'MT-REC-A', 'T2-MW-INV', 'VSC-MW-INV', 'MT-VDC-INV']
      .map(n => n + '=' + ang(n).toFixed(2)).join(' '));
  check('a blocked link leaves its buses unloaded (0 deg, 1.0 pu)',
    Math.abs(ang('T2-OFF-REC')) < 1e-6 && Math.abs(bn['T2-OFF-REC'].Vpu - 1) < 1e-9,
    ang('T2-OFF-REC') + ' / ' + bn['T2-OFF-REC'].Vpu);
}

// ---- REV 34+ field layout (tests/fixtures/psse_rev36.raw) -------------------
// REV 34 inserted NREG after IREG in the generator record, so MBASE, ZR, ZX and
// STAT all moved one field later. Read positionally against the pre-34 layout,
// a v34+ file silently yields MBASE where ZR belongs (a machine impedance of
// ~100 pu instead of ~0.004), the wrong machine rating, and GTAP where STAT
// belongs — and since GTAP is 1.0, an OUT-OF-SERVICE generator imports as if it
// were running. Every field below is resolved from the "@!" header by name, so
// this fixture is what keeps that resolution honest. `psse_3bus.raw` has no
// header comments and stays the guard on the positional fallback.
{
  const em = new OpenEMT();
  const r = em.importCase(path.resolve(__dirname, '..', 'tests', 'fixtures', 'psse_rev36.raw'));
  check('rev36 imports', !r.err, r.err || (r.nBlocks + ' blocks'));
  const gens = em.getCircuit().blocks.filter(b => b.type === 'syncgen');
  check('rev36 out-of-service generator dropped (STAT, not GTAP)', gens.length === 1,
    gens.length + ' generator(s), expect 1');
  const g = gens[0];
  // Zbase = 230^2/250 = 211.6 ohm; Ra = 0.004*211.6, Xd = 0.2*211.6 -> L at 60 Hz
  check('rev36 MBASE 250 MVA read past NREG', g && g.params.Sbase === 250000, g && g.params.Sbase);
  check('rev36 ZR -> Ra 0.8464 ohm', g && approxPct(g.params.Ra, 0.8464) < 0.1, g && g.params.Ra);
  check('rev36 ZX -> Ld 112.26 mH', g && approxPct(g.params.Ld, 112.257) < 0.1, g && g.params.Ld);
  // QT/QB (Mvar) -> Qmax/Qmin (kvar). These sit at fields 4/5, AHEAD of the
  // IREG/NREG insertion point, so unlike MBASE/ZR/ZX/STAT they are read
  // positionally and this asserts they were not shifted along with the rest.
  check('rev36 QT/QB -> Qmax/Qmin kvar', g && g.params.Qmax === 150000 && g.params.Qmin === -100000,
    g && (g.params.Qmax + ' / ' + g.params.Qmin));
  const lines = em.getCircuit().blocks.filter(b => b.type === 'line');
  check('rev36 out-of-service branch dropped', lines.length === 1, lines.length + ' line(s), expect 1');
  const pf = em.runPowerFlow();
  check('rev36 PF converged', pf.converged && !pf.err, pf.err || ('iters=' + pf.iters));
}

// ---- import error paths: bad format, legacy revision refused ----
{
  const em = new OpenEMT();
  const bad = em.importCase('this is not a raw file at all\n1,2,3\n');
  check('import rejects non-RAW text', !!(bad && bad.err), JSON.stringify(bad));
  const legacy = em.importCase('0, 100.00, 29, 0, 1, 60.00 / old\nTITLE\nTITLE2\n0 / END OF SYSTEM-WIDE DATA, BEGIN BUS DATA\n');
  check('import refuses pre-30 revision', !!(legacy && legacy.err) && /legacy|not supported|revision/i.test(legacy.err),
    JSON.stringify(legacy && legacy.err));
}

// ---- demo circuit built through the API, checked vs analytical ----
// Same circuit + formula as smoke_test.js: src(Vrms=277,f=60,Rs=0.5) ->
// brk(tclose=30) -> line(R=0.3,L=2mH) -> load(R=12), probe at the load node.
// Steady-state load peak = Vs_peak * R / |Rs+Rl+R + jwL|.
{
  const em = new OpenEMT();
  em.reset();
  // Analytical steady-state reference (same formula as smoke_test.js).
  const Vs = 277 * Math.SQRT2, w = 2 * Math.PI * 60, R = 12, Rs = 0.5, Rl = 0.3, L = 2e-3;
  const Zmag = Math.hypot(Rs + Rl + R, w * L);
  const expected = Vs * R / Zmag;
  const src = em.addBlock('src', { Vrms: 277, f: 60, Rs: 0.5 });
  const brk = em.addBlock('brk', { tclose: 30, topen: -1, init: 0 });
  const line = em.addBlock('line', { R: 0.3, L: 2, Rm: 0, Lm: 0, C: 0 });
  const load = em.addBlock('rlc', { R: 12, L: -1, C: -1 });
  const gnda = em.addBlock('gnd', {});
  const gndb = em.addBlock('gnd', {});
  const probe = em.addBlock('probe', {});
  em.addWire(src, 1, brk, 0);
  em.addWire(brk, 1, line, 0);
  em.addWire(line, 1, load, 0);
  em.addWire(src, 0, gnda, 0);
  em.addWire(load, 1, gndb, 0);
  em.addWire(probe, 0, line, 1);

  const cct = em.getCircuit();
  check('programmatic build: 7 blocks, 6 wires', cct.blocks.length === 7 && cct.wires.length === 6, 'b=' + cct.blocks.length + ' w=' + cct.wires.length);

  const sim = em.runSimulation({ nph: 3, Tms: 120, dtUs: 50 });
  check('demo sim solved', !(sim && sim.err), sim && sim.err);
  if (!sim.err) {
    // Query probe voltage by block ID, phase 0 (matches smoke_test vp[0][0]).
    const q = em.query(probe, 'V', { runId: sim.runId });
    check('demo query V by probe block id', !(q && q.err) && q.series.length >= 1, q && q.err);
    if (!q.err) {
      const t = sim.result.t;
      const v = q.series[0];
      const vmaxPost = Math.max(...v.filter((_, i) => t[i] > 60).map(Math.abs));
      check('demo probe Vpeak vs analytical (<2%)', approxPct(vmaxPost, expected) < 2,
        'sim=' + vmaxPost.toFixed(2) + ' analytical=' + expected.toFixed(2) + ' err=' + approxPct(vmaxPost, expected).toFixed(2) + '%');
    }
    // Current + power through the load, by block id; pure-R load => Q ~ 0.
    const qi = em.query(load, 'I', { runId: sim.runId });
    const qp = em.query(load, 'P', { runId: sim.runId });
    const qq = em.query(load, 'Q', { runId: sim.runId });
    check('demo query I/P/Q by load block id', !qi.err && !qp.err && !qq.err, qp.err || qi.err || qq.err);
    if (!qp.err) {
      const Irms = (Vs / Zmag) / Math.SQRT2;
      const pExp = Irms * Irms * R;
      const pSim = qp.steadyState[0];
      check('demo load P vs Irms^2*R (<3%)', approxPct(pSim, pExp) < 3, 'sim=' + pSim.toFixed(1) + ' exp=' + pExp.toFixed(1));
      check('demo load Q ~ 0 (pure R)', Math.abs(qq.steadyState[0]) < pExp * 0.05, 'Q=' + qq.steadyState[0].toFixed(2));
    }
  }
}

// ---- node frequency at probes/buses (solver.js nodePLL) ----
{
  const em = new OpenEMT();
  em.loadCircuit(path.resolve(__dirname, '..', 'examples', 'ieee9bus.json'));
  const sim = em.runSimulation({ nph: 3, Tms: 600, dtUs: 50 });
  const withF = sim.signals.filter(s => s.hasF);
  check('signals advertise hasF on buses', withF.length > 0, 'n=' + withF.length);
  const q = em.query(withF[0].blockId, 'f', { runId: sim.runId });
  check('query f returns one series', !q.err && q.phases === 1 && q.series.length === 1, JSON.stringify(q.err || q.phases));
  // ieee9bus is a 60 Hz machine case cold-started, so the NETWORK frequency
  // genuinely swings while the machines settle: this checks the reading is on
  // the right nominal and is a real number, not that the PLL is precise.
  // smoke_test.js owns the accuracy claim (0.003 Hz against a clean source).
  check('query f tracks the 60 Hz nominal', !q.err && Math.abs(q.steadyState[0] - 60) < 0.5,
    'f=' + (q.err ? q.err : q.steadyState[0].toFixed(4)));
  const nf = sim.signals.find(s => s.hasV && !s.hasF);
  if (nf) check('query f on a node without one errors', !!em.query(nf.blockId, 'f', { runId: sim.runId }).err);
}

// ---- gtrip cause: which element (59/27/81O/81U) tripped it, via _listSignals ----
{
  const em = new OpenEMT();
  em.reset();
  const src = em.addBlock('src', { Vrms: 277, f: 60, Rs: 0.5 });
  const line = em.addBlock('line', { R: 0.3, L: 15, Rm: 0, Lm: 0, C: 0 });
  const brk = em.addBlock('brk', { tclose: -1, topen: -1, init: 1, nOps: 1 });
  const load = em.addBlock('rlc', { R: 40, L: -1, C: -1 });
  const flt = em.addBlock('fault', { Rf: 0.05, ton: 300, toff: -1, ph: 0 });
  const gt = em.addBlock('gtrip', { brkId: brk, Vov: 0, Vuv: 200, Tdv: 100, Fov: 0, Fuv: 0, Tdf: 300 });
  const gnda = em.addBlock('gnd', {});
  const gndb = em.addBlock('gnd', {});
  em.addWire(src, 1, line, 0);
  em.addWire(src, 0, gnda, 0);
  em.addWire(line, 1, brk, 0);
  em.addWire(brk, 1, load, 0);
  em.addWire(load, 1, gndb, 0);
  em.addWire(flt, 0, line, 1);
  em.addWire(gt, 0, line, 1);
  const sim = em.runSimulation({ nph: 3, Tms: 800, dtUs: 50 });
  check('gtrip 27-trip case solved', !(sim && sim.err), sim && sim.err);
  if (!sim.err) {
    const sig = sim.signals.find(s => s.blockId === gt);
    check('gtrip signal carries a cause field', sig && 'cause' in sig, JSON.stringify(sig));
    check('gtrip cause reports 27 on a bolted-fault undervoltage trip', sig && sig.cause === '27', sig && sig.cause);
  }
}
{
  const em = new OpenEMT();
  em.reset();
  const src = em.addBlock('src', { Vrms: 277, f: 60, Rs: 0.5 });
  const line = em.addBlock('line', { R: 0.3, L: 15, Rm: 0, Lm: 0, C: 0 });
  const brk = em.addBlock('brk', { tclose: -1, topen: -1, init: 1, nOps: 1 });
  const load = em.addBlock('rlc', { R: 40, L: -1, C: -1 });
  const gt = em.addBlock('gtrip', { brkId: brk }); // all thresholds default 0: pure meter, never trips
  const gnda = em.addBlock('gnd', {});
  const gndb = em.addBlock('gnd', {});
  em.addWire(src, 1, line, 0);
  em.addWire(src, 0, gnda, 0);
  em.addWire(line, 1, brk, 0);
  em.addWire(brk, 1, load, 0);
  em.addWire(load, 1, gndb, 0);
  em.addWire(gt, 0, line, 1);
  const sim = em.runSimulation({ nph: 3, Tms: 300, dtUs: 50 });
  check('gtrip disarmed case solved', !(sim && sim.err), sim && sim.err);
  if (!sim.err) {
    const sig = sim.signals.find(s => s.blockId === gt);
    check('gtrip cause is null when the relay never trips', sig && sig.cause === null, sig && sig.cause);
  }
}

// ---- error paths ----
{
  const em = new OpenEMT();
  em.loadCircuit(path.resolve(__dirname, '..', 'examples', 'ieee9bus.json'));
  const sim = em.runSimulation({ nph: 3, Tms: 120 });
  check('query bad block id errors', !!em.query(99999, 'V', { runId: sim.runId }).err);
  check('query unknown signal errors', !!em.query(sim.signals.find(s => s.hasV).blockId, 'Z', { runId: sim.runId }).err);
  check('no-run query errors', !!new OpenEMT().query(1, 'V').err);
  const bad = em.loadCircuit({ webemt: 1, blocks: [{ id: 1, type: 'nonsense', params: {} }], wires: [] });
  check('load rejects unknown block type', !!(bad && bad.err), JSON.stringify(bad));
  const notcircuit = em.loadCircuit({ foo: 1 });
  check('load rejects non-circuit', !!(notcircuit && notcircuit.err), JSON.stringify(notcircuit));
}

// ---- saved run settings travel with the file (headless == UI) ----
// The UI applies a file's `sim` block to the run toolbar; the headless surface
// must do the same or a scripted run of a shipped example measures a different
// study than the one the file describes. central_ups is the concrete case: it
// is saved at 300 ms and its utility breaker trips at 150 ms, so the old hard
// default of 120 ms ended the run BEFORE the only event in the case.
{
  const em = new OpenEMT();
  const lr = em.loadCircuit(path.resolve(__dirname, '..', 'examples', 'central_ups.json'));
  check('loadCircuit reports the file sim block',
    lr.sim && lr.sim.duration === 300 && lr.sim.nph === 3 && lr.sim.pfinit === true, JSON.stringify(lr.sim));
  const pf = em.runPowerFlow();
  check('central_ups PF converged', pf.converged, 'iters=' + pf.iters);
  const r = em.runSimulation();
  check('run with no options honours the file duration (300 ms, not 120)',
    r.Tms === 300 && r.settingsFrom.Tms === 'file', 'Tms=' + r.Tms + ' from=' + JSON.stringify(r.settingsFrom));
  check('run with no options honours the file dt/plot/nph',
    r.settingsFrom.dtUs === 'file' && r.settingsFrom.plotUs === 'file' && r.nph === 3,
    JSON.stringify(r.settingsFrom));
  check('no PF warning once run_power_flow has been called', (r.warnings || []).length === 0,
    JSON.stringify(r.warnings));
  // The 150 ms utility trip is inside the window now: the 480 V switchgear bus
  // is energised at 100 ms and dead at the end of the run.
  const busId = em.S.blocks.find(b => b.type === 'bus').id;
  const q = em.query(busId, 'Vrms', { runId: r.runId });
  const s = q.series[0];
  check('the 150 ms utility trip is inside the honoured window',
    s[Math.floor(s.length * 100 / 300)] > 200 && s[s.length - 1] < 20,
    'V@100ms=' + s[Math.floor(s.length * 100 / 300)] + ' V@end=' + s[s.length - 1]);
  // An explicit option still beats the file (the UI lets you edit the toolbar
  // after loading; the API must not become less controllable than that).
  const r2 = em.runSimulation({ Tms: 40 });
  check('explicit Tms overrides the file setting',
    r2.Tms === 40 && r2.settingsFrom.Tms === 'option' && r2.settingsFrom.dtUs === 'file',
    'Tms=' + r2.Tms + ' from=' + JSON.stringify(r2.settingsFrom));
}
{
  // pfinit:true with no power flow solved => a warning, never a silent auto-PF
  // (CLAUDE.md: runSimulation does not solve the power flow for you).
  const em = new OpenEMT();
  em.loadCircuit(path.resolve(__dirname, '..', 'examples', 'central_ups.json'));
  const r = em.runSimulation({ Tms: 20 });
  check('pfinit file without a PF solve warns', (r.warnings || []).some(w => /Init from PF/.test(w)),
    JSON.stringify(r.warnings));
}
{
  // A programmatically built circuit carries no file settings, so the built-in
  // defaults still apply and existing scripts see no change.
  const em = new OpenEMT();
  const src = em.addBlock('src', { Vrms: 120, f: 60, Rs: 0.1 });
  const load = em.addBlock('rlc', { R: 10, L: -1, C: -1 });
  const g1 = em.addBlock('gnd'); const g2 = em.addBlock('gnd');
  em.addWire(src, 1, load, 0); em.addWire(src, 0, g1, 0); em.addWire(load, 1, g2, 0);
  check('no file => simSettings() is null', em.simSettings() === null, JSON.stringify(em.simSettings()));
  const r = em.runSimulation();
  check('no file => 120 ms / 3-ph defaults unchanged',
    r.Tms === 120 && r.nph === 3 && r.settingsFrom.Tms === 'default', 'Tms=' + r.Tms);
  check('no file => no PF warning', (r.warnings || []).length === 0, JSON.stringify(r.warnings));
  // loadCircuit -> reset must clear the settings, or they leak into the next
  // circuit built on the same OpenEMT instance.
  em.loadCircuit(path.resolve(__dirname, '..', 'examples', 'radial_feeder.json'));
  check('loading a file picks its settings up', (em.simSettings() || {}).duration === 200,
    JSON.stringify(em.simSettings()));
  em.reset();
  check('reset clears the file settings', em.simSettings() === null, JSON.stringify(em.simSettings()));
}

// ---- catalog sanity ----
{
  const em = new OpenEMT();
  const cat = em.catalog();
  check('catalog has 36 block types', cat.length === 36, 'n=' + cat.length);
  const syncgen = cat.find(b => b.type === 'syncgen');
  check('syncgen in catalog with params', syncgen && syncgen.params.length > 0, 'params=' + (syncgen && syncgen.params.length));
  check('examples list non-empty', em.listExamples().length > 0);
}

// ---- CLI via child process ----
{
  const root = path.resolve(__dirname, '..');
  // --version must exist and must agree with package.json: a published CLI
  // that cannot state its own version makes every bug report guesswork.
  for (const flag of ['--version', '-v']) {
    const out = execFileSync('node', [path.join('api', 'cli.js'), flag], { cwd: root, encoding: 'utf8' }).trim();
    check('CLI ' + flag + ' prints the package version', out === PKG_VERSION,
      'got ' + JSON.stringify(out) + ', package.json=' + PKG_VERSION);
  }
  const cat = execFileSync('node', [path.join('api', 'cli.js'), 'catalog', '--json'], { cwd: root, encoding: 'utf8' });
  const catJ = JSON.parse(cat);
  check('CLI catalog --json 36 blocks', Array.isArray(catJ) && catJ.length === 36, 'n=' + (catJ && catJ.length));
  const pf = execFileSync('node', [path.join('api', 'cli.js'), 'pf', path.join('examples', 'ieee9bus.json'), '--json'], { cwd: root, encoding: 'utf8' });
  const pfJ = JSON.parse(pf);
  check('CLI pf --json converged', pfJ.converged && pfJ.buses.length === 10, JSON.stringify(pfJ).slice(0, 80));
  // The CLI's own flag defaults must NOT shadow the file's saved settings: with
  // commander defaults in place, every run silently reverted to 120 ms / 3-ph.
  const runF = JSON.parse(execFileSync('node', [path.join('api', 'cli.js'), 'run',
    path.join('examples', 'central_ups.json'), '--json'], { cwd: root, encoding: 'utf8' }));
  check('CLI run honours the file duration', runF.Tms === 300 && runF.settingsFrom.Tms === 'file',
    'Tms=' + runF.Tms);
  check('CLI run warns about the unsolved PF init', (runF.warnings || []).some(w => /Init from PF/.test(w)),
    JSON.stringify(runF.warnings));
  const runO = JSON.parse(execFileSync('node', [path.join('api', 'cli.js'), 'run',
    path.join('examples', 'central_ups.json'), '--Tms', '40', '--pf', '--json'], { cwd: root, encoding: 'utf8' }));
  check('CLI --Tms overrides the file', runO.Tms === 40 && runO.settingsFrom.Tms === 'option', 'Tms=' + runO.Tms);
  check('CLI --pf clears the PF-init warning', (runO.warnings || []).length === 0, JSON.stringify(runO.warnings));
}

// ---- case resolution: a bare example name, and clean not-found errors ----
// Installed from npm there is no examples/ directory in the user's cwd, so the
// names printed by `openemt examples` are the only handle a user has. They used
// to be rejected by every other command, and a non-existent path was fed to
// JSON.parse, so a typo reported "Unexpected token 'C'" about the user's path.
{
  const root = path.resolve(__dirname, '..');
  // Tolerant runner: a nonzero exit must surface as a FAIL on the check that
  // cares, not as an uncaught throw that aborts every later test in the file.
  const cliTry = (args) => {
    try {
      return { ok: true, out: execFileSync('node', [path.join('api', 'cli.js'), ...args],
        { cwd: root, encoding: 'utf8', stdio: 'pipe' }) };
    } catch (e) {
      return { ok: false, status: e.status, out: String(e.stdout || ''), err: String(e.stderr || '') };
    }
  };
  const jsonOf = (r) => { try { return r.ok ? JSON.parse(r.out) : {}; } catch (e) { return {}; } };

  const rName = cliTry(['run', 'ieee9bus', '--Tms', '20', '--json']);
  const rPath = cliTry(['run', path.join('examples', 'ieee9bus.json'), '--Tms', '20', '--json']);
  const byName = jsonOf(rName), byPath = jsonOf(rPath);
  check('CLI run accepts a bare example name', rName.ok && byName.nT > 0,
    'exit=' + rName.status + ' ' + String(rName.err || '').slice(0, 100));
  check('bare name and path give the same run',
    rName.ok && rPath.ok && byName.nT === byPath.nT && byName.tEnd === byPath.tEnd,
    byName.nT + '/' + byName.tEnd + ' vs ' + byPath.nT + '/' + byPath.tEnd);
  const rPf = cliTry(['pf', 'ieee9bus', '--json']);
  const pfName = jsonOf(rPf);
  check('CLI pf accepts a bare example name', rPf.ok && pfName.converged && pfName.buses.length === 10,
    'exit=' + rPf.status + ' ' + JSON.stringify(pfName).slice(0, 80));

  // A bare word that is not an example is answered in example terms, listing
  // the valid names; a bad PATH is answered as a missing file. Neither may ever
  // surface a JSON syntax error about the user's own argument.
  const rMiss = cliTry(['run', 'no-such-case', '--json']);
  check('CLI unknown case exits nonzero', !rMiss.ok && rMiss.status === 1, 'status=' + rMiss.status);
  check('CLI unknown bare name lists the examples',
    !rMiss.ok && /No such file or example/.test(rMiss.err) && /ieee9bus/.test(rMiss.err)
      && !/Unexpected token/.test(rMiss.err),
    JSON.stringify(String(rMiss.err || '').slice(0, 140)));
  const rBadPath = cliTry(['run', path.join('examples', 'no-such-case.json'), '--json']);
  check('CLI bad path says file not found',
    !rBadPath.ok && /File not found/.test(rBadPath.err) && !/Unexpected token/.test(rBadPath.err),
    JSON.stringify(String(rBadPath.err || '').slice(0, 140)));

  // loadCircuit's path/JSON discrimination, at the core level.
  const em = new OpenEMT();
  const miss = em.loadCircuit(path.join(root, 'examples', 'definitely-absent.json'));
  check('loadCircuit missing path returns err, not a throw', !!(miss && /File not found/.test(miss.err)),
    JSON.stringify(miss));
  const bad = em.loadCircuit('{ "webemt": 1, oops');
  check('loadCircuit malformed JSON returns err', !!(bad && /Could not parse circuit JSON/.test(bad.err)),
    JSON.stringify(bad));
  const em2 = new OpenEMT();
  const asText = fs.readFileSync(path.join(root, 'examples', 'ieee9bus.json'), 'utf8');
  const okStr = em2.loadCircuit(asText);
  check('loadCircuit still accepts a JSON string', !(okStr && okStr.err) && okStr.nBlocks === 34,
    JSON.stringify(okStr).slice(0, 80));
}

// ---- MCP server via SDK client ----
{
  const { Client } = require('@modelcontextprotocol/sdk/client');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  // Run synchronously under a nested main; the MCP check is awaited last.
  global.__mcpCheck = (async () => {
    const tr = new StdioClientTransport({ command: 'node', args: [path.join('api', 'mcp-server.js')] });
    const client = new Client({ name: 'apitest', version: '1.0' }, { capabilities: {} });
    try {
      await client.connect(tr);
      const tools = (await client.listTools()).tools.map(t => t.name);
      check('MCP exposes 15 tools', tools.length === 15, 'n=' + tools.length);
      // The server used to restate its version as a literal and had already
      // drifted: it announced 0.1.0 after the package shipped 0.1.1. Assert it
      // against package.json so the next bump cannot silently repeat that.
      const sv = client.getServerVersion ? client.getServerVersion() : null;
      check('MCP announces the package version',
        !!sv && sv.name === 'openemt' && sv.version === PKG_VERSION,
        'server=' + JSON.stringify(sv) + ' package.json=' + PKG_VERSION);
      const lb = JSON.parse((await client.callTool({ name: 'list_blocks', arguments: {} })).content[0].text);
      check('MCP list_blocks 36', lb.length === 36, 'n=' + lb.length);
      await client.callTool({ name: 'load_example', arguments: { name: 'ieee9bus' } });
      const pf = JSON.parse((await client.callTool({ name: 'run_power_flow', arguments: {} })).content[0].text);
      check('MCP run_power_flow converges', pf.converged && approxPct(pf.buses[0].Vmag, 9526.3) < 0.01, 'Vmag=' + pf.buses[0].Vmag);
      // Same saved-settings contract on the agent surface: ieee9bus is a 500 ms
      // case, so an argument-free run_simulation must be 500 ms, not 120.
      const rf = JSON.parse((await client.callTool({ name: 'run_simulation', arguments: {} })).content[0].text);
      check('MCP run_simulation honours the file duration', rf.Tms === 500 && rf.settingsFrom.Tms === 'file',
        'Tms=' + rf.Tms);
      const ro = JSON.parse((await client.callTool({ name: 'run_simulation', arguments: { Tms: 60 } })).content[0].text);
      check('MCP run_simulation Tms argument overrides the file',
        ro.Tms === 60 && ro.settingsFrom.Tms === 'option', 'Tms=' + ro.Tms);
      const bad = await client.callTool({ name: 'query_results', arguments: { blockId: 99999, signal: 'V' } });
      check('MCP error returns isError', bad.isError === true, 'isError=' + bad.isError);
    } finally {
      await client.close();
    }
  });
}

// ---- study layer ----
// The study layer emits verdicts rather than waveforms, so its own failure
// modes are the dangerous kind: a confident PASS or FAIL for a reason that has
// nothing to do with the circuit.
{
  const em = new OpenEMT();
  em.loadExample('central_ups_sag');

  // The trap this layer was born with. Vrms, Irms, P and Q are windowed over a
  // cycle and ramp from zero while the filter fills, so metric:'min' over a
  // whole run returns roughly zero for every case and reports a confident FAIL
  // about nothing. Assert the fill region is excluded and that the excluded
  // span is reported rather than hidden.
  const fill = em.runStudy({
    run: { Tms: 200, pf: true },
    assert: [{ name: 'fill', block: 15, signal: 'Vrms', metric: 'min', op: '>=', value: 0 }],
  });
  check('study skips the RMS fill region', fill.cases[0].results[0].measured > 200,
    'measured=' + fill.cases[0].results[0].measured);
  check('study reports the skipped fill span', fill.cases[0].results[0].skippedFillMs > 10,
    'skippedFillMs=' + fill.cases[0].results[0].skippedFillMs);

  // A sweep must actually perturb the model. Guarding this because a sweep that
  // silently fails to apply produces identical results across every case, which
  // reads as a robust design rather than as a broken harness.
  const sw = em.runStudy({
    run: { Tms: 300, pf: true },
    sweep: { block: 21, param: 'Rf', values: [1.0, 0.05] },
    assert: [{ name: 'bus', block: 13, signal: 'Vrms', metric: 'min', op: '>=', value: 0 }],
  });
  const [m1, m2] = sw.cases.map(c => c.results[0].measured);
  check('sweep overrides reach the solver', Math.abs(m1 - m2) > 100, m1.toFixed(1) + ' vs ' + m2.toFixed(1));
  check('sweep records what it applied', /Rf = 0.05/.test((sw.cases[1].applied || []).join(',')),
    JSON.stringify(sw.cases[1].applied));

  // The documented behaviour of this case: the battery catches the DC link at
  // about 360 V and the IT load rides through. If the study layer cannot
  // reproduce the example's own README, it is not measuring what it claims.
  const rt = em.runStudy({
    run: { Tms: 500, pf: true },
    sweep: { block: 21, param: 'Rf', values: [1.0, 0.3, 0.05] },
    assert: [
      { name: 'IT rides through', block: 15, signal: 'Vrms', metric: 'min', op: '>=', value: 0.97 * 277 },
      { name: 'DC link held', block: 14, signal: 'Vrms', metric: 'min', op: '>=', value: 280, window: { from: 210, to: 295 } },
    ],
  });
  check('ride-through study passes every fault severity', rt.pass === true,
    rt.passed + '/' + rt.nCases + ' failed=' + JSON.stringify(rt.failedCases));
  check('DC link holds near the documented 360 V',
    Math.abs(rt.cases[2].results[1].measured - 360) < 5, 'measured=' + rt.cases[2].results[1].measured);
  check('study reports a worst margin', rt.worst && rt.worst.relMargin > 0 && rt.worst.relMargin < 1,
    'relMargin=' + (rt.worst && rt.worst.relMargin));

  // A failing criterion must fail, with a negative margin. A verdict layer that
  // cannot say no is decoration.
  const nf = em.runStudy({
    run: { Tms: 200, pf: true },
    assert: [{ name: 'impossible', block: 15, signal: 'Vrms', metric: 'min', op: '>=', value: 1e6 }],
  });
  check('study fails a criterion that cannot hold', nf.pass === false && nf.cases[0].results[0].margin < 0,
    'margin=' + nf.cases[0].results[0].margin);

  // N-1. Losing the utility source is the contingency this facility exists to
  // survive, so the verdict should be that the IT bus stays up: block 1 is the
  // 2.4 kV utility src, and the UPS carries the load without it. This is the
  // study layer reproducing the point of the case, not just running.
  const n1 = em.runStudy({
    run: { Tms: 200 },
    cases: [{ name: 'lose utility', remove: [1] }],
    assert: [{ name: 'IT bus stays up', block: 15, signal: 'Vrms', metric: 'min', op: '>=', value: 200 }],
  });
  check('N-1 removal is applied and reported', /removed #1/.test((n1.cases[0].applied || []).join(',')),
    JSON.stringify(n1.cases[0].applied));
  check('UPS rides through loss of the utility source', n1.pass === true,
    'measured=' + n1.cases[0].results[0].measured);

  // The other direction: a contingency that leaves the circuit unsolvable must
  // report the solver's reason, not pass by default. Ground #18 is load bearing.
  const dead = em.runStudy({
    run: { Tms: 100 },
    cases: [{ name: 'no ground 18', remove: [18] }],
    assert: [{ name: 'any', block: 15, signal: 'Vrms', metric: 'min', op: '>=', value: 1 }],
  });
  check('an unsolvable contingency fails with the solver reason',
    dead.pass === false && /[Ss]ingular/.test(dead.cases[0].err || ''), dead.cases[0].err);

  // Operator coverage and the between/approx forms used for validation checks.
  const ops = em.runStudy({
    run: { Tms: 200, pf: true },
    assert: [
      { name: 'between', block: 15, signal: 'Vrms', metric: 'steady', op: 'between', value: 250, value2: 300 },
      { name: 'approx', block: 15, signal: 'Vrms', metric: 'steady', op: 'approx', value: 277, tol: 10 },
      { name: 'max', block: 15, signal: 'Vrms', metric: 'max', op: '<=', value: 400 },
    ],
  });
  check('between / approx / max operators all evaluate', ops.cases[0].results.every(r => r.pass),
    JSON.stringify(ops.cases[0].results.map(r => r.assert + '=' + r.pass)));

  // A study must leave the instance exactly as it found it. Each case mutates
  // the live circuit to apply its overrides, so without an explicit restore the
  // last case's perturbation silently becomes everyone else's starting point.
  // Caught in development: a study that removed a ground made the NEXT study
  // report a singular matrix on a circuit the caller had never touched.
  const before = JSON.stringify(em.getCircuit());
  em.runStudy({
    run: { Tms: 100 },
    cases: [{ name: 'strip a ground', remove: [18] }, { name: 'retune', set: [{ block: 21, param: 'Rf', value: 9 }] }],
    assert: [{ block: 15, signal: 'Vrms', metric: 'min', op: '>=', value: 1 }],
  });
  check('a study restores the circuit it started from', JSON.stringify(em.getCircuit()) === before,
    'circuit differs after the study');
  const afterStudy = em.runStudy({
    run: { Tms: 200, pf: true },
    assert: [{ block: 15, signal: 'Vrms', metric: 'steady', op: 'between', value: 250, value2: 300 }],
  });
  check('a later study is unaffected by an earlier one', afterStudy.pass === true,
    afterStudy.cases[0].err || JSON.stringify(afterStudy.cases[0].results));

  // Bad input must be refused clearly rather than producing an empty verdict.
  check('study without assertions is refused', !!em.runStudy({ run: { Tms: 50 } }).err, 'no err');
  const badp = em.runStudy({ run: { Tms: 50 }, cases: [{ name: 'x', set: [{ block: 21, param: 'nope', value: 1 }] }],
    assert: [{ block: 15, signal: 'Vrms', metric: 'min', op: '>=', value: 0 }] });
  check('study names an unknown parameter', /has no parameter "nope"/.test(badp.cases[0].err || ''),
    badp.cases[0].err);
}

(async () => {
  if (global.__mcpCheck) await global.__mcpCheck();
  if (failures) { console.error('\n' + failures + ' API test(s) FAILED'); process.exit(1); }
  console.log('\nall API tests passed');
})();