// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Hiva Nasiri. Commercial licensing: see LICENSING.md
// src/import.js — standalone importer for external power-system case files.
//
// Pure module (no DOM). Concatenated into the browser bundle after blocks.js and
// loaded into the api/core.js vm sandbox, so importCase()/parsePsseRaw()/
// caseToCircuit() are callable identically in the browser and headless. No
// runtime dependency on any external tool — clients get only OpenEMT.
//
// Currently supports PSS/E RAW (revisions 30–36). importCase() is the dispatcher
// seam where other vendor formats (PowerWorld .aux, OpenDSS .dss, ...) slot in
// later. See DECISIONS.md for the version-policy and unit-convention rationale.
//
// Unit conventions on the OpenEMT side (see blocks.js): voltages in volts,
// power in kW/kvar, machine base in kVA, R in Ω, L in mH, C in µF. RAW is
// per-unit, so this module does every pu→engineering conversion itself. The
// generated circuit uses vconv:'ll' — all voltage params are line-to-line volts,
// which vPh() (solver.js) divides by √3 internally for the per-phase solve. The
// per-phase impedance base is Zbase = kV_LL² / MVA_3ph, so a pu R/X on that base
// maps straight to per-phase ohms.

// Highest PSS/E revision whose field layout has been validated against a real
// file in this repo's development (v34 savnw, v36 ieee_25bus/savnw). The leading
// fields this importer reads (bus I..VA, load I..QL, gen I..STAT, branch I..STAT,
// the 2-winding transformer block) are stable across v30–v36, so a single field
// map covers the whole band; REV is used only for the accept/warn/refuse gate.
var PSSE_REV_VALIDATED = 36;
var PSSE_REV_MIN = 30; // below this is the legacy fixed-column format (refused)

// Split a PSS/E free-format record line into trimmed fields, honoring single-
// quoted strings that may themselves contain commas.
function _splitRecord(line) {
  var fields = [], cur = '', inQuote = false;
  for (var k = 0; k < line.length; k++) {
    var ch = line[k];
    if (ch === "'") { inQuote = !inQuote; continue; }
    if (ch === ',' && !inQuote) { fields.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  fields.push(cur.trim());
  return fields;
}

function _num(x) { var v = parseFloat(x); return isFinite(v) ? v : 0; }

// Split a PSS/E VECGRP label ('YNd1', 'Dyn1', 'YN0yn0d1', 'YNa0d11') into one
// entry per winding, in winding order: 'D' for a delta winding, 'Y' for a wye
// or autotransformer one (an auto is electrically a wye and carries no shift).
// Letter CASE in an IEC vector group marks HV vs LV, not the connection, so it
// is ignored. Returns [] for a blank or unrecognizable field, which matters:
// VECGRP sits past the optional owner fields, so in a file with no '@!' header
// comment the positional fallback can land on a number, and a number must never
// be read as a vector group.
function _vecWindings(s) {
  var t = String(s || '').replace(/\s+/g, '');
  if (!t || !/^(?:[YDA]N?\d*)+$/i.test(t)) return [];
  return (t.match(/[YDA]N?\d*/gi) || []).map(function (g) {
    return g.charAt(0).toUpperCase() === 'D' ? 'D' : 'Y';
  });
}

// Parse a PSS/E RAW file into a normalized case model. Returns { err } on a
// hard failure (wrong format, unsupported legacy revision) or a model object
// { sbase, rev, f0, buses, loads, shunts, gens, branches, xfmrs, warnings }.
// All records are filtered to in-service (status === 1) where a status exists.
function parsePsseRaw(text) {
  var lines = String(text).split(/\r?\n/);

  // Locate the case-identification line: the first non-comment, non-blank line.
  // Layout: IC, SBASE, REV, XFRRAT, NXFRAT, BASFRQ.
  var idIdx = -1;
  for (var i = 0; i < lines.length; i++) {
    var t = lines[i].trim();
    if (t === '' || t.charAt(0) === '@') continue;
    idIdx = i; break;
  }
  if (idIdx < 0) return { err: 'Empty or unreadable file: not a PSS/E RAW case.' };
  var idf = _splitRecord(lines[idIdx]);
  var sbase = _num(idf[1]) || 100;
  var rev = Math.round(_num(idf[2]));
  var f0 = _num(idf[5]) || 60;

  // Sanity: a real case-ID line has SBASE near a system base (typically 100) and
  // a plausible revision. If neither looks right, this is not a RAW file.
  if (!(sbase > 0) || !(rev > 0)) {
    return { err: 'Not a PSS/E RAW file (no recognizable case-identification line).' };
  }
  var warnings = [];
  if (rev < PSSE_REV_MIN) {
    return { err: 'PSS/E revision ' + rev + ' uses the legacy fixed-column format, ' +
      'which is not supported. Re-save the case as version 33 or newer.' };
  }
  if (rev > PSSE_REV_VALIDATED) {
    warnings.push('PSS/E revision ' + rev + ' is newer than the validated layout (v' +
      PSSE_REV_VALIDATED + '); parsed with the v' + PSSE_REV_VALIDATED +
      ' field map, so verify the result.');
  }

  // Walk sections by the "0 / END OF X DATA, BEGIN Y DATA" markers. Everything
  // before the first marker (case-ID, title lines, system-wide data) sits in the
  // HEADER bucket, which we never read. Unknown/new section names are collected
  // but simply never consumed, so a newer file's extra sections are harmless.
  var section = 'HEADER';
  var sec = {}, hdr = {};
  for (var j = 0; j < lines.length; j++) {
    var ln = lines[j];
    var m = ln.match(/^0\s*\/\s*END OF (.+?) DATA(?:,\s*BEGIN (.+?) DATA)?/i);
    if (m) { section = (m[2] || 'DONE').trim().toUpperCase(); continue; }
    var s = ln.trim();
    if (s === '') continue;
    if (ln.charAt(0) === '@') {
      // v34+ files precede each section with an "@!" column-name comment. Keep
      // the first one per section so fields can be resolved BY NAME: the layout
      // of some sections (switched shunts especially) genuinely differs between
      // revisions, and a name lookup absorbs that instead of misreading it.
      if (hdr[section] === undefined) {
        hdr[section] = _splitRecord(ln.replace(/^@!?/, ''))
          .map(function (x) { return x.replace(/\s+/g, '').toUpperCase(); });
      }
      continue;
    }
    if (s === 'Q' || /^0\s*\/?\s*$/.test(s)) continue; // terminators
    (sec[section] || (sec[section] = [])).push(ln);
  }
  // Index of a named column in a section's "@!" header, or a fallback index
  // when the file has no header comment (older exports).
  function col(secName, name, fallback) {
    var h = hdr[secName];
    if (!h) return fallback;
    var idx = h.indexOf(name);
    return idx >= 0 ? idx : fallback;
  }

  // --- Buses: I, NAME, BASKV, IDE, AREA, ZONE, OWNER, VM, VA ---
  // IDE: 1=PQ, 2=PV(gen), 3=swing/slack, 4=isolated.
  var buses = [], busById = {};
  // Bus metadata resolved by name from the @! header (positional fallbacks match
  // the stable I,NAME,BASKV,IDE,AREA,ZONE,OWNER,VM,VA,NVHI,NVLO layout). AREA/
  // ZONE/OWNER are inert grouping ids; NVHI/NVLO drive the canvas voltage band.
  var bAREA = col('BUS', 'AREA', 4), bZONE = col('BUS', 'ZONE', 5),
      bOWN = col('BUS', 'OWNER', 6), bVHI = col('BUS', 'NVHI', 9), bVLO = col('BUS', 'NVLO', 10);
  (sec['BUS'] || []).forEach(function (l) {
    var f = _splitRecord(l);
    var b = { i: Math.round(_num(f[0])), name: (f[1] || '').trim(),
      baseKV: _num(f[2]), ide: Math.round(_num(f[3])), vm: _num(f[7]), va: _num(f[8]),
      area: Math.round(_num(f[bAREA])), zone: Math.round(_num(f[bZONE])),
      owner: Math.round(_num(f[bOWN])), nvhi: _num(f[bVHI]), nvlo: _num(f[bVLO]) };
    if (b.ide === 4) return; // isolated bus — drop
    buses.push(b); busById[b.i] = b;
  });

  // --- Loads: I, ID, STAT, AREA, ZONE, PL, QL, IP, IQ, YP, YQ ---
  // PL/QL constant power, IP/IQ constant current, YP/YQ constant admittance,
  // the latter two expressed as MW/Mvar drawn at 1.0 pu voltage (the ZIP split).
  var loads = [];
  (sec['LOAD'] || []).forEach(function (l) {
    var f = _splitRecord(l);
    if (Math.round(_num(f[2])) !== 1) return; // out of service
    loads.push({ i: Math.round(_num(f[0])), pl: _num(f[5]), ql: _num(f[6]),
      ip: _num(f[7]), iq: _num(f[8]), yp: _num(f[9]), yq: _num(f[10]) });
  });

  // --- Fixed shunts: I, ID, STATUS, GL, BL  (GL/BL in MW/Mvar at 1.0 pu V) ---
  var shunts = [];
  (sec['FIXED SHUNT'] || []).forEach(function (l) {
    var f = _splitRecord(l);
    if (Math.round(_num(f[2])) !== 1) return;
    var gl = _num(f[3]), bl = _num(f[4]);
    if (gl === 0 && bl === 0) return; // nothing to model
    shunts.push({ i: Math.round(_num(f[0])), gl: gl, bl: bl });
  });

  // --- Switched shunts, imported at their INITIAL admittance (BINIT) ---
  // The switching control itself is not modeled. This section's field order
  // differs between revisions (v36 inserts ID/NREG/NAME), so resolve by column
  // name from the "@!" header when present, with revision-based fallbacks.
  var swIdx = rev >= 35 ? { i: 0, st: 4, b: 11 } : { i: 0, st: 3, b: 9 };
  var cI = col('SWITCHED SHUNT', 'I', swIdx.i);
  var cSt = col('SWITCHED SHUNT', 'ST', swIdx.st);
  var cB = col('SWITCHED SHUNT', 'BINIT', swIdx.b);
  var swOn = 0;
  (sec['SWITCHED SHUNT'] || []).forEach(function (l) {
    var f = _splitRecord(l);
    if (Math.round(_num(f[cSt])) !== 1) return;
    var bl = _num(f[cB]);
    swOn++;
    if (bl === 0) return; // in service but currently switched fully out
    shunts.push({ i: Math.round(_num(f[cI])), gl: 0, bl: bl, switched: true });
  });
  if (swOn > 0) {
    warnings.push(swOn + ' switched shunt(s) imported at their initial step ' +
      '(BINIT); the switching control is not modeled.');
  }

  // --- Generators: I, ID, PG, QG, QT, QB, VS, IREG, [NREG,] MBASE, ZR, ZX,
  //     RT, XT, GTAP, STAT, RMPCT, PT, ... ---
  // Resolved BY NAME from the "@!" header, because REV 34 inserted NREG after
  // IREG and every field from MBASE on therefore shifts by one. Read positionally
  // against the pre-34 layout, a v34+ file yields MBASE for ZR (a machine
  // impedance ~100 pu), ZR for ZX, and GTAP for STAT — so the rating is wrong,
  // the machine impedance is wrong by orders of magnitude, and an out-of-service
  // generator imports as in service because GTAP happens to be 1.0. The
  // positional values below stay as the fallback for exports with no header.
  var gMB = col('GENERATOR', 'MBASE', 8), gZR = col('GENERATOR', 'ZR', 9),
    gZX = col('GENERATOR', 'ZX', 10), gST = col('GENERATOR', 'STAT', 14),
    gPT = col('GENERATOR', 'PT', 16);
  var gens = [];
  (sec['GENERATOR'] || []).forEach(function (l) {
    var f = _splitRecord(l);
    if (Math.round(_num(f[gST])) !== 1) return; // out of service
    // QT/QB (the reactive band) stay POSITIONAL: they sit at 4/5, ahead of the
    // IREG/NREG insertion point, so the v34 shift that moved MBASE onward does
    // not reach them.
    gens.push({ i: Math.round(_num(f[0])), pg: _num(f[2]), qg: _num(f[3]),
      qt: _num(f[4]), qb: _num(f[5]),
      vs: _num(f[6]) || 1, mbase: _num(f[gMB]) || sbase,
      zr: _num(f[gZR]), zx: _num(f[gZX]), pt: _num(f[gPT]) });
  });

  // --- Branches: I, J, CKT, R, X, B, NAME, RATE1..12, GI,BI,GJ,BJ, STAT, ... ---
  // STAT by name too: the positional 23 is 7(name)+12(rates)+4(GI..BJ), which is
  // the v34+ layout. A REV 33 branch record has three ratings and no NAME, so it
  // puts STAT at 13 and the positional read would land on an owner fraction.
  var brST = col('BRANCH', 'STAT', 23);
  // Line-end shunt admittances (GI/BI at the from end, GJ/BJ at the to end), pu
  // on the system MVA base and each end's bus voltage base. Resolved by name from
  // the @! header; the positional fallbacks match the v34+ layout (NAME + 12
  // ratings precede GI,BI,GJ,BJ). REV 33 without a header would misplace these,
  // but line-end shunts are rare (27 of 13,436 branches in the corpus) and the
  // fold-into-C carry below warns when they are present.
  var brGI = col('BRANCH', 'GI', 19), brBI = col('BRANCH', 'BI', 20),
      brGJ = col('BRANCH', 'GJ', 21), brBJ = col('BRANCH', 'BJ', 22);
  // Ratings (MVA), metered end, and line length — inert metadata on the line
  // block (RATE1..3, metre, LEN), used for a loading readout. Positional
  // fallbacks match the v34+ layout (NAME + 12 ratings precede GI..BJ; MET/LEN
  // follow STAT).
  var brR1 = col('BRANCH', 'RATE1', 7), brR2 = col('BRANCH', 'RATE2', 8),
      brR3 = col('BRANCH', 'RATE3', 9), brMET = col('BRANCH', 'MET', 24),
      brLEN = col('BRANCH', 'LEN', 25);
  var branches = [];
  (sec['BRANCH'] || []).forEach(function (l) {
    var f = _splitRecord(l);
    if (Math.round(_num(f[brST])) !== 1) return;
    branches.push({ i: Math.round(_num(f[0])), j: Math.round(_num(f[1])),
      r: _num(f[3]), x: _num(f[4]), b: _num(f[5]),
      gi: _num(f[brGI]), bi: _num(f[brBI]), gj: _num(f[brGJ]), bj: _num(f[brBJ]),
      rate1: _num(f[brR1]), rate2: _num(f[brR2]), rate3: _num(f[brR3]),
      metre: Math.round(_num(f[brMET])), len: _num(f[brLEN]) });
  });

  // --- Transformers (multi-line records) ---
  // General line: I,J,K,CKT,CW,CZ,CM,MAG1,MAG2,NMETR,NAME,STAT,...
  //   CW = winding data I/O code (1 = pu of bus base, 2 = kV, 3 = pu of NOMV)
  //   CZ = impedance code (1 = pu on system base, 2 = pu on winding MVA base,
  //        3 = load loss in watts + |Z| pu on winding base)
  // 2-winding (K==0): 4 lines — general / impedance(R1-2,X1-2,SBASE1-2) /
  //   winding1(WINDV1,NOMV1,ANG1,...) / winding2(WINDV2,NOMV2,...).
  // 3-winding (K!=0): 5 lines — impedance line carries all three winding PAIRS
  //   (R1-2,X1-2,SBASE1-2, R2-3,X2-3,SBASE2-3, R3-1,X3-1,SBASE3-1, ...) which
  //   the mapper converts to a star (T) equivalent.
  var xfmrs = [], xfmrs3w = [];
  // VECGRP (the winding-connection label) is the last quoted field on the
  // general line, after the four optional owner pairs. Resolve it by name from
  // the '@!' header when there is one; the positional fallback matches the
  // stable ...,O4,F4,'VECGRP',ZCOD layout. _vecWindings() rejects anything that
  // is not a vector group, so a headerless file landing on a number is safe.
  var xVEC = col('TRANSFORMER', 'VECGRP', 20);
  var tl = sec['TRANSFORMER'] || [];
  for (var k2 = 0; k2 < tl.length;) {
    var g = _splitRecord(tl[k2]);
    var K = Math.round(_num(g[2]));
    var cw = Math.round(_num(g[4])) || 1;
    var cz = Math.round(_num(g[5])) || 1;
    var stat = Math.round(_num(g[11]));
    var zl = _splitRecord(tl[k2 + 1] || '');
    var w1 = _splitRecord(tl[k2 + 2] || '');
    var w2 = _splitRecord(tl[k2 + 3] || '');
    var common = { i: Math.round(_num(g[0])), j: Math.round(_num(g[1])),
      cw: cw, cz: cz,
      windv1: _num(w1[0]) || 1, nomv1: _num(w1[1]), ang1: _num(w1[2]),
      windv2: _num(w2[0]) || 1, nomv2: _num(w2[1]), ang2: _num(w2[2]),
      vecgrp: (g[xVEC] || '').trim(),
      mag1: _num(g[7]), mag2: _num(g[8]) }; // MAG1/MAG2: magnetizing G/B, pu on SBASE1-2, winding-1 base
    if (K !== 0) {
      var w3 = _splitRecord(tl[k2 + 4] || '');
      if (stat === 1) {
        xfmrs3w.push(Object.assign(common, { k: K,
          r12: _num(zl[0]), x12: _num(zl[1]), sb12: _num(zl[2]) || sbase,
          r23: _num(zl[3]), x23: _num(zl[4]), sb23: _num(zl[5]) || sbase,
          r31: _num(zl[6]), x31: _num(zl[7]), sb31: _num(zl[8]) || sbase,
          windv3: _num(w3[0]) || 1, nomv3: _num(w3[1]), ang3: _num(w3[2]) }));
      }
      k2 += 5;
    } else {
      if (stat === 1) {
        xfmrs.push(Object.assign(common, {
          r: _num(zl[0]), x: _num(zl[1]), sbase12: _num(zl[2]) || sbase }));
      }
      k2 += 4;
    }
  }

  // --- HVDC converters -> scheduled real-power injections -------------------
  // The DC side is not modeled at all. Each converter TERMINAL becomes a
  // scheduled real power at its AC bus, which is what a DC link is to the AC
  // network in a positive-sequence case: a rectifier is a load of P MW, an
  // inverter is a source of P MW. That restores the power balance without a
  // converter model, and the balance is the whole problem: PSS/E's own sample
  // case moves ~5000 MW through DC links, so with them dropped its AC islands
  // have no solution to converge to (2990 MW of generation at bus 301 feeding
  // nothing at all). Reactive consumption, converter loss and DC line loss are
  // NOT represented; the warning below says so.
  //
  // Sign convention on dcInj[].p: MW DRAWN FROM the AC bus, so a rectifier is
  // positive and an inverter negative — the same sense as the pq block's P,
  // which is what caseToCircuit() maps these onto.
  var dcInj = [], dcSkip = [];
  // One DC system's terminals, where some ends carry a scheduled power and the
  // rest regulate DC voltage. A voltage-regulating converter has no schedule of
  // its own: it is the DC network's slack and takes whatever the scheduled ends
  // leave over, which with DC losses ignored is exactly minus their sum.
  function pushDcSet(name, terms) {
    var sum = 0, nsl = 0;
    terms.forEach(function (t) { if (t.slack) nsl++; else sum += t.p; });
    terms.forEach(function (t) {
      dcInj.push({ bus: t.bus, p: t.slack ? -sum / nsl : t.p, name: name });
    });
  }

  // Two-terminal DC: three lines per link (control / rectifier / inverter).
  // Control line: 'NAME', MDC, RDC, SETVL, VSCHD, ... with MDC 0 = blocked,
  // 1 = SETVL is MW, 2 = SETVL is DC amps (x the scheduled DC kV -> MW).
  // Converter lines start with the AC converter bus (IPR then IPI).
  var dMDC = col('TWO-TERMINAL DC', 'MDC', 1),
      dSET = col('TWO-TERMINAL DC', 'SETVL', 3),
      dVSC = col('TWO-TERMINAL DC', 'VSCHD', 4);
  var ttdc = sec['TWO-TERMINAL DC'] || [];
  for (var d2 = 0; d2 + 2 < ttdc.length; d2 += 3) {
    var c1 = _splitRecord(ttdc[d2]);
    var dnm = (c1[0] || '').trim() || 'two-terminal DC';
    var mdc = Math.round(_num(c1[dMDC]));
    if (mdc === 0) continue; // blocked: carries nothing
    if (mdc > 2) { dcSkip.push(dnm); continue; }
    var pmw;
    if (mdc === 2) {
      var vsch = _num(c1[dVSC]);
      if (!vsch) { dcSkip.push(dnm); continue; } // amps with no scheduled kV to scale by
      pmw = _num(c1[dSET]) * vsch / 1000;
    } else pmw = _num(c1[dSET]);
    if (!pmw) continue; // in service but scheduled at zero: carries nothing
    pushDcSet(dnm, [
      { bus: Math.round(_num(_splitRecord(ttdc[d2 + 1])[0])), p: pmw },
      { bus: Math.round(_num(_splitRecord(ttdc[d2 + 2])[0])), p: -pmw }]);
  }

  // VSC DC line: three lines per link (control / converter / converter).
  // Converter line: IBUS, TYPE, MODE, DCSET, ACSET, ... with TYPE 0 = out of
  // service, 1 = DC voltage control (DCSET is kV, so this end is the DC slack),
  // 2 = MW control (DCSET is the DC-side MW, positive for rectifier operation).
  var vMDC = col('VSC DC LINE', 'MDC', 1);
  var vsdc = sec['VSC DC LINE'] || [];
  for (var d3 = 0; d3 + 2 < vsdc.length; d3 += 3) {
    var v1 = _splitRecord(vsdc[d3]);
    var vnm = (v1[0] || '').trim() || 'VSC DC line';
    if (Math.round(_num(v1[vMDC])) === 0) continue; // out of service
    var vt = [];
    for (var vq = 1; vq <= 2; vq++) {
      var cv = _splitRecord(vsdc[d3 + vq]);
      var vty = Math.round(_num(cv[1]));
      if (vty === 0) continue; // this converter is out of service
      vt.push({ bus: Math.round(_num(cv[0])), p: _num(cv[3]), slack: vty === 1 });
    }
    if (vt.length) pushDcSet(vnm, vt);
  }

  // Multi-terminal DC: a variable-length record — one header line, then NCONV
  // converter lines, NDCBS DC bus lines and NDCLN DC link lines, none of which
  // this importer reads beyond the converters. Header: 'NAME', NCONV, NDCBS,
  // NDCLN, MDC, VCONV, ... where VCONV names the AC bus of the DC voltage-
  // regulating converter (the DC slack) and MDC 1 = power control. A converter
  // line's SETVL (field 12) is then its scheduled MW, positive for rectifier
  // operation.
  var mtdc = sec['MULTI-TERMINAL DC'] || [];
  for (var d4 = 0; d4 < mtdc.length;) {
    var h1 = _splitRecord(mtdc[d4]);
    var nconv = Math.round(_num(h1[1]));
    if (!(nconv > 0)) break; // unreadable header: stop rather than mis-walk the rest
    var mnm = (h1[0] || '').trim() || 'multi-terminal DC';
    var mmdc = Math.round(_num(h1[4])), vconv = Math.round(_num(h1[5]));
    if (mmdc === 1) {
      var mt = [], nvc = 0;
      for (var mq = 0; mq < nconv; mq++) {
        var mc = _splitRecord(mtdc[d4 + 1 + mq] || '');
        var mib = Math.round(_num(mc[0]));
        if (mib === vconv) nvc++;
        mt.push({ bus: mib, p: _num(mc[12]), slack: mib === vconv });
      }
      // Without the voltage-regulating converter there is no way to tell which
      // SETVL is a scheduled kV rather than MW, so take none of them.
      if (nvc) pushDcSet(mnm, mt); else dcSkip.push(mnm);
    } else if (mmdc !== 0) dcSkip.push(mnm);
    d4 += 1 + nconv + Math.round(_num(h1[2])) + Math.round(_num(h1[3]));
  }

  if (dcInj.length) {
    var pRec = 0, pInv = 0;
    dcInj.forEach(function (t) { if (t.p > 0) pRec += t.p; else pInv -= t.p; });
    warnings.push(dcInj.length + ' HVDC converter terminal(s) imported as scheduled ' +
      'real-power injections (' + pRec.toFixed(0) + ' MW rectified, ' + pInv.toFixed(0) +
      ' MW inverted). The DC side itself is not modeled, and neither is converter ' +
      'reactive consumption, converter loss or DC line loss, so voltages near a ' +
      'converter bus will not match the source case. The injection is a constant-' +
      'power source: right for a power flow, not for an EMT transient.');
  }
  if (dcSkip.length) {
    warnings.push('No scheduled power could be derived for HVDC link(s) ' +
      dcSkip.join(', ') + ': the control mode is one this importer cannot reduce ' +
      'to a real-power schedule (current regulation with no scheduled DC voltage ' +
      'to scale by, or a multi-terminal system whose voltage-regulating converter ' +
      'is not among its own converters). They are skipped, and the power they ' +
      'carried is missing from the balance.');
  }

  // --- Records we do not model, but which CARRY POWER -----------------------
  // Silently dropping these is how a converter bus ends up with nothing attached
  // and the power flow reports it de-energized, or how a case that balances in
  // PSS/E ends up thousands of MW short here. The parser knows exactly how many
  // of each it skipped, so say so rather than leaving the user to work it out
  // from a divergence message.
  // Counted in RECORD LINES, not devices: a two-terminal DC link is three lines
  // and a multi-terminal system is many, so a device count would be a guess.
  var SKIPPED = [
    ['FACTS DEVICE', 'FACTS device'],
    ['INDUCTION MACHINE', 'induction machine'],
    ['MULTI-SECTION LINE', 'multi-section line'],
    ['SYSTEM SWITCHING DEVICE', 'node-breaker switching device'],
    ['GNE', 'generic network element']
  ];
  var skipped = [];
  SKIPPED.forEach(function (s) {
    var n = (sec[s[0]] || []).length;
    if (n > 0) skipped.push(n + ' ' + s[1] + ' record' + (n > 1 ? 's' : ''));
  });
  if (skipped.length) {
    warnings.push('Not modeled and skipped: ' + skipped.join(', ') +
      '. Buses reached only through these have no AC connection here, and any ' +
      'power they carried is missing from the balance, so the power flow may ' +
      'not match the source case.');
  }

  return { sbase: sbase, rev: rev, f0: f0, buses: buses, loads: loads,
    shunts: shunts, gens: gens, branches: branches, xfmrs: xfmrs,
    xfmrs3w: xfmrs3w, dcInj: dcInj, warnings: warnings };
}

// Convert a normalized case model into an OpenEMT circuit JSON object plus a
// warnings array. Returns { circuit, warnings }.
function caseToCircuit(c) {
  var TWO_PI_F = 2 * Math.PI * (c.f0 || 60);
  var warnings = (c.warnings || []).slice();
  var blocks = [], wires = [];
  var nextId = 1;
  function newId() { return nextId++; }
  // Per-phase impedance base from line-to-line kV and 3-phase MVA.
  function zbase(kvLL, mva) { return (kvLL * kvLL) / mva; }

  // Grid placement of buses; elements hang off their bus at small offsets. These
  // coordinates only need to render; the browser re-runs busAwareLayout() after.
  var busList = c.buses;
  var cols = Math.max(1, Math.ceil(Math.sqrt(busList.length)));
  var COLW = 520, ROWH = 360;

  // Count incidence per bus so each bus block gets enough taps (+1 for a probe).
  var inc = {};
  function bump(id) { inc[id] = (inc[id] || 0) + 1; }
  c.branches.forEach(function (br) { bump(br.i); bump(br.j); });
  c.xfmrs.forEach(function (t) { bump(t.i); bump(t.j); });
  (c.xfmrs3w || []).forEach(function (t) { bump(t.i); bump(t.j); bump(t.k); });
  c.gens.forEach(function (gn) { bump(gn.i); });
  c.loads.forEach(function (ld) { bump(ld.i); });
  c.shunts.forEach(function (sh) { bump(sh.i); });
  (c.dcInj || []).forEach(function (t) { bump(t.bus); });

  // Create one bus block per bus; track a running tap cursor for wiring.
  var busInfo = {}; // rawBusId -> { blockId, x, y, tap }
  busList.forEach(function (b, idx) {
    var taps = Math.max(1, (inc[b.i] || 0) + 1);
    var x = 200 + (idx % cols) * COLW;
    var y = 120 + Math.floor(idx / cols) * ROWH;
    var id = newId();
    // Bar length must follow the tap count at the project-wide 50 world units
    // per tap (DEFS.bus defaults to taps 1 / len 50, and the bus-aware
    // auto-layout writes len = 50 * taps). This used to be a hardcoded 200,
    // so every imported bus came out the same physical size regardless of how
    // many things hung off it: two-tap buses were drawn as long empty bars and
    // eight-tap buses were cramped, which is most of why a freshly imported
    // case reads as clutter before you run auto-layout on it.
    blocks.push({ id: id, type: 'bus', x: x, y: y, rot: 0,
      params: { name: b.name || ('Bus ' + b.i), taps: taps, len: 50 * taps,
        Vbase: b.baseKV * 1000,
        Vhi: b.nvhi > 0 ? b.nvhi : 0, Vlo: b.nvlo > 0 ? b.nvlo : 0,
        area: b.area || 0, zone: b.zone || 0, owner: b.owner || 0 } });
    busInfo[b.i] = { blockId: id, x: x, y: y, tap: 0, va: b.va };
  });
  function takeTap(rawId) { var bi = busInfo[rawId]; return bi ? bi.tap++ : -1; }

  // Ground helper: create a gnd block near (x,y) and return its id.
  function addGnd(x, y) {
    var id = newId();
    blocks.push({ id: id, type: 'gnd', x: x, y: y, rot: 90, params: {} });
    return id;
  }

  function busOf(rawId) { return busInfo[rawId]; }
  // Raw bus records by id. A map, not a scan: a utility-scale case has enough
  // buses that a per-element linear search would be quadratic.
  var busRecById = {};
  busList.forEach(function (b) { busRecById[b.i] = b; });
  function busRec(rawId) { return busRecById[rawId] || { baseKV: 1, ide: 1 }; }

  // --- Generators -> syncgen (dispatch from RAW; dynamics are placeholders) ---
  var gaveDynWarning = false;
  c.gens.forEach(function (gn) {
    var bi = busOf(gn.i); if (!bi) return;
    var bus = busRec(gn.i);
    var kvLL = bus.baseKV || 1;
    // Machine source impedance ZR/ZX (pu on MBASE, machine-terminal kV) -> ohms.
    var zbM = zbase(kvLL, gn.mbase);
    var Ra = gn.zr > 0 ? gn.zr * zbM : 0.005 * zbM;
    var Xd = gn.zx > 0 ? gn.zx * zbM : 0.25 * zbM;
    var Ld_mH = Xd / TWO_PI_F * 1000;
    var Vset = gn.vs * kvLL * 1000; // line-to-line volts
    var Sbase_kvar = gn.mbase * 1000;
    var Ptot = (gn.pt > 0 ? gn.pt : Math.max(gn.pg, 1)) * 1000; // kW, for droop
    // AVR droop stiff enough that the full reactive range moves terminal voltage
    // by ~5%, so a PV bus regulates near its setpoint like PSS/E's ideal PV bus.
    var mq = 0.05 * Vset / Sbase_kvar;
    var isSlack = bus.ide === 3;
    // Reactive band QT/QB (Mvar) -> Qmax/Qmin (kvar). PSS/E writes +/-9999 for
    // "unlimited"; the block's own convention for that is 0/0, so map the
    // sentinel rather than carrying a band no machine could ever reach. A pair
    // with QT === QB is NOT a sentinel: it is the standard way of writing a
    // machine that holds a fixed reactive output, and the solver starts such a
    // bus as PQ.
    var qt = gn.qt, qb = gn.qb;
    if (qt >= 9000 && qb <= -9000) { qt = 0; qb = 0; }
    var id = newId();
    blocks.push({ id: id, type: 'syncgen', x: bi.x - 260, y: bi.y + 40, rot: 0,
      params: {
        H: 4.0, Sbase: Sbase_kvar, Ra: Ra, Ld: Ld_mH, f0: c.f0,
        E0: Vset, Pm0: gn.pg * 1000, Q0: gn.qg * 1000,
        Kgov: Ptot / (0.05 * c.f0), D: 0, mq: mq, Tf: 20,
        pfType: isSlack ? 'slack' : 'PV', Vset: Vset,
        Qmax: qt * 1000, Qmin: qb * 1000
      } });
    var gid = addGnd(bi.x - 340, bi.y + 44);
    wires.push({ a: [id, 1], b: [bi.blockId, takeTap(gn.i)] }); // machine term -> bus
    wires.push({ a: [id, 0], b: [gid, 0] });                    // neutral -> ground
    if (!gaveDynWarning) {
      warnings.push('Generator dynamics (inertia H, governor droop) are generic ' +
        'placeholders: a RAW file has no dynamic data. Set per-machine values (or ' +
        'import a DYR) before trusting EMT transient results.');
      gaveDynWarning = true;
    }
  });

  // --- Loads -> pq (pure constant power) or zip (when RAW carries I/Y parts) ---
  // RAW splits a load into constant power (PL/QL), constant current (IP/IQ) and
  // constant admittance (YP/YQ), all in MW/Mvar at 1.0 pu. The zip block wants
  // the total at V0 plus the Z/I/P fractions, so normalize by the total.
  c.loads.forEach(function (ld, idx) {
    var bi = busOf(ld.i); if (!bi) return;
    var id = newId();
    var y = bi.y + 120 + (idx % 3) * 90;
    var pTot = ld.pl + ld.ip + ld.yp;
    var qTot = ld.ql + ld.iq + ld.yq;
    var isZip = (ld.ip || ld.iq || ld.yp || ld.yq);
    if (isZip) {
      var bus = busRec(ld.i);
      var frac = function (z, i, p, tot) {
        return tot ? [z / tot, i / tot, p / tot] : [0, 0, 1];
      };
      var fp = frac(ld.yp, ld.ip, ld.pl, pTot);
      var fq = frac(ld.yq, ld.iq, ld.ql, qTot);
      blocks.push({ id: id, type: 'zip', x: bi.x + 260, y: y, rot: 0,
        params: { P: pTot * 1000, Q: qTot * 1000, V0: (bus.baseKV || 1) * 1000,
          az: fp[0], ai: fp[1], ap: fp[2], bz: fq[0], bi: fq[1], bp: fq[2] } });
    } else {
      blocks.push({ id: id, type: 'pq', x: bi.x + 260, y: y, rot: 0,
        params: { P: ld.pl * 1000, Q: ld.ql * 1000 } });
    }
    var gid = addGnd(bi.x + 360, y + 4);
    wires.push({ a: [id, 0], b: [bi.blockId, takeTap(ld.i)] });
    wires.push({ a: [id, 1], b: [gid, 0] });
  });

  // --- HVDC converter terminals -> a scheduled P at the AC bus --------------
  // dcInj[].p is MW drawn FROM the bus (rectifier positive, inverter negative)
  // and the pq block's P is drawn from its terminal too, so the sign carries
  // straight across. Q is zero: the parser's warning explains why.
  var dcOff = [];
  (c.dcInj || []).forEach(function (t, idx) {
    var bi = busOf(t.bus);
    if (!bi) { dcOff.push(t.bus); return; }
    var id = newId();
    var y = bi.y + 120 + (idx % 3) * 90;
    blocks.push({ id: id, type: 'pq', x: bi.x + 260, y: y, rot: 0,
      params: { P: t.p * 1000, Q: 0 } });
    var gid = addGnd(bi.x + 360, y + 4);
    wires.push({ a: [id, 0], b: [bi.blockId, takeTap(t.bus)] });
    wires.push({ a: [id, 1], b: [gid, 0] });
  });
  if (dcOff.length) {
    warnings.push('HVDC converter(s) at bus ' + dcOff.join(', ') + ' sit on a bus ' +
      'that is not in the case (isolated or out of service), so their scheduled ' +
      'power is not injected.');
  }

  // --- Shunts (fixed + switched-at-BINIT) -> cap / reactor / parallel RLC ---
  // GL and BL are MW and Mvar drawn at 1.0 pu, so the per-phase admittance is
  // Y = S_va / V_LL^2 (because 3*Vph^2*Y = V_LL^2*Y). A pure susceptance becomes
  // a cap (BL>0) or an inductor (BL<0); with a conductance too it becomes a
  // PARALLEL RLC, since a shunt G + jB is an admittance sum, not a series branch.
  c.shunts.forEach(function (sh, idx) {
    var bi = busOf(sh.i); if (!bi) return;
    var vLL = (busRec(sh.i).baseKV || 1) * 1000;
    var B = Math.abs(sh.bl) * 1e6 / (vLL * vLL);
    var G = Math.abs(sh.gl) * 1e6 / (vLL * vLL);
    var C_uF = sh.bl > 0 ? B / TWO_PI_F * 1e6 : -1;
    var L_mH = sh.bl < 0 ? 1 / (TWO_PI_F * B) * 1000 : -1;
    var id = newId();
    var y = bi.y + 120 + (idx % 3) * 90;
    if (sh.gl) {
      blocks.push({ id: id, type: 'rlcp', x: bi.x + 260, y: y, rot: 0,
        params: { R: 1 / G, L: L_mH, C: C_uF } });
    } else if (sh.bl > 0) {
      blocks.push({ id: id, type: 'cap', x: bi.x + 260, y: y, rot: 0,
        params: { C: C_uF } });
    } else {
      blocks.push({ id: id, type: 'rlc', x: bi.x + 260, y: y, rot: 0,
        params: { R: -1, L: L_mH, C: -1 } });
    }
    var gid = addGnd(bi.x + 360, y + 4);
    wires.push({ a: [id, 0], b: [bi.blockId, takeTap(sh.i)] });
    wires.push({ a: [id, 1], b: [gid, 0] });
  });

  // --- Branches -> line (R Ω, L mH, C µF on the from-bus base) ---
  // Line-end shunts (GI/BI at from, GJ/BJ at to): the line block models the pi
  // shunt as two equal C/2 halves, so the per-end admittances cannot be placed
  // individually. The net end-shunt susceptance (BI + BJ) is folded into the
  // total pi susceptance and split equally, an approximation that misplaces
  // (BI - BJ)/2 per end when the ends differ. Shunt conductance (GI + GJ) and a
  // net inductive susceptance have no line-block representation and are dropped;
  // both are warned. The from-bus base is used for the fold (BI shares it; BJ is
  // on the to-bus base, equal at both ends in the common case).
  var endShN = 0;
  c.branches.forEach(function (br) {
    var bi = busOf(br.i), bj = busOf(br.j);
    if (!bi || !bj) return;
    var kvLL = busRec(br.i).baseKV || 1;
    var zb = zbase(kvLL, c.sbase);
    var R = br.r * zb;
    var X = br.x * zb;
    var L_mH = X / TWO_PI_F * 1000;
    var bEnd = (br.bi || 0) + (br.bj || 0);            // net extra end-shunt susceptance (pu)
    var bTot = br.b + bEnd;
    var C_uF = bTot > 0 ? (bTot / zb) / TWO_PI_F * 1e6 : 0;
    if (br.gi || br.bi || br.gj || br.bj) endShN++;
    var id = newId();
    blocks.push({ id: id, type: 'line', x: (bi.x + bj.x) / 2, y: (bi.y + bj.y) / 2, rot: 0,
      params: { R: R, L: L_mH, C: C_uF, Rm: 0, Lm: 0,
        RATE1: br.rate1 || 0, RATE2: br.rate2 || 0, RATE3: br.rate3 || 0,
        LEN: br.len || 0, metre: br.metre || 0 } });
    wires.push({ a: [id, 0], b: [bi.blockId, takeTap(br.i)] });
    wires.push({ a: [id, 1], b: [bj.blockId, takeTap(br.j)] });
  });
  if (endShN > 0) {
    warnings.push(endShN + ' branch(es) carry line-end shunts (GI/BI/GJ/BJ); ' +
      'the net susceptance is folded into the line pi-C (split equally between ' +
      'ends, an approximation when the ends differ) and shunt conductance / net ' +
      'inductive susceptance are dropped (no per-end G or shunt-L on the line block).');
  }

  // --- Transformer winding voltage, per the CW (winding data I/O) code ---
  // CW=1: WINDV is per unit of the BUS base voltage.
  // CW=2: WINDV is already in kV.
  // CW=3: WINDV is per unit of NOMV (which itself defaults to the bus base).
  // Reading CW matters: treating a CW=2 record as CW=1 multiplies a kV value by
  // a kV base and yields a wildly wrong turns ratio, silently.
  function windingKV(windv, nomv, busKV, cw) {
    if (cw === 2) return windv || busKV;
    if (cw === 3) return (windv || 1) * (nomv > 0 ? nomv : busKV);
    return (windv || 1) * busKV;
  }
  // Nominal (untapped) voltage base used for the IMPEDANCE base, which is not
  // the tapped winding voltage.
  function nominalKV(nomv, busKV) { return nomv > 0 ? nomv : busKV; }
  // Leakage pu -> ohms on the winding-1 side, per the CZ (impedance) code.
  // CZ=1: pu on system MVA base and the winding bus voltage.
  // CZ=2: pu on the transformer MVA base (SBASEn-m) and NOMV.
  // CZ=3: R is the load loss in WATTS and X is |Z| pu on the transformer base;
  //       recover R,X in pu before converting (a real conversion, not a guess).
  function leakOhms(rIn, xIn, sbaseWind, nomKV, cz) {
    var r = rIn, x = xIn, mva = c.sbase;
    if (cz === 2) { mva = sbaseWind; }
    else if (cz === 3) {
      mva = sbaseWind;
      var rpu = rIn / (sbaseWind * 1e6);          // watts -> pu on winding base
      var zmag = xIn;                              // |Z| pu on winding base
      r = rpu;
      x = Math.sqrt(Math.max(0, zmag * zmag - rpu * rpu));
    }
    var zb = zbase(nomKV, mva);
    return { R: r * zb, L_mH: (x * zb) / TWO_PI_F * 1000 };
  }
  // Magnetizing susceptance MAG2 (pu on SBASE1-2, winding-1 LL base) -> per-phase
  // magnetizing Lm in mH, the same per-phase/LL-base convention as leakOhms and
  // the branch conversion. Lm = Zbase/(w*Bpu). MAG2 <= 0 (capacitive or absent)
  // yields 0: xfmr3 has no shunt-C param, so a capacitive magnetizing branch is
  // dropped (warned). MAG1 (core-loss conductance) has no xfmr3 param either and
  // is dropped; only the linear inductive shunt is carried (PSS/E carries no
  // saturation knee, so this is the linear part only, like makeXfmr3s's Lm).
  function magLm(bmag, mva, nomKV) {
    if (!(bmag > 0)) return 0;
    return (zbase(nomKV, mva) / (TWO_PI_F * bmag)) * 1000;
  }
  // Which vector group an imported two-winding transformer gets, and by how
  // much its leakage has to be rebased. Returns { conn, zmul }.
  //
  // ANG1 is the authority on the POSITIVE-SEQUENCE shift: it is the field
  // PSS/E's own load flow solves with, so the vendor case's solved angles
  // reflect it. VECGRP does NOT decide the shift and routinely disagrees:
  // every delta-wye GSU in PSS/E's own sample.raw carries VECGRP 'YNd1' or
  // 'Dyn1' with ANG1 = 0, because a positive-sequence load flow does not need
  // the 30 deg. Honoring the label there would rotate half of a real case away
  // from its own solved answer for no gain.
  //
  // What ANG1 cannot say is WHICH winding carries the delta, and that one is
  // not cosmetic: xfmr3's R/L are PER-WINDING, so a delta side's line-basis
  // impedance is 3x its winding value (the positive-sequence stamp scales a
  // delta side by |c|^2 = 3 exactly). leakOhms refers the leakage to winding 1
  // on a wye, line-to-neutral base, so a delta on winding 1 needs that 3x put
  // back; otherwise the unit's impedance is a third of what the file says.
  // VECGRP answers the question when the record carries it; when it does not,
  // assume the delta is on winding 2, which is both the common configuration
  // and the one that needs no rebasing.
  //
  // Sense: PSS/E models every winding as its own two-winding unit against a
  // common reference (the star point of a 3-winding transformer), and ANGk is
  // that winding's own shift, so angle(Vk) = angle(ref) + ANGk and the shift
  // ACROSS the unit onto winding k is ANGk - ANG1. For a two-winding record
  // that is -ANG1 (the winding-2 line carries no ANG field at all, so ANG2 is
  // 0); for a tertiary it is +ANG3 when ANG1 is 0. The two look like opposite
  // sign conventions if read off "whichever ANG is nonzero", which is why they
  // share one helper here. Verified end to end against the solved angles of the
  // IEEE harmonics case, where ANG1 = -30 puts BUS 8 30 deg AHEAD of BUS 7.
  //
  // Block side: clock 1 is a 30 deg LAG on the far winding, clock 11 a lead.
  function clockOf(shift) { return shift > 0 ? '11' : '1'; }
  var isD = function (shift) { return Math.abs(Math.abs(shift) - 30) < 5; };
  // Anything that is not near 0 or 30 deg is a true phase-shifter and is not
  // representable here; it falls back to Yy0 (counted and warned separately).
  function connOf(ang1, ang2, vec) {
    var shift = ang2 - ang1;
    if (!isD(shift)) return { conn: 'Yy0', zmul: 1 };
    var w = _vecWindings(vec);
    if (w.length >= 2 && w[0] === 'D' && w[1] !== 'D') return { conn: 'Dy' + clockOf(shift), zmul: 3 };
    return { conn: 'Yd' + clockOf(shift), zmul: 1 };
  }

  // --- 2-winding transformers -> xfmr3 (3-phase, LL nameplate + leakage ohms) ---
  var oddAng = 0, magN = 0, magCapN = 0, vecDeltaNoAng = 0;
  // A VECGRP delta on a record whose ANG is zero: the file's own convention for
  // a delta-wye unit in a positive-sequence case. Counted so the import can say
  // so once, rather than either rotating the case or staying silent about a
  // connection it dropped.
  function countSilentDelta(vec, angs) {
    var w = _vecWindings(vec);
    if (w.indexOf('D') < 0) return;
    for (var q = 0; q < angs.length; q++) if (Math.abs(angs[q]) >= 5) return;
    vecDeltaNoAng++;
  }
  c.xfmrs.forEach(function (t) {
    var bi = busOf(t.i), bj = busOf(t.j);
    if (!bi || !bj) return;
    var kv1 = busRec(t.i).baseKV || 1, kv2 = busRec(t.j).baseKV || 1;
    var v1 = windingKV(t.windv1, t.nomv1, kv1, t.cw);
    var v2 = windingKV(t.windv2, t.nomv2, kv2, t.cw);
    var lk = leakOhms(t.r, t.x, t.sbase12, nominalKV(t.nomv1, kv1), t.cz);
    var sh = t.ang2 - t.ang1;
    if (sh && !isD(sh)) oddAng++;
    countSilentDelta(t.vecgrp, [sh]);
    var cn = connOf(t.ang1, t.ang2, t.vecgrp);
    var Lm = magLm(t.mag2, t.sbase12, nominalKV(t.nomv1, kv1));
    if (t.mag2 > 0) magN++;
    else if (t.mag2 < 0) magCapN++;
    var id = newId();
    blocks.push({ id: id, type: 'xfmr3', x: (bi.x + bj.x) / 2, y: (bi.y + bj.y) / 2 + 60, rot: 0,
      params: { conn: cn.conn, V1: v1 * 1000, V2: v2 * 1000,
        R: lk.R * cn.zmul, L: lk.L_mH * cn.zmul, Lm: Lm } });
    wires.push({ a: [id, 0], b: [bi.blockId, takeTap(t.i)] });
    wires.push({ a: [id, 1], b: [bj.blockId, takeTap(t.j)] });
  });

  // --- 3-winding transformers -> xfmr3w (star/T equivalent) ---
  // RAW gives the three measured WINDING-PAIR impedances (Z12, Z23, Z31), each
  // on its own MVA base. Put them on a common base first, then the standard star
  // conversion Z1=(Z12+Z31-Z23)/2, Z2=(Z12+Z23-Z31)/2, Z3=(Z23+Z31-Z12)/2.
  // xfmr3w wants each arm primary-referred, which is exactly what converting to
  // ohms on the winding-1 voltage base gives.
  (c.xfmrs3w || []).forEach(function (t) {
    var bi = busOf(t.i), bj = busOf(t.j), bk = busOf(t.k);
    if (!bi || !bj || !bk) return;
    var kv1 = busRec(t.i).baseKV || 1, kv2 = busRec(t.j).baseKV || 1, kv3 = busRec(t.k).baseKV || 1;
    // Rebase each pair impedance onto the system MVA base (pu scales with MVA).
    function reb(r, x, sb) {
      if (t.cz === 3) { // load-loss form: convert on its own base first
        var rp = r / (sb * 1e6);
        return { r: rp * (c.sbase / sb), x: Math.sqrt(Math.max(0, x * x - rp * rp)) * (c.sbase / sb) };
      }
      var k = t.cz === 2 ? (c.sbase / sb) : 1; // CZ=1 is already on system base
      return { r: r * k, x: x * k };
    }
    var z12 = reb(t.r12, t.x12, t.sb12);
    var z23 = reb(t.r23, t.x23, t.sb23);
    var z31 = reb(t.r31, t.x31, t.sb31);
    var star = function (a, b, d) { return (a + d - b) / 2; }; // (Zab+Zca-Zbc)/2
    var r1 = star(z12.r, z23.r, z31.r), x1 = star(z12.x, z23.x, z31.x);
    var r2 = star(z12.r, z31.r, z23.r), x2 = star(z12.x, z31.x, z23.x);
    var r3 = star(z23.r, z12.r, z31.r), x3 = star(z23.x, z12.x, z31.x);
    var zb = zbase(nominalKV(t.nomv1, kv1), c.sbase); // primary-referred
    var toL = function (x) { return (x * zb) / TWO_PI_F * 1000; };
    var Lm = magLm(t.mag2, t.sb12, nominalKV(t.nomv1, kv1));
    if (t.mag2 > 0) magN++;
    else if (t.mag2 < 0) magCapN++;
    var v1 = windingKV(t.windv1, t.nomv1, kv1, t.cw);
    var v2 = windingKV(t.windv2, t.nomv2, kv2, t.cw);
    var v3 = windingKV(t.windv3, t.nomv3, kv3, t.cw);
    // xfmr3w's primary is always Y; a ~30 deg shift on a winding means it is the
    // delta. The block's groups put the delta on winding 3 (Yy0d1/Yy0d11) or on
    // both 2 and 3 (Yd1d1), so a delta on winding 2 alone has no exact match.
    // Clock sense comes from the SAME rule as the two-winding path: the shift
    // onto winding k is ANGk - ANG1 (see connOf). Every arm here is
    // primary-referred against a WYE winding 1, and the stamp's |c|^2 = 3 on a
    // delta side cancels that side's 1/sqrt3 turns ratio exactly, so unlike the
    // two-winding delta-primary case no arm needs rebasing.
    var sh2 = t.ang2 - t.ang1, sh3 = t.ang3 - t.ang1;
    countSilentDelta(t.vecgrp, [sh2, sh3]);
    var wv = _vecWindings(t.vecgrp);
    if (wv.length >= 3 && wv[0] === 'D') {
      warnings.push('Three-winding transformer ' + t.i + '-' + t.j + '-' + t.k +
        ' declares a DELTA primary (VECGRP ' + t.vecgrp + '); xfmr3w\'s winding 1 ' +
        'is always wye, so it is imported with a wye primary and its star arms ' +
        'are not rebased onto a delta winding.');
    }
    var d2 = isD(sh2), d3 = isD(sh3);
    var conn;
    if (d2 && d3) conn = 'Yd1d1';
    else if (d3) conn = 'Yy0d' + clockOf(sh3);
    else if (d2) {
      conn = 'Yd1d1';
      warnings.push('Three-winding transformer ' + t.i + '-' + t.j + '-' + t.k +
        ' has a delta on winding 2 only, which has no exact group here; ' +
        'imported as Yd1d1.');
    } else conn = 'Yy0y0';
    // A negative star arm is normal for a 3-winding equivalent (it is a
    // mathematical T, not a physical branch), but it is worth flagging: the
    // power flow is fine with it, an EMT time-domain solve may not be.
    if (x1 < 0 || x2 < 0 || x3 < 0) {
      warnings.push('Three-winding transformer ' + t.i + '-' + t.j + '-' + t.k +
        ' has a negative star-equivalent reactance on one winding (normal for a ' +
        'T equivalent). Check EMT stability before relying on transient results.');
    }
    var id = newId();
    blocks.push({ id: id, type: 'xfmr3w', x: (bi.x + bj.x) / 2, y: (bi.y + bj.y) / 2 + 120, rot: 0,
      params: { conn: conn, V1: v1 * 1000, V2: v2 * 1000, V3: v3 * 1000,
        R1: r1 * zb, L1: toL(x1), R2: r2 * zb, L2: toL(x2), R3: r3 * zb, L3: toL(x3),
        Lm: Lm } });
    wires.push({ a: [id, 0], b: [bi.blockId, takeTap(t.i)] });
    wires.push({ a: [id, 1], b: [bj.blockId, takeTap(t.j)] });
    wires.push({ a: [id, 2], b: [bk.blockId, takeTap(t.k)] });
  });
  if (oddAng > 0) {
    warnings.push(oddAng + ' transformer(s) have a phase shift that is not near ' +
      '0 or 30 degrees; imported as Yy0, so the angle across them is not modeled.');
  }
  if (vecDeltaNoAng > 0) {
    warnings.push(vecDeltaNoAng + ' transformer(s) name a delta winding in VECGRP ' +
      'but carry ANG = 0, which is how a positive-sequence case normally writes a ' +
      'delta-wye unit (the 30 degree shift does not affect a load flow, so PSS/E ' +
      'leaves it out). They are imported as Yy0, which reproduces the source ' +
      'case\'s solved angles; set the connection by hand before an unbalanced or ' +
      'EMT study, where the delta\'s shift and zero-sequence behavior do matter.');
  }
  if (magN > 0) {
    warnings.push(magN + ' transformer(s) carry a magnetizing branch (MAG2); ' +
      'imported as a linear Lm shunt on the primary winding (no saturation knee, ' +
      'core-loss conductance MAG1 dropped).');
  }
  if (magCapN > 0) {
    warnings.push(magCapN + ' transformer(s) have a capacitive magnetizing branch ' +
      '(MAG2 < 0); xfmr3 has no shunt-C param, so this is dropped.');
  }

  // --- One voltage probe per bus on its reserved spare tap ---
  busList.forEach(function (b) {
    var bi = busInfo[b.i];
    var id = newId();
    blocks.push({ id: id, type: 'probe', x: bi.x + 40, y: bi.y - 60, rot: 0, params: {} });
    wires.push({ a: [id, 0], b: [bi.blockId, takeTap(b.i)] });
  });

  var circuit = { webemt: 1, vconv: 'll', blocks: blocks, wires: wires };
  return { circuit: circuit, warnings: warnings };
}

// Dispatcher: sniff the format and route. Returns { circuit, warnings, meta }
// on success or { err } on failure. Only PSS/E RAW is handled today.
function importCase(text, filename) {
  var name = (filename || '').toLowerCase();
  var head = String(text).slice(0, 4000);
  var looksRaw = /\.raw$/.test(name) ||
    /END OF SYSTEM-WIDE DATA|BEGIN BUS DATA|PSS.*E-3[0-9]/i.test(head);
  if (!looksRaw) {
    return { err: 'Unrecognized file format. Only PSS/E RAW (.raw) import is supported.' };
  }
  var model = parsePsseRaw(text);
  if (model.err) return { err: model.err };
  var out = caseToCircuit(model);
  return {
    circuit: out.circuit,
    warnings: out.warnings,
    meta: { format: 'PSS/E RAW', rev: model.rev, sbase: model.sbase, f0: model.f0,
      buses: model.buses.length, gens: model.gens.length, loads: model.loads.length,
      branches: model.branches.length, xfmrs: model.xfmrs.length,
      xfmrs3w: (model.xfmrs3w || []).length, shunts: model.shunts.length }
  };
}

// Node/CommonJS export for api/core.js test harnesses that require() this file
// directly. In the browser bundle and the vm sandbox this is a no-op (module is
// undefined), and the functions are plain globals.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parsePsseRaw: parsePsseRaw, caseToCircuit: caseToCircuit, importCase: importCase };
}
