// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Hiva Nasiri. Commercial licensing: see LICENSING.md
// solver.js — EMTP-style trapezoidal nodal solver, hybrid AC/DC.
// Depends on: BLOCK DEFS (blocks.js), S state (ui.js main thread / worker
// bootstrap). See SPEC.md section 1 (hybrid indexing + worker architecture)
// and section 2 (companion models).

const GON = 1e4, GOFF = 1e-8;

// ---- linear algebra: dense LU with partial pivoting ----
// Elements hold GLOBAL unknown indices (node-major, per-node phase counts —
// SPEC section 1). Per-phase elements stamp scalars; spanning elements
// (coupled line, gfm, pfc) bring their own stamp() method.
function stampPhase(G, els) {
  els.forEach(e => {
    const g = e.kind === 'brk' ? (e.closed ? e.gon : e.goff) : e.G;
    if (!g) return; // pure current sources (batt, cpl) stamp nothing
    const a = e.a || 1; // transformer ratio; 1 for ordinary elements (SPEC §2)
    const i = e.n1, j = e.n2;
    if (i >= 0) G[i][i] += g;
    if (j >= 0) G[j][j] += a * a * g;
    if (i >= 0 && j >= 0) { G[i][j] -= a * g; G[j][i] -= a * g; }
  });
}
function buildLU(D, phEls, sEls) {
  const LU = Array.from({ length: D }, () => new Float64Array(D));
  phEls.forEach(els => stampPhase(LU, els));
  sEls.forEach(e => e.stamp && e.stamp(LU));
  const piv = new Int32Array(D);
  for (let c = 0; c < D; c++) {
    let mx = c;
    for (let r = c + 1; r < D; r++) if (Math.abs(LU[r][c]) > Math.abs(LU[mx][c])) mx = r;
    const tmp = LU[c]; LU[c] = LU[mx]; LU[mx] = tmp; piv[c] = mx;
    // Singular: this unknown has no independent equation, i.e. its node is
    // floating. Report WHICH column failed so the caller can name the blocks
    // sitting on that node — "a node is floating" alone is close to useless on
    // an 84-block imported case.
    if (Math.abs(LU[c][c]) < 1e-14) return { singularAt: c };
    for (let r = c + 1; r < D; r++) {
      LU[r][c] /= LU[c][c];
      for (let k = c + 1; k < D; k++) LU[r][k] -= LU[r][c] * LU[c][k];
    }
  }
  return { LU, piv };
}

function luSolve(f, I, nn) {
  const x = Float64Array.from(I);
  // apply ALL pivot swaps before eliminating: stored multipliers refer to
  // final row positions, so interleaving swaps with elimination is wrong
  // (bug found July 2026 — dormant while matrices were diagonally dominant)
  for (let c = 0; c < nn; c++) { const t = x[c]; x[c] = x[f.piv[c]]; x[f.piv[c]] = t; }
  for (let c = 0; c < nn; c++) {
    for (let r = c + 1; r < nn; r++) x[r] -= f.LU[r][c] * x[c];
  }
  for (let r = nn - 1; r >= 0; r--) {
    for (let k = r + 1; k < nn; k++) x[r] -= f.LU[r][k] * x[k];
    x[r] /= f.LU[r][r];
  }
  return x;
}

// ---- topology: union-find + AC/DC classification -> global indexing ----
function buildNodes(nph) {
  const uf = {};
  const find = x => { while (uf[x] !== undefined && uf[x] !== x) x = uf[x]; return x; };
  const uni = (a, b) => { a = find(a); b = find(b); if (a !== b) uf[a] = b; };
  S.blocks.forEach(b => getTerms(b).forEach((_, ti) => { uf[b.id + '_' + ti] = b.id + '_' + ti; }));
  S.wires.forEach(w => uni(w.a[0] + '_' + w.a[1], w.b[0] + '_' + w.b[1]));
  // a bus is many taps on ONE node: union them together regardless of wires
  // (SPEC section 1) — everything downstream (classification, node numbering,
  // element construction) then sees a bus exactly like a many-way wire junction.
  S.blocks.forEach(b => {
    if (b.type !== 'bus') return;
    const n = getTerms(b).length;
    for (let i = 1; i < n; i++) uni(b.id + '_0', b.id + '_' + i);
  });
  const gnds = S.blocks.filter(b => b.type === 'gnd');
  if (!gnds.length) return { err: 'Add a ground block and wire it — the solver needs a reference node.' };
  const gset = new Set(gnds.map(g => find(g.id + '_0')));
  // gfm's DC port (term 2) is optional (SPEC §2) — every terminal still gets
  // its own union-find node regardless, so a never-wired term 2 would
  // otherwise be a genuinely floating, un-grounded, un-stamped node (a
  // singular matrix) rather than the true no-op it needs to be for every
  // circuit saved before this port existed. Auto-ground it when nothing
  // wires it, exactly as if the user had wired it to a ground block.
  S.blocks.forEach(b => {
    if (b.type !== 'gfm') return;
    const wired = S.wires.some(w => (w.a[0] === b.id && w.a[1] === 2) || (w.b[0] === b.id && w.b[1] === 2));
    if (!wired) gset.add(find(b.id + '_2'));
  });
  const nodeIds = {}; let nn = 0;
  S.blocks.forEach(b => getTerms(b).forEach((_, ti) => {
    const r = find(b.id + '_' + ti);
    if (!gset.has(r) && nodeIds[r] === undefined) nodeIds[r] = nn++;
  }));
  if (nn === 0) return { err: 'Circuit is entirely grounded — nothing to solve.' };
  const nid = (b, ti) => { const r = find(b.id + '_' + ti); return gset.has(r) ? -1 : nodeIds[r]; };

  // classify nodes AC/DC: typed blocks seed, passives propagate (SPEC section 1)
  const type = new Array(nn).fill(null);
  let conflict = false;
  const setT = (n, ty) => { if (n < 0) return; if (type[n] && type[n] !== ty) conflict = true; type[n] = ty; };
  S.blocks.forEach(b => {
    if (b.type === 'src' || b.type === 'xfmr' || b.type === 'xfmr3' || b.type === 'xfmr3w')
      DEFS[b.type].terms.forEach((_, ti) => setT(nid(b, ti), 'ac'));
    if (b.type === 'batt' || b.type === 'cpl' || b.type === 'dcdc' || b.type === 'pv')
      DEFS[b.type].terms.forEach((_, ti) => setT(nid(b, ti), 'dc'));
    if (b.type === 'pfc') { setT(nid(b, 0), 'ac'); setT(nid(b, 1), 'dc'); }
    // gfm: terms 0/1 are its AC branch (series EMF-behind-filter); term 2 is
    // an optional DC+ port (SPEC §2) — only seed 'dc' if it's actually wired,
    // since an unwired term 2 must stay a true no-op (old circuits, no 3rd
    // terminal wire, are unaffected).
    if (b.type === 'gfm') {
      setT(nid(b, 0), 'ac'); setT(nid(b, 1), 'ac');
      if (nid(b, 2) >= 0) setT(nid(b, 2), 'dc');
    }
    // syncgen: AC-only 2-terminal branch, no DC port (unlike gfm) — a
    // rotating machine has no natural DC side.
    if (b.type === 'syncgen') { setT(nid(b, 0), 'ac'); setT(nid(b, 1), 'ac'); }
    // im: same reasoning — rotating machine, AC-only.
    if (b.type === 'im') { setT(nid(b, 0), 'ac'); setT(nid(b, 1), 'ac'); }
    // wt4/hvdc/gfl: AC-only converter terminals (their DC links are internal).
    if (b.type === 'wt4' || b.type === 'hvdc' || b.type === 'gfl') { setT(nid(b, 0), 'ac'); setT(nid(b, 1), 'ac'); }
    // scale: AC-only current-scaling coupler, both terminals AC (SPEC §2).
    if (b.type === 'scale') { setT(nid(b, 0), 'ac'); setT(nid(b, 1), 'ac'); }
  });
  // tline/fdline propagate too (July 2026 review): without them a node on the
  // far side of a traveling-wave line in a DC circuit silently defaulted to AC.
  const passive = { line: 1, rlc: 1, rlcp: 1, cap: 1, brk: 1, relay: 1, zrel: 1, tline: 1, fdline: 1 };
  let changed = true;
  while (changed && !conflict) {
    changed = false;
    S.blocks.forEach(b => {
      if (!passive[b.type]) return;
      const na = nid(b, 0), nb = nid(b, 1);
      const ta = na >= 0 ? type[na] : null, tb = nb >= 0 ? type[nb] : null;
      if (ta && tb && ta !== tb) conflict = true;
      else if (ta && !tb && nb >= 0) { type[nb] = ta; changed = true; }
      else if (tb && !ta && na >= 0) { type[na] = tb; changed = true; }
    });
  }
  if (conflict) return { err: 'A node connects the AC and DC sides directly — join them only through a PFC (terminal 0 = AC in, terminal 1 = DC+ out) or a GFM inverter\'s DC port (terminal 2).' };
  for (let n = 0; n < nn; n++) if (!type[n]) type[n] = 'ac';

  // ---- single-phase laterals (SPEC §2 "Phase tap"): per-node PHASE identity ----
  // Second classification pass, structurally identical to the AC/DC one above
  // but over a different lattice: phs[n] = -1 means "carries the full 3-phase
  // set" (every node before this feature existed), 0/1/2 means "this node is a
  // single-phase lateral living on phase A/B/C only". null = not yet known.
  // A `tap` block is the ONLY legal bridge between the two, and it seeds BOTH
  // of its sides — seeding term 0 as -1 is what stops a lateral's phase index
  // from propagating backwards and silently collapsing the whole feeder to one
  // phase. Blocks whose model genuinely spans the phase set seed -1 too, so
  // wiring one onto a lateral is caught here instead of misbehaving downstream.
  const phs = new Array(nn).fill(null);
  let phConflict = null;
  const setP = (n, v, b) => {
    if (n < 0) return;
    if (phs[n] !== null && phs[n] !== v) phConflict = phConflict || b;
    phs[n] = v;
  };
  // gfm is absent since July 2026: its droop/GFL controller was given a
  // single-phase P/Q measurement, so it can live on a lateral. The rest
  // genuinely span the phase set (delta windings, mutual coupling, or a
  // balanced-set phasor identity) — see SPEC §7.
  const SPANS_PHASES = { syncgen: 1, im: 1, wt4: 1, hvdc: 1, gfl: 1, xfmr3: 1, xfmr3w: 1, svc: 1, scale: 1 };
  S.blocks.forEach(b => {
    if (b.type === 'tap') {
      setP(nid(b, 0), -1, b);
      const k = Math.round(+b.params.ph) - 1;
      setP(nid(b, 1), k >= 0 && k <= 2 ? k : 0, b);
      return;
    }
    // mutual coupling is a 3×3 matrix across the phase set — not a lateral element
    if (SPANS_PHASES[b.type] || isCoupled(b)) {
      getTerms(b).forEach((_, ti) => { const n = nid(b, ti); if (n >= 0 && type[n] === 'ac') setP(n, -1, b); });
    }
  });
  // Propagate over the passive set PLUS the single-phase transformer, which
  // the AC/DC pass seeds explicitly rather than propagating through. A 1-ph
  // xfmr fed from a lateral is the pole-top distribution transformer — the
  // motivating case for this whole feature — so its secondary must inherit
  // the lateral's phase; without this it silently stayed 3-phase and only
  // one of its three secondary phases was ever energized. `tap` is
  // deliberately absent, which is exactly what makes it the one block
  // allowed to join a 3-phase node to a single-phase one.
  const phPassive = Object.assign({ xfmr: 1, mov: 1 }, passive);
  let phChanged = true;
  while (phChanged && !phConflict) {
    phChanged = false;
    S.blocks.forEach(b => {
      if (!phPassive[b.type]) return;
      const na = nid(b, 0), nb = nid(b, 1);
      const pa = na >= 0 ? phs[na] : null, pb = nb >= 0 ? phs[nb] : null;
      if (pa !== null && pb !== null && pa !== pb) phConflict = phConflict || b;
      else if (pa !== null && pb === null && nb >= 0) { phs[nb] = pa; phChanged = true; }
      else if (pb !== null && pa === null && na >= 0) { phs[na] = pb; phChanged = true; }
    });
  }
  if (phConflict) {
    return { err: (DEFS[phConflict.type] ? DEFS[phConflict.type].label : phConflict.type) + ' #' + phConflict.id +
      ' joins a 3-phase node to a single-phase lateral — only a Phase Tap block can bridge those. Insert a tap (or move the block fully onto one side).' };
  }
  for (let n = 0; n < nn; n++) if (phs[n] === null) phs[n] = -1; // unknown ⇒ full 3-phase set (backward compatible)

  // Blocks implemented as SPANNING elements loop the phase set themselves
  // (makeSpanning, blocks.js) instead of being instantiated once per phase,
  // so on a lateral they would stamp all three phases of a node that only
  // has one — silently wrong rather than an error. The genuinely 3-phase
  // models above are already caught by the -1 seed as a bridging conflict;
  // these are the ones that are per-phase in principle but whose current
  // implementation spans, so refuse them explicitly with an honest message.
  // (Widening the tap's supported downstream set means making these
  // lateral-aware, one at a time — see SPEC §7.)
  const onLateral = b => getTerms(b).some((_, ti) => {
    const n = nid(b, ti); return n >= 0 && type[n] === 'ac' && phs[n] >= 0;
  });
  // relay/pfc/vsw were made lateral-aware (they size themselves from
  // topo.phList below). tline/fdline stay refused BY CHOICE, not by
  // limitation: a traveling-wave/frequency-dependent line models a long
  // transmission circuit, which is not what a single-phase distribution
  // lateral is. dcdc is DC-only, so it can never reach an AC lateral anyway.
  const SPAN_IMPL = { tline: 1, fdline: 1, dcdc: 1 };
  const badLat = S.blocks.find(b => {
    if (!SPAN_IMPL[b.type] && !isPiLine(b) && !(b.type === 'xfmr' && +(b.params.Lm || 0) > 0)) return false;
    return onLateral(b);
  });
  if (badLat) {
    return { err: (DEFS[badLat.type] ? DEFS[badLat.type].label : badLat.type) + ' #' + badLat.id +
      ' is not supported on a single-phase lateral' +
      (isPiLine(badLat) ? ' with shunt C (set C to 0)' : (badLat.type === 'xfmr' ? ' with a magnetizing branch (set Lm to 0)' : '')) +
      ' — it is modeled across the whole phase set. Move it to the 3-phase side of the tap.' };
  }

  // per-node unknown counts, node-major offsets
  const cnt = new Array(nn), off = new Array(nn);
  let D = 0, nAC = 0, nDC = 0, n1ph = 0;
  for (let n = 0; n < nn; n++) {
    cnt[n] = (nph === 3 && type[n] === 'ac' && phs[n] < 0) ? 3 : 1;
    off[n] = D; D += cnt[n];
    if (type[n] === 'ac') { nAC++; if (nph === 3 && phs[n] >= 0) n1ph++; } else nDC++;
  }
  const gIdx = (b, ti, p) => {
    const n = nid(b, ti); if (n < 0) return -1;
    if (cnt[n] === 3) return off[n] + (p || 0);
    // one unknown: either a DC node (every phase collapses onto it — the
    // legacy clamp) or a single-phase AC lateral, which exists ONLY on its
    // own phase and must read as "not connected" (-1) on the other two.
    if (nph === 3 && type[n] === 'ac' && phs[n] >= 0) return (p || 0) === phs[n] ? off[n] : -1;
    return off[n];
  };
  // The phases a block actually occupies, as global phase indices:
  // [0,1,2] for an ordinary 3-phase block, [0] on a DC island or in 1-ph
  // mode, [k] for a single-phase lateral. SPANNING elements (relay, pfc,
  // vsw, ...) build their own per-phase arrays and must size and index them
  // from THIS rather than from `nph`, or on a lateral they allocate three
  // slots and stamp two dead ones.
  const phList = b => {
    if (nph !== 3 || isDC(b)) return [0];
    const k = blockPh(b);
    return k >= 0 ? [k] : [0, 1, 2];
  };
  // Which phase a block lives on: -1 = all (every pre-tap block), 0/1/2 = a
  // single-phase lateral. The phase conflict check above guarantees a block's
  // terminals can't disagree, except for `tap` itself — whose single-phase
  // side is the answer we want (it is instantiated on that phase alone).
  const blockPh = b => {
    if (nph !== 3) return -1;
    const t = getTerms(b);
    for (let ti = 0; ti < t.length; ti++) {
      const n = nid(b, ti);
      if (n >= 0 && type[n] === 'ac' && phs[n] >= 0) return phs[n];
    }
    return -1;
  };
  const isDC = b => {
    if (b.type === 'batt' || b.type === 'cpl' || b.type === 'dcdc' || b.type === 'pv') return true;
    if (b.type === 'src' || b.type === 'gfm' || b.type === 'syncgen' || b.type === 'im' || b.type === 'wt4' || b.type === 'hvdc' || b.type === 'gfl' || b.type === 'xfmr' || b.type === 'xfmr3' || b.type === 'xfmr3w' || b.type === 'pfc' || b.type === 'scale') return false;
    for (let ti = 0; ti < getTerms(b).length; ti++) {
      const n = nid(b, ti);
      if (n >= 0) return type[n] === 'dc';
    }
    return false;
  };
  return { D, nn, nAC, nDC, n1ph, gIdx, isDC, nid, cnt, off, type, phs, blockPh, phList };
}

// ---- pure simulation core (no DOM) — SPEC section 1 ----
// Worker-safe: runs identically on the main thread (synchronous, onChunk =
// null) or inside a Web Worker (onChunk streams progress via postMessage).
// onChunk, when provided, is called once up front with {meta} (plain,
// structured-clone-safe descriptors of probes/elements) and then repeatedly
// with {progress, t, vp, ie} — incremental slices only, never live element
// objects (those hold closures and cannot cross the worker boundary).
// ---- passive-history initialization from the power flow -------------------
// SPEC §2 "Passive-history initialization from the power flow" (§5 item 32).
// solvePowerFlow() leaves a per-terminal node-voltage phasor on every block
// (`b.pfV`, phase-A per-phase RMS volts). Here each element that carries
// trapezoidal history registers is handed a context and fills them with the
// steady-state values the operating point implies, so the run starts energized
// instead of inrushing from a de-energized network.
//
// Everything about the discretization is unchanged; only the initial register
// contents are. An element with no seed() hook, or one whose terminals the PF
// did not solve (DC nodes, dead buses, laterals), silently keeps its cold
// start — seeding is per element, so a partially seedable circuit still gets
// the benefit everywhere the PF reached.
//
// TWO THINGS THE HOOKS MUST GET RIGHT, both derived in SPEC §2:
//  1. The registers hold t = −Δt, NOT t = 0. Step k=0 solves at t=0 and reads
//     its history from the previous step. `c.t0` is that time; use it.
//  2. The branch CURRENT comes from the element's own admittance at ω applied
//     to the branch-voltage phasor, not from a PF branch flow — the seed has to
//     be consistent with the discretized element, which is not always the same
//     object as the element's Ybus stamp.
//
// ALL-OR-NOTHING, and this is not conservatism. A PARTIALLY seeded network is
// far worse than a cold one: two series branches sharing a node, one preloaded
// with its steady-state history current and the other holding zero, cannot both
// be satisfied at t=0, and the node voltage spikes to whatever reconciles them.
// Measured on a coupled-line case while this was being built: 6% first-cycle
// deviation with nothing seeded, 195% with the load seeded and the line not. So
// the elements that carry trapezoidal history are checked BEFORE anything is
// written, and one un-seedable element among them cancels the whole pass — the
// run then starts exactly as cold as it did before this feature existed.
//
// Shunt CURRENT-SOURCE interfaces (pq, zip, im, svc, wt4, hvdc, and the DC-side
// converters) are deliberately not in that set. They inject a commanded current
// rather than a history current, so starting at zero understates a load for its
// first cycle instead of fighting a series partner: the error is bounded by the
// source impedance rather than being a spike. Pre-filling their measurement
// windows is the remaining half of §5 item 32.

// Kinds carrying trapezoidal history: every one must seed, or none do.
const SEED_REQUIRED = new Set(['line', 'cap', 'rlc', 'rlcp', 'xfmr', 'cline', 'pline',
  'xfmr3', 'xfmr3w', 'xfmrsat', 'tline', 'fdline', 'syncgen', 'gfm']);
// Kinds that DRIVE the network, and so must reproduce the power flow they are
// initialized from even though they carry no history of their own (`src`).
const SEED_SOURCES = new Set(['src', 'syncgen', 'gfm']);

function seedHistories(phEls, sEls, dt, nph) {
  if (!S.blocks.some(b => b.pfV)) return 0; // no power flow solved: cold start, unchanged
  const freqSrc = S.blocks.find(b => b.type === 'src' || b.type === 'gfm' || b.type === 'syncgen' || b.type === 'gfl');
  const f0 = freqSrc ? (freqSrc.params.f || freqSrc.params.f0 || 60) : 60;
  const w = 2 * Math.PI * f0;
  const SHIFT = [0, -2 * Math.PI / 3, 2 * Math.PI / 3];
  const c = {
    w, dt, f0,
    t0: -dt, // the history registers are the state one step BEFORE the first solve
    add: cAdd, sub: cSub, mul: cMul, div: cDiv, scale: cScale, inv: cInv,
    // Series impedance of an R-L pair, and the admittance form the RL companion
    // elements all want. Lh in henries.
    yRL: (R, Lh) => cInv({ re: R, im: w * Lh }),
    // Terminal ti of block b, rotated onto phase `ph` (positive sequence, the
    // same SHIFT the sources use). null = not solvable here -> do not seed.
    // A terminal index past the block's own list reads as ground (0), matching
    // the solver's own `n2 = -1 -> nv() = 0` convention for one-terminal blocks.
    term(b, ti, ph) {
      const pv = b.pfV; if (!pv) return null;
      const z = ti < pv.length ? pv[ti] : { re: 0, im: 0 };
      if (!z) return null;
      const a = SHIFT[ph] || 0;
      return a ? cMul(z, { re: Math.cos(a), im: Math.sin(a) }) : z;
    },
    // Branch-voltage phasor for a two-terminal element: V(t0) − a·V(t1), the
    // same combination the time loop forms as `vb = nv(n1) − a·nv(n2)`.
    vbr(b, ph, a) {
      const v0 = this.term(b, 0, ph), v1 = this.term(b, 1, ph);
      if (!v0 || !v1) return null;
      return cSub(v0, a && a !== 1 ? cScale(v1, a) : v1);
    },
    // Instantaneous value at time t of a per-phase RMS phasor, on the sine
    // reference every source in this solver uses (SPEC §2):
    //   v(t) = √2·|Z|·sin(ωt + ∠Z) = √2·(Z.re·sin ωt + Z.im·cos ωt)
    inst(z, t) {
      return Math.SQRT2 * (z.re * Math.sin(w * t) + z.im * Math.cos(w * t));
    }
  };
  // ---- gate: decide before writing anything -------------------------------
  // An element is ready when the power flow reached EVERY terminal of its block
  // (a null entry means a DC node or a de-energized bus), and, if it drives the
  // network, when it also carries the back-computed EMF it has to drive.
  // A new seed() hook must be correct exactly when this predicate is true; if it
  // needs more than this, it belongs here, not as a `return false` inside the
  // hook — by then the pass is already writing.
  const ready = e => {
    const b = e.b;
    if (!b.pfV || !b.pfV.every(z => z)) return false;
    if (SEED_SOURCES.has(e.kind) && !b.pfInit) return false;
    return true;
  };
  const all = [];
  for (let p = 0; p < nph; p++) all.push(...phEls[p].map(e => ({ e, ph: p })));
  sEls.forEach(e => all.push({ e, ph: nph }));
  const must = all.filter(x => SEED_REQUIRED.has(x.e.kind) || SEED_SOURCES.has(x.e.kind));
  // `seedVeto` lets an element decline on a condition only it can test — today
  // just the saturable transformer, whose steady state can sit somewhere the
  // power flow's linear core model cannot represent. Vetoing cancels the whole
  // pass, per the all-or-nothing rule above.
  const passOk = !must.some(x => !ready(x.e) || (SEED_REQUIRED.has(x.e.kind) && !x.e.seed) ||
    (x.e.seedVeto && x.e.seedVeto(c, x.ph)));

  let n = 0;
  if (passOk) must.forEach(x => { if (x.e.seed && x.e.seed(c, x.ph)) n++; });
  // Measurement-window seeding (SPEC §2 "Passive-history initialization" /
  // §5 item 32): pq/zip/im/svc/wt4/hvdc are shunt CURRENT-SOURCE interfaces,
  // deliberately outside SEED_REQUIRED — each is locally correct on its own
  // terminals with no series partner to spike against, so it seeds
  // independently of whether the all-or-nothing pass above went through.
  all.forEach(x => {
    if (SEED_REQUIRED.has(x.e.kind) || SEED_SOURCES.has(x.e.kind)) return;
    if (x.e.seed && ready(x.e) && x.e.seed(c, x.ph)) n++;
  });
  return n;
}

function simulate(nph, Tms, onChunk, dtUs, plotUs) {
  const topo = buildNodes(nph);
  if (topo.err) return { err: topo.err };

  if (nph !== 3 && S.blocks.some(b => b.type === 'syncgen')) {
    return { err: 'Synchronous generator needs 3-ph mode (its AVR measures 3-phase p and q).' };
  }
  if (nph !== 3 && S.blocks.some(b => b.type === 'im')) {
    return { err: 'Induction motor needs 3-ph mode (its model extracts the stator current phasor from the 3-phase set).' };
  }
  if (nph !== 3 && S.blocks.some(b => b.type === 'xfmr3')) {
    return { err: 'Vector-group transformer needs 3-ph mode (its winding connections span the phase set).' };
  }
  if (nph !== 3 && S.blocks.some(b => b.type === 'svc')) {
    return { err: 'SVC/STATCOM needs 3-ph mode (it measures the 3-phase voltage set).' };
  }
  if (nph !== 3 && S.blocks.some(b => b.type === 'xfmr3w')) {
    return { err: 'Three-winding transformer needs 3-ph mode (its winding connections span the phase set).' };
  }
  if (nph !== 3 && S.blocks.some(b => b.type === 'wt4')) {
    return { err: 'Type 4 wind turbine needs 3-ph mode (it extracts the terminal voltage phasor from the 3-phase set).' };
  }
  if (nph !== 3 && S.blocks.some(b => b.type === 'hvdc')) {
    return { err: 'VSC-HVDC needs 3-ph mode (both converter terminals extract 3-phase voltage phasors).' };
  }
  if (nph !== 3 && S.blocks.some(b => b.type === 'scale')) {
    return { err: 'Aggregation scale coupler needs 3-ph mode (it couples both sides across the 3-phase set).' };
  }
  if (nph !== 3 && S.blocks.some(b => b.type === 'gfl')) {
    return { err: 'GFL inverter needs 3-ph mode (its SRF-PLL extracts the voltage phasor from the 3-phase set).' };
  }
  // A single-phase GFM cannot measure P/Q faster than one cycle (no balanced
  // instantaneous p/q identity exists for one phase — SPEC §2). That is fine
  // for droop, load sharing and moderate disturbances, but during a bolted
  // fault the inverter slips against the grid and the one-cycle-stale
  // measurement drives the angle away instead of holding it: measured
  // grid-tied, the limiter floored at MUMIN and held 91% ABOVE Iacmax while
  // its EMF drifted ~104° out of phase. Refuse the limiter there rather than
  // ship a current limit that silently fails in the one scenario it exists
  // for. Islanded it happens to work (40.1 A against a 40 A limit), but
  // "only when islanded" is not a precondition a user can reasonably track.
  const badLim = S.blocks.find(b => b.type === 'gfm' && +b.params.Iacmax > 0 &&
    (nph !== 3 || topo.blockPh(b) >= 0));
  if (badLim) {
    return { err: 'GFM inverter #' + badLim.id + ': the AC current limit (I ac max) is not supported on a single-phase inverter — single-phase P/Q need a full cycle to measure, so the limiter is unreliable during a fault. Set I ac max to 0 here, or use a 3-phase inverter.' };
  }
  const badPiLine = S.blocks.find(b => isCoupled(b) && isPiLine(b));
  if (badPiLine) {
    return { err: 'Line #' + badPiLine.id + ': mutual coupling (Rm/Lm) and shunt C together aren\'t supported — set one to 0.' };
  }
  const badRelay = S.blocks.find(b => (b.type === 'relay' || b.type === 'vsw' || b.type === 'gtrip' || b.type === 'zrel') &&
    !S.blocks.some(t => t.type === 'brk' && t.id === Math.round(+b.params.brkId)));
  if (badRelay) {
    const label = { relay: 'Relay #', gtrip: 'Generation trip #', vsw: 'Shunt controller #', zrel: 'Distance relay #' };
    return { err: (label[badRelay.type] || 'Relay #') + badRelay.id + ': "breaker block #" (' + badRelay.params.brkId + ') doesn\'t match any breaker — set it to the # shown on the breaker it should switch.' };
  }
  // Frequency elements (81O/81U) and distance relays require a 3-phase AC sensor:
  // the SRF-PLL / positive-sequence phasor needs three phases. On a lateral or in
  // 1-ph mode only the voltage elements (59/27) are available, matching gfm's
  // single-phase current-limiter refusal posture.
  const badFtrip = S.blocks.find(b => b.type === 'gtrip' && (+b.params.Fov > 0 || +b.params.Fuv > 0) &&
    (nph !== 3 || topo.blockPh(b) >= 0));
  if (badFtrip) {
    return { err: 'Generation trip #' + badFtrip.id + ': frequency elements (81O/81U) need a 3-phase AC sensor (the SRF-PLL extracts a positive-sequence phasor from three phases). On a single-phase node or lateral only the voltage elements (59/27) are available. Set Fov and Fuv to 0, or place this relay on a full 3-phase node.' };
  }
  const badZrel = S.blocks.find(b => b.type === 'zrel' && (nph !== 3 || topo.blockPh(b) >= 0));
  if (badZrel) {
    return { err: 'Distance relay #' + badZrel.id + ' needs a 3-phase AC node (it extracts the positive-sequence V and I phasors). Place it on a full 3-phase node, not a single-phase lateral or 1-ph run.' };
  }
  // The out-of-step blinders are an ordered pair: the scheme times the locus
  // travelling from the OUTER blinder to the INNER one, so RB2 > RB1 > 0 or
  // there is nothing to time and the element would silently never pick up.
  const badBlind = S.blocks.find(b => b.type === 'zrel' && Math.round(+b.params.oos) > 0 &&
    !(+b.params.RB1 > 0 && +b.params.RB2 > +b.params.RB1));
  if (badBlind) {
    return { err: 'Distance relay #' + badBlind.id + ': out-of-step tripping needs blinders with RB2 > RB1 > 0 (outer then inner, in ohms) — got RB1 = ' + badBlind.params.RB1 + ', RB2 = ' + badBlind.params.RB2 + '. Set both, or set "OOS trip" to 0.' };
  }

  const dtUsEff = dtUs > 0 ? dtUs : 50;
  const dt = dtUsEff * 1e-6, T = Tms / 1000, N = Math.round(T / dt);
  const badTline = S.blocks.find(b => (b.type === 'tline' || b.type === 'fdline') && b.params.tau < dtUsEff);
  if (badTline) {
    return { err: (badTline.type === 'tline' ? 'TW line #' : 'FD line #') + badTline.id + ': travel time (' + badTline.params.tau + ' µs) must be ≥ the solver time step (' + dtUsEff + ' µs) — lengthen the line or shrink dt.' };
  }
  // Transformer ratio must be finite and positive: a 0/absent winding voltage
  // with no legacy `a` fallback would put NaN in the matrix and silently NaN
  // the whole run (July 2026 review).
  const badXA = xfmrRatioBad();
  if (badXA) {
    return { err: 'Transformer #' + badXA.id + ': rated winding voltages must all be > 0 — check V1/V2' + (badXA.type === 'xfmr3w' ? '/V3' : '') + '.' };
  }
  const phEls = [];
  for (let p = 0; p < nph; p++) phEls.push(makeElements(topo, dt, p, nph));
  const sEls = makeSpanning(topo, dt, nph);
  if (!phEls[0].length && !sEls.length) return { err: 'Add at least one element.' };
  // cross-element wiring: spanning elements that act on OTHER blocks'
  // elements (today: relay -> its target breaker) get the per-phase lists
  sEls.forEach(e => e.link && e.link(phEls));

  // Passive-history initialization (SPEC §2 "Passive-history initialization
  // from the power flow", §5 item 32). No-op unless solvePowerFlow() ran.
  seedHistories(phEls, sEls, dt, nph);

  const D = topo.D;

  // Turn a failing LU column into a sentence that names the circuit. The
  // unknown index maps back to a node through topo.off/cnt (node-major
  // indexing, SPEC section 1), and every block terminal that lands on that
  // node is then found through topo.nid(). A delta transformer winding with no
  // grounded path on its own side is the common real cause and is called out
  // by name, because the generic advice ("wire every terminal") does not apply
  // to it: the terminals ARE wired, the winding set just has no reference.
  const describeSingular = c => {
    let n = -1;
    for (let i = 0; i < topo.nn; i++) if (c >= topo.off[i] && c < topo.off[i] + topo.cnt[i]) { n = i; break; }
    if (n < 0) return '';
    const on = [];
    S.blocks.forEach(b => getTerms(b).forEach((_, ti) => {
      if (topo.nid(b, ti) === n && !on.some(x => x.b === b)) on.push({ b, ti });
    }));
    if (!on.length) return '';
    const name = x => (DEFS[x.b.type] ? DEFS[x.b.type].label : x.b.type) + ' #' + x.b.id +
      (x.b.params && x.b.params.name ? ' (' + x.b.params.name + ')' : '');
    const delta = on.filter(x => /^(xfmr3|xfmr3w)$/.test(x.b.type) &&
      /d/i.test(String((x.b.params && x.b.params.conn) || '').slice(1)));
    let msg = ' The floating node carries: ' + on.slice(0, 6).map(name).join(', ') +
      (on.length > 6 ? ', and ' + (on.length - 6) + ' more' : '') + '.';

    // The most confusing case in practice: the node LOOKS grounded because a
    // load sits on it with its other terminal wired to a ground block, but that
    // load is a controlled Norton current source stamped with G = 0 (pq, zip's
    // constant-power part, cpl, im, svc, wt4, hvdc, gfl). A current source has
    // infinite impedance, so it contributes nothing to the conductance matrix
    // and cannot fix a node voltage no matter what it is wired to. n1/n2 on an
    // element are global unknown indices, the same space as the failing column,
    // so the elements touching it can be read off directly.
    const touching = [];
    phEls.forEach(els => els.forEach(e => { if (e.n1 === c || e.n2 === c) touching.push(e); }));
    sEls.forEach(e => { if (e.n1 === c || e.n2 === c) touching.push(e); });
    if (touching.length && touching.every(e => !e.G)) {
      msg += ' Note that every element on this node is a CURRENT-SOURCE interface' +
        ' (conductance stamp G = 0): a constant-power or injection block has infinite' +
        ' impedance, so wiring it to a ground block does not give the node a voltage' +
        ' reference and cannot make the matrix solvable. Add something that actually' +
        ' conducts to ground on this node (an rlc/rlcp shunt, a line with shunt C, or a' +
        ' grounded transformer winding).';
    }
    if (delta.length) msg += ' ' + delta.map(name).join(', ') +
      ' has a DELTA winding on that side: a delta has no neutral, so unless something' +
      ' else on that side reaches ground the winding set is genuinely unreferenced.' +
      ' Ground that side, or use a wye connection (an ungrounded/isolated secondary' +
      ' needs modified nodal analysis, which this solver does not do yet).';
    return msg;
  };

  let fact = buildLU(D, phEls, sEls);
  if (!fact || fact.singularAt !== undefined) {
    return { err: 'Singular matrix — a node is floating. Wire every terminal and give the circuit a return path to ground. (A DC bus also needs a capacitor.)' +
      (fact && fact.singularAt !== undefined ? describeSingular(fact.singularAt) : '') };
  }

  // Divergence threshold, scaled to the circuit so a 480 V facility and a
  // 400 kV network are both judged sensibly: the largest source/EMF/regulated
  // voltage sets the scale, with a floor for circuits that declare none.
  // 1e4x is deliberately loose — a real switching transient is a few per unit,
  // so nothing physical approaches it, and only a genuine numerical blow-up
  // does. Reduce rather than spread: a spread over every block would risk the
  // argument limit on a large imported case.
  const VSCALE = Math.max(1000, S.blocks.reduce((m, b) => {
    const p = b.params || {};
    return Math.max(m, +p.Vrms || 0, +p.E0 || 0, +p.Vref || 0, +p.V1 || 0, +p.V0 || 0);
  }, 0));
  const VDIV = 1e4 * VSCALE;
  const DIVCHK = 16; // O(D) per check; divergence grows over many steps, so every 16th is ample

  // Buses are monitored automatically alongside V-probes: a bus IS a named
  // node, so its voltage is always plottable without a separate probe block.
  const probes = S.blocks.filter(b => b.type === 'probe' || b.type === 'bus').map(b => ({ b, n: topo.nid(b, 0) }));
  // ph1: this probe sits on a single-phase lateral (SPEC §2 phase tap) and has
  // exactly ONE meaningful reading, on that phase — null for every ordinary
  // 3-phase or DC node. ui.js uses it to show one correctly-lettered trace
  // instead of three identical ones (the same treatment DC nodes already get).
  // hasF: this node carries a frequency reading (3-ph AC only, see nodePLL).
  const mkProbeMeta = (p, pi) => ({
    id: p.b.id, type: p.b.type, name: p.b.params.name || '',
    dc: p.n < 0 || topo.type[p.n] === 'dc',
    ph1: (p.n >= 0 && nph === 3 && topo.type[p.n] === 'ac' && topo.phs[p.n] >= 0) ? topo.phs[p.n] : null,
    hasF: !!nodePLL[pi],
    // fSat: this node's frequency hit the instrument's tracking stop at some
    // point in the run, so its trace is NOT a measurement everywhere. A
    // clamped PLL reports a rock-steady 0.5*f0 that reads exactly like a
    // settled system, which is the worst possible failure for an instrument.
    fSat: !!(nodePLL[pi] && nodePLL[pi].sat),
    // fDead: this node was de-energized for part of the run, so its frequency
    // is held at the last live value there, not measured.
    fDead: !!(nodePLL[pi] && nodePLL[pi].dead)
  });
  // Plot decimation: explicit plotUs (µs between kept samples, user-set) takes
  // priority; 0/undefined auto-decimates only to bound storage on very long
  // runs (cap ~50000 points/signal), so normal runs keep EVERY solver sample
  // and zoom-in reveals full resolution — a sub-dt spike is never skipped in
  // storage. The zoomed-out view is handled at render time by per-pixel min/max
  // downsampling (ui.js drawOnePlot), which preserves any spike present in the
  // stored samples, so record-time decimation no longer needs to be
  // conservative. Never finer than dt itself — can't plot a sample the
  // solver didn't compute.
  const dec = plotUs > 0 ? Math.max(1, Math.round(plotUs / dtUsEff)) : Math.max(1, Math.floor(N / 50000));
  const t_out = [];
  const vp = probes.map(() => Array.from({ length: nph }, () => []));

  // Per-phase current sources (SPEC §3). One curEl per branch block, exactly as
  // the old phase-A list; but now each is sampled in every phase it exists in:
  //   spanning cline/gfm  -> e.i[ph]   (they carry their own per-phase array)
  //   pfc / DC elements    -> single (phase 0 only)
  //   scalar AC elements   -> the same-block instance in phEls[ph].cur
  const byBlockPhase = {};
  for (let p = 0; p < nph; p++) phEls[p].forEach(e => {
    (byBlockPhase[e.b.id] || (byBlockPhase[e.b.id] = []))[p] = e;
  });
  // A block on a single-phase lateral (SPEC §2 phase tap) is instantiated on
  // ITS phase only, so it is absent from phEls[0] whenever that phase isn't A.
  // Taking phase A's list alone would silently drop every B/C lateral branch
  // from the recorded signals, so pick up any block phase A didn't cover.
  const seenB = new Set(phEls[0].map(e => e.b.id));
  const latEls = [];
  for (let p = 1; p < nph; p++) phEls[p].forEach(e => {
    if (!seenB.has(e.b.id)) { seenB.add(e.b.id); latEls.push(e); }
  });
  const curEls = phEls[0].concat(latEls, sEls);
  // The phases a block actually occupies, in order: [0,1,2] for an ordinary
  // 3-phase branch, [0] for DC, [1] for a phase-B lateral. Recorded traces are
  // indexed 0..np-1 against THIS list, not against the global phase number —
  // otherwise a lateral's single trace would read insts[0] and record zeros.
  const phListOf = id => {
    const insts = byBlockPhase[id] || [];
    const l = []; for (let p = 0; p < nph; p++) if (insts[p]) l.push(p);
    return l;
  };
  const curInfo = curEls.map(e => {
    // e.nEff: spanning elements that size themselves from topo.phList (gfm on
    // a single-phase lateral). The rest are always the full phase set.
    if (e.kind === 'cline' || e.kind === 'gfm' || e.kind === 'syncgen' || e.kind === 'im' || e.kind === 'wt4' || e.kind === 'hvdc' || e.kind === 'gfl' || e.kind === 'xfmr3' || e.kind === 'xfmr3w' || e.kind === 'svc' || e.kind === 'xfmrsat' || e.kind === 'scale') return { e, np: e.nEff || nph, get: p => e.i[p] };
    // per-phase-looped spanning elements that collapse to ONE copy on a DC
    // node (July 2026 review): sample their own effective phase count
    if (e.kind === 'relay' || e.kind === 'zrel' || e.kind === 'pline' || e.kind === 'tline' || e.kind === 'fdline') return { e, np: e.nEff, get: p => e.i[p] };
    if (e.kind === 'pfc' || e.kind === 'dcdc') return { e, np: 1, get: () => e.cur };
    const insts = byBlockPhase[e.b.id] || [], pl = phListOf(e.b.id);
    return { e, np: pl.length || 1, get: k => (insts[pl[k]] ? insts[pl[k]].cur : 0) };
  });
  const ic = curInfo.map(ci => Array.from({ length: ci.np }, () => []));
  // Branch VOLTAGE sampled in parallel with current, so ui.js can derive P
  // (=v·i) and Q (SPEC §3) per branch without any new circuit element — same
  // per-kind shape as curInfo. cline/pline already store their branch-voltage
  // vector as `.v` (trapezoidal history, numerically equal to this step's
  // value once update() returns); gfm/pfc/dcdc expose the generic `_vb` set
  // inside their own update() since they don't flow through the generic
  // phEls loop above.
  const vbInfo = curEls.map(e => {
    if (e.kind === 'cline' || e.kind === 'pline') return { get: p => e.v[p] };
    if (e.kind === 'gfm' || e.kind === 'syncgen' || e.kind === 'im' || e.kind === 'wt4' || e.kind === 'hvdc' || e.kind === 'gfl' || e.kind === 'relay' || e.kind === 'zrel' || e.kind === 'xfmr3' || e.kind === 'xfmr3w' || e.kind === 'tline' || e.kind === 'fdline' || e.kind === 'svc' || e.kind === 'xfmrsat' || e.kind === 'scale') return { get: p => e._vb[p] };
    if (e.kind === 'pfc' || e.kind === 'dcdc') return { get: () => e._vb };
    const insts = byBlockPhase[e.b.id] || [], pl = phListOf(e.b.id);
    return { get: k => (insts[pl[k]] ? insts[pl[k]]._vb : 0) };
  });
  const bv = curInfo.map(ci => Array.from({ length: ci.np }, () => []));
  // Terminal-0 NODE voltage (vs ground), sampled in parallel with bv — needed
  // for THROUGH power (SPEC §3): P absorbed = vb·i only tells you what the
  // element itself consumes/generates (a closed breaker reads ~0, a line only
  // its own I²R loss); power FLOWING THROUGH it is v_node·i at a terminal,
  // and terminal 1's flow = (vt − vb)·i needs no extra recording (vt − vb is
  // exactly a·v(n2), including the transformer's turns scaling, so this one
  // extra array covers both ends). null for pfc/dcdc — their _vb is already a
  // single node voltage and their two sides carry different currents, so the
  // series through-power identity doesn't apply (they're power converters,
  // not series branches).
  const tvInfo = curEls.map(e => {
    if (e.kind === 'pfc' || e.kind === 'dcdc' || e.kind === 'xfmr3' || e.kind === 'xfmr3w' || e.kind === 'tline' || e.kind === 'fdline' || e.kind === 'svc' || e.kind === 'xfmrsat' || e.kind === 'hvdc' || e.kind === 'scale') return null; // not a simple series branch: no through-power identity
    if (e.kind === 'cline' || e.kind === 'pline' || e.kind === 'gfm' || e.kind === 'syncgen' || e.kind === 'im' || e.kind === 'wt4' || e.kind === 'gfl' || e.kind === 'relay' || e.kind === 'zrel') return { get: p => e._vt[p] };
    const insts = byBlockPhase[e.b.id] || [], pl = phListOf(e.b.id);
    return { get: k => (insts[pl[k]] ? insts[pl[k]]._vt : 0) };
  });
  const tv = curInfo.map((ci, i) => (tvInfo[i] ? Array.from({ length: ci.np }, () => []) : null));
  // aux channel: per-element scalar state series beyond v/i — battery SOC
  // (%) and, since July 2026, a gfm's DC-port current (A, if its 3rd terminal
  // is wired). Parallel to curEls; null where an element has none. Mirrors
  // the bv/vbInfo pattern so it rides the same decimation + chunks.
  // unit strings embed the quantity name (e.g. 'SOC %' not just '%') since the
  // plot legend/picker show only group + unit, no separate quantity label.
  const AUX = {
    batt: { quantity: 'SOC', unit: 'SOC %', get: e => e.soc },
    gfm: { quantity: 'Idc', unit: 'Idc A', get: e => e.idc },
    pv: { quantity: 'Vop', unit: 'Vop V', get: e => e.vop },
    syncgen: { quantity: 'f', unit: 'f Hz', get: e => e.f },
    im: { quantity: 's', unit: 'slip', get: e => e.s },
    relay: { quantity: 'trip', unit: 'trip frac', get: e => e.frac },
    zrel: { quantity: 'Z', unit: 'Z ohm', get: e => e.Zmag },
    vsw: { quantity: 'state', unit: 'bank on/off', get: e => e.state },
    svc: { quantity: 'Iq', unit: 'Iq A', get: e => e.Iq },
    wt4: { quantity: 'Pw', unit: 'Pw kW', get: e => e.Pcmd / 1000 },
    gfl: { quantity: 'f', unit: 'f Hz', get: e => e.fpll },
    hvdc: { quantity: 'Vdc', unit: 'Vdc V', get: e => e.Vdc },
    gtrip: { quantity: 'f', unit: 'f Hz', get: e => e.f },
    scale: { quantity: 'Inet', unit: 'Inet A', get: e => e.iNet[0] }
  };
  const auxInfo = curEls.map(e => (AUX[e.kind] ? { get: () => AUX[e.kind].get(e) } : null));
  const aux = auxInfo.map(ai => (ai ? [] : null));
  // dc flag: which of these branches live on a DC node (single-valued, not
  // A/B/C) — used by ui.js to label the signal "DC" instead of duplicating
  // an identical reading across three phases, and to skip Q/RMS where they
  // don't apply (SPEC §3).
  const curMeta = curEls.map((e, i) => ({
    id: e.b.id, type: e.b.type, kind: e.kind, np: curInfo[i].np,
    // phase index of this branch's FIRST recorded trace: 0 for everything on
    // an ordinary 3-phase node (and for DC), 0/1/2 for a single-phase lateral
    // branch, which records one trace that is not necessarily phase A.
    ph0: Math.max(0, topo.blockPh(e.b)),
    aux: AUX[e.kind] ? AUX[e.kind].quantity : null, auxUnit: AUX[e.kind] ? AUX[e.kind].unit : null,
    thru: !!tvInfo[i], // series branch with recorded terminal voltage -> offers through-power signals
    // tline/fdline resolve via topo.isDC like pline (July 2026 review: they
    // can legitimately sit on a DC network and must then be labeled DC)
    dc: e.kind === 'cline' || e.kind === 'gfm' || e.kind === 'syncgen' || e.kind === 'im' || e.kind === 'wt4' || e.kind === 'hvdc' || e.kind === 'gfl' || e.kind === 'xfmr3' || e.kind === 'xfmr3w' || e.kind === 'svc' || e.kind === 'xfmrsat' || e.kind === 'scale' ? false : e.kind === 'pfc' ? true : topo.isDC(e.b),
    // Which element (59/27/81O/81U) asserted a gtrip's trip, filled in after
    // the run below since it is a final-state fact, not a time series (a
    // relay's own cause discriminator, same idea as zrel's oosTripped). null
    // for every other kind, and for a gtrip that never trips.
    cause: null
  }));
  const phShift = [0, -2 * Math.PI / 3, 2 * Math.PI / 3];
  let refacts = 0;
  // Nominal frequency for the RMS/P/Q averaging window (one fundamental
  // cycle) and the quarter-cycle lookahead shift used for Q — see ui.js.
  const freqSrc = S.blocks.find(b => b.type === 'src' || b.type === 'gfm' || b.type === 'syncgen' || b.type === 'gfl');
  const freqHz = freqSrc ? (freqSrc.params.f || freqSrc.params.f0 || 60) : 60;

  // ---- frequency at every monitored node (probe or bus) -------------------
  // Machines already report f (syncgen's rotor, gfl/gtrip's PLL), but NETWORK
  // frequency had no reading of its own: the only way to get it at a bus was
  // to hang a threshold-free gtrip there purely as a sensor, which is how
  // studies/Spain_Blackout measured it. A probe is the natural place for it.
  //
  // Same SRF-PLL as gfl/gtrip, run as a pure sensor with no thresholds: a
  // one-cycle boxcar on the positive-sequence correlator, then a PI loop on
  // the quadrature angle. 3-ph AC nodes only, exactly as gtrip's 81 elements
  // are: a positive-sequence phasor needs three phases, and inferring
  // frequency from a single phase would be a different method (zero-crossing
  // period) with different noise behaviour, not the same number.
  const KP_PLL = 30, KI_PLL = 900;
  // Instrument tracking range, +/- this fraction of nominal (25 to 75 Hz on a
  // 50 Hz system). See the note in update() for why it is wider than gtrip's.
  const DW_FRAC = 0.5;
  const nodePLL = probes.map(pr => {
    const n = pr.n;
    if (n < 0 || nph !== 3 || topo.type[n] !== 'ac' || topo.cnt[n] < 3 || topo.phs[n] >= 0) return null;
    const w0 = 2 * Math.PI * freqHz;
    const NW = Math.max(1, Math.round(1 / (freqHz * dt)));
    return {
      bufR: new Float64Array(NW), bufI: new Float64Array(NW), sumR: 0, sumI: 0,
      bidx: 0, bcnt: 0, th: 0, f: freqHz, integ: 0, aligned: false, sat: false, dead: false, vmax: 0,
      update(V) {
        // Start the loop already aligned with the node. Left at th = 0 the PI
        // loop has to pull in from an arbitrary angle error, which shows up as
        // a real 45 to 62 Hz excursion in the first cycles — honest, but it
        // dominates the plot's autoscale and buries the signal anyone actually
        // wants to see. With frame angle 0 the correlator reads
        // (3/2)Vm·(cos th, sin th), so the node's own angle is one atan2 away.
        if (!this.aligned) {
          this.aligned = true;
          let a = 0, b = 0;
          for (let p = 0; p < 3; p++) {
            const v = V[topo.off[n] + p];
            a += v * Math.sin(phShift[p]); b += v * Math.cos(phShift[p]);
          }
          if (a !== 0 || b !== 0) this.th = Math.atan2(b, a);
        }
        let re = 0, im = 0;
        for (let p = 0; p < 3; p++) {
          const v = V[topo.off[n] + p];
          re += v * Math.sin(this.th + phShift[p]);
          im += v * Math.cos(this.th + phShift[p]);
        }
        re *= Math.SQRT2 / 3; im *= Math.SQRT2 / 3;
        this.sumR += re - this.bufR[this.bidx]; this.bufR[this.bidx] = re;
        this.sumI += im - this.bufI[this.bidx]; this.bufI[this.bidx] = im;
        this.bidx = (this.bidx + 1) % NW;
        // The frame must keep TURNING while the window fills, or the
        // correlator averages a sinusoid against a stationary frame to zero
        // and the first reading after the fill is 0/0 (the zrel lesson,
        // DECISIONS.md 2026-07-27).
        if (this.bcnt < NW) { this.bcnt++; this.th += w0 * dt; return; }
        // A de-energized node has no frequency. Left to run, the loop tracks
        // numerical noise and reports a confident 50 to 67 Hz on a bus at
        // 0.0005 pu, which looks exactly like a live system — the same failure
        // as reporting the clamp. Scale is taken from the largest
        // positive-sequence magnitude this node has ever shown, so no nominal
        // has to be configured: below 2% of that, hold the last frequency and
        // latch `dead` so the trace is never read as a measurement.
        const v1 = Math.hypot(this.sumR / NW, this.sumI / NW);
        if (v1 > this.vmax) this.vmax = v1;
        if (this.vmax > 0 && v1 < 0.02 * this.vmax) { this.dead = true; return; }
        const d = Math.atan2(this.sumI / NW, this.sumR / NW);
        if (Math.abs(d) < Math.PI / 2) this.integ += d * dt;
        // Tracking range. gtrip clamps its PLL to +/-30% because it is a
        // CONTROL loop driving a trip decision and must not chase garbage. This
        // is an INSTRUMENT, and +/-30% is too narrow for one: a collapsing
        // island runs off the bottom of it, and the clamp then reports a
        // rock-steady 0.7*f0 (35.00 Hz at 50 Hz nominal) that reads exactly
        // like a real measurement. Widened to +/-50%, and `sat` marks any
        // sample that is still against the stop, so a pegged instrument is
        // never mistaken for a settled system.
        const CL = DW_FRAC * w0 / KI_PLL;
        if (this.integ > CL) this.integ = CL;
        if (this.integ < -CL) this.integ = -CL;
        let dw = KP_PLL * d + KI_PLL * this.integ;
        const DWMAX = DW_FRAC * w0;
        if (dw > DWMAX || dw < -DWMAX) this.sat = true;
        if (dw > DWMAX) dw = DWMAX;
        if (dw < -DWMAX) dw = -DWMAX;
        this.th += (w0 + dw) * dt;
        this.f = (w0 + dw) / (2 * Math.PI);
      }
    };
  });
  const fp = probes.map((_, pi) => (nodePLL[pi] ? [] : null));

  if (onChunk) {
    // Tms rides along so ui.js knows the run's TRUE eventual duration from the
    // first chunk, before any samples stream in — needed so the shared plot
    // zoom (SPEC §3) doesn't get clamped against however little has arrived
    // so far mid-stream.
    onChunk({ meta: { probes: probes.map(mkProbeMeta), curMeta, nph, Tms, freqHz } });
  }
  const CHUNK_DEC = 50; // ~decimated samples per progress update
  let lastFlush = 0;
  const flush = k => {
    if (!onChunk) return;
    const from = lastFlush;
    onChunk({
      progress: (k + 1) / N,
      t: t_out.slice(from),
      vp: vp.map(pr => pr.map(ph => ph.slice(from))),
      ic: ic.map(sig => sig.map(ph => ph.slice(from))),
      bv: bv.map(sig => sig.map(ph => ph.slice(from))),
      tv: tv.map(sig => (sig ? sig.map(ph => ph.slice(from)) : null)),
      aux: aux.map(a => (a ? a.slice(from) : null)),
      fp: fp.map(a => (a ? a.slice(from) : null))
    });
    lastFlush = t_out.length;
  };

  for (let k = 0; k < N; k++) {
    const t = k * dt;

    // switch events, per phase copy: close at tc; open/clear at the first
    // branch-current zero crossing after arming at to.
    let switched = false;
    sEls.forEach(e => { if (e.segCheck && e.segCheck(t)) switched = true; }); // spanning piecewise elements (saturable xfmr core)
    for (let p = 0; p < nph; p++) {
      phEls[p].forEach(e => {
        // generic segment-switching hook (piecewise-linear elements: mov
        // arrester, saturable xfmr core): element decides from ITS OWN
        // last-step state whether its conductance segment changed; any
        // change refactorizes the LU exactly like a breaker event.
        if (e.segCheck && e.segCheck(t)) switched = true;
        if (e.kind !== 'brk') return;
        const ms = t * 1000;
        if (!e.closed && !e.opened && e.tc >= 0 && ms >= e.tc) {
          e.closed = true; switched = true;
        }
        if (e.closed && e.to >= 0 && ms >= e.to) e.armed = true;
        if (e.closed && e.armed && e.pcur * e.cur <= 0 && (e.pcur !== 0 || e.cur !== 0)) {
          e.closed = false; e.opened = true; switched = true;
          // multi-op brk (SPEC section 2): advance to the next scheduled
          // close/open pair instead of latching, same reset vsw.update()
          // already does for a controller-driven reclose.
          if (e.sched && e.opIdx + 1 < e.sched.length) {
            e.opIdx++;
            const next = e.sched[e.opIdx];
            e.tc = next.tc; e.to = next.to;
            e.armed = false; e.opened = false;
          }
        }
      });
    }
    if (switched) {
      fact = buildLU(D, phEls, sEls);
      if (!fact || fact.singularAt !== undefined) {
        return { err: 'Singular after switching at t = ' + (t * 1000).toFixed(2) + ' ms — an island lost its ground reference.' +
          (fact && fact.singularAt !== undefined ? describeSingular(fact.singularAt) : '') };
      }
      refacts++;
    }

    const doStep = (tEval, be) => {
      const I = new Float64Array(D);
      for (let p = 0; p < nph; p++) phEls[p].forEach(e => e.inject && e.inject(I, tEval, phShift[p], be));
      sEls.forEach(e => e.inject(I, be, tEval));
      const V = luSolve(fact, I, D);
      const nv = n => (n < 0 ? 0 : V[n]);
      // _vb = this step's branch voltage, stashed generically here (not by each
      // element's own update()) so P/Q (SPEC §3) can read it uniformly without
      // touching every block type. Distinct from line/cap/xfmr's own internal
      // `.v` (their trapezoidal history state) — same value, different purpose.
      for (let p = 0; p < nph; p++) phEls[p].forEach(e => { const vb = nv(e.n1) - (e.a || 1) * nv(e.n2); e.update(vb, tEval, phShift[p], be); e._vb = vb; e._vt = nv(e.n1); });
      sEls.forEach(e => e.update(V, be, tEval));
      return V;
    };

    // CDA: after a switch event, replace this step by two backward-Euler
    // half-steps (same LU — see SPEC section 2) to kill trapezoidal ringing.
    let V;
    if (switched) {
      doStep(t + dt / 2, true);
      V = doStep(t + dt, true);
    } else {
      V = doStep(t, false);
    }

    // First-step sanity: a NaN/Infinity solution means an invalid stamp (a
    // 0-Ω branch between two live nodes, a bad parameter) — buildLU can't
    // detect it (Math.abs(NaN) < eps is false), so without this the whole run
    // silently outputs NaN (July 2026 review). One O(D) check, first step only.
    if (k === 0 && !V.every(Number.isFinite)) {
      return { err: 'First solve step produced NaN/Infinity — a block parameter makes the matrix invalid (e.g. a 0 Ω / 0 mH series branch, or a conflicting parameter edit). Check recently changed parameters.' };
    }

    // Divergence guard. A numerically unstable run does not fail, it grows:
    // iec60909_hv_network reaches 1e28 V by 634 ms and still returns a "Solved"
    // status with plottable garbage, which is worse than an error because it
    // looks like an answer. VDIV is many orders above any physical transient
    // (see VSCALE above), so crossing it is never a real overvoltage. Checked
    // every step, O(D), and only after k=0 so the NaN check above keeps its
    // more specific message.
    if (k > 0 && k % DIVCHK === 0) {
      let bad = -1;
      for (let i = 0; i < D; i++) if (!Number.isFinite(V[i]) || Math.abs(V[i]) > VDIV) { bad = i; break; }
      if (bad >= 0) {
        // t is in SECONDS here (t = k*dt); every user-facing time in this file
        // is milliseconds, which is what t_out stores via t*1000.
        return { err: 'Solution diverged at t = ' + (t * 1000).toFixed(2) + ' ms (node voltage passed ' +
          VDIV.toExponential(0) + ' V, far beyond any physical transient). The run is numerically ' +
          'unstable, not merely large. Usual causes: machine inertia or governor constants that do ' +
          'not match the network (a case imported from a power-flow file carries PLACEHOLDER dynamic ' +
          'data and is not a valid transient model), a constant-power load behind too weak a source, ' +
          'or a time step too large for the fastest element. Try solving the power flow first ' +
          '("Init from PF"), shortening the run to before ' + (t * 1000).toFixed(0) + ' ms, or reducing dt.' };
      }
    }

    // The PLL is a dynamic filter, so it advances on EVERY solver step, not
    // only on the decimated ones that get stored.
    for (let pi = 0; pi < nodePLL.length; pi++) if (nodePLL[pi]) nodePLL[pi].update(V);

    if (k % dec === 0) {
      t_out.push(t * 1000);
      probes.forEach((pr, pi) => {
        for (let p = 0; p < nph; p++) {
          const v = pr.n < 0 ? 0 : V[topo.off[pr.n] + Math.min(p, topo.cnt[pr.n] - 1)];
          vp[pi][p].push(v); // DC probes repeat the same value across phases
        }
        if (fp[pi]) fp[pi].push(nodePLL[pi].f);
      });
      curInfo.forEach((ci, i) => { for (let p = 0; p < ci.np; p++) ic[i][p].push(ci.get(p)); });
      vbInfo.forEach((vi, i) => { for (let p = 0; p < curInfo[i].np; p++) bv[i][p].push(vi.get(p)); });
      tvInfo.forEach((ti, i) => { if (ti) for (let p = 0; p < curInfo[i].np; p++) tv[i][p].push(ti.get(p)); });
      auxInfo.forEach((ai, i) => { if (ai) aux[i].push(ai.get()); });
      if (onChunk && t_out.length - lastFlush >= CHUNK_DEC) flush(k);
    }
  }
  if (onChunk && t_out.length > lastFlush) flush(N - 1);

  // gtrip cause leaves the run here: curMeta was built before the loop, so
  // this reads back the final e.cause the loop above left on each element.
  curEls.forEach((e, i) => { if (e.kind === 'gtrip') curMeta[i].cause = e.cause; });

  const stat = 'Solved: ' + topo.nn + ' nodes (' + topo.nAC + ' AC' +
    (topo.n1ph ? ', ' + topo.n1ph + ' of them 1-ph lateral' : '') + ', ' + topo.nDC + ' DC), ' +
    nph + ' phase(s), ' + D + ' unknowns, ' + curEls.length + ' branches, ' +
    N.toLocaleString() + ' steps, ' + refacts + ' LU refactorization(s).';
  const probeMeta = probes.map(mkProbeMeta);
  return { stat, t: t_out, probes, vp, fp, curEls, ic, bv, nph, probeMeta, curMeta, Tms, freqHz, aux, tv };
}

// ---- synchronous entry point (DOM-facing) ----
// Used directly by the headless test harness and as the browser fallback
// when Web Workers are unavailable. The browser's Run button instead calls
// runEMTLive() (ui.js), which streams the same simulate() via a Worker.
function runEMT() {
  const stat = document.getElementById('stat');
  const nph = +document.getElementById('phmode').value;
  const durEl = document.getElementById('duration');
  const Tms = (durEl && +durEl.value > 0) ? +durEl.value : 120;
  const dtEl = document.getElementById('dtus');
  const dtUs = (dtEl && +dtEl.value > 0) ? +dtEl.value : 50;
  const plotEl = document.getElementById('plotus');
  const plotUs = (plotEl && +plotEl.value > 0) ? +plotEl.value : 0;
  const r = simulate(nph, Tms, null, dtUs, plotUs);
  if (r.err) { stat.textContent = r.err; return; }
  stat.textContent = r.stat;
  drawPlots(r.t, r.probes, r.vp, r.curEls, r.ic, r.nph, r.probeMeta, r.curMeta, r.Tms, r.bv, r.freqHz, r.aux, r.tv, r.fp);
}

// ==== Power flow (positive-sequence steady-state solve + machine init) ====
// A SEPARATE solver from simulate(): where simulate() integrates the network
// in time from cold initial conditions, this solves the algebraic steady state
// so a run can START at the operating point instead of swinging into it from
// rotor angle 0 (the cold-start slip documented in DECISIONS.md). One complex
// voltage phasor per AC node (volts, line-to-neutral). Constant-impedance
// elements fold into a complex Ybus at f0; generators mark their terminal bus
// PV/slack; pq blocks are P+Q injections. Solved by polar-form Newton-Raphson
// warm-started with a few Gauss-Seidel sweeps, with Gauss-Seidel alone as the
// fallback (July 2026 second pass; the MVP was Gauss-Seidel only). After solving,
// each machine's internal EMF magnitude/angle is back-computed
// (E' = Vt + (Ra + jXd')·I) and stored on the block as `pfInit`; makeSyncGens/
// makeConverters (blocks.js) start from it when present. See SPEC.md §2.
function cAdd(a, b) { return { re: a.re + b.re, im: a.im + b.im }; }
function cSub(a, b) { return { re: a.re - b.re, im: a.im - b.im }; }
function cMul(a, b) { return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re }; }
function cConj(a) { return { re: a.re, im: -a.im }; }
function cAbs(a) { return Math.hypot(a.re, a.im); }
function cAng(a) { return Math.atan2(a.im, a.re); }
function cScale(a, s) { return { re: a.re * s, im: a.im * s }; }
function cInv(a) { const d = a.re * a.re + a.im * a.im; return { re: a.re / d, im: -a.im / d }; }
function cDiv(a, b) { return cMul(a, cInv(b)); }
function yRL(R, Lh, w) { return cInv({ re: R, im: w * Lh }); }

// ---- sparse complex matrices (CSR) for the power flow ----
// Power networks are extremely sparse: each bus connects to a handful of
// neighbours, so a dense m x m Ybus is O(m^2) memory and the dense Jacobian solve
// is O(m^3), which capped the tool at a few hundred buses (a 1648-bus case ran
// 25+ minutes). CSR stores only the nonzeros. The classical methods here (COO
// -> CSR assembly, sparse LU) are decades-old public domain; see DECISIONS.md.
// The time-domain `buildLU` stays dense for now (stage 2), so this path is
// power-flow-only.
//
// CSR layout: rowptr[i+1]-rowptr[i] nonzeros in row i, colidx strictly
// increasing within a row, parallel re/im arrays. `diag[i]` is the index into
// colidx of the diagonal entry (every live PF bus has one); -1 if absent.
function SparseBuilder(nrows, ncols) {
  const rows = [], cols = [], res = [], ims = []; // parallel COO triplets
  return {
    add(i, j, re, im) { rows.push(i); cols.push(j); res.push(re); ims.push(im); },
    build() {
      const n = rows.length;
      const idx = Array.from({ length: n }, (_, p) => p)
        .sort((a, b) => rows[a] !== rows[b] ? rows[a] - rows[b] : cols[a] - cols[b]);
      const colidx = new Int32Array(n), re = new Float64Array(n), im = new Float64Array(n);
      const counts = new Int32Array(nrows);
      let q = 0, prevR = -1, prevC = -1;
      for (let p = 0; p < n; p++) {
        const o = idx[p], r = rows[o], c = cols[o];
        if (q > 0 && r === prevR && c === prevC) { // sum duplicates (parallel branches)
          re[q - 1] += res[o]; im[q - 1] += ims[o];
        } else {
          colidx[q] = c; re[q] = res[o]; im[q] = ims[o]; counts[r]++; q++;
          prevR = r; prevC = c;
        }
      }
      const nnz = q;
      const rowptr = new Int32Array(nrows + 1);
      for (let r = 0; r < nrows; r++) rowptr[r + 1] = rowptr[r] + counts[r];
      const diag = new Int32Array(nrows).fill(-1);
      for (let i = 0; i < nrows; i++)
        for (let p = rowptr[i]; p < rowptr[i + 1]; p++) if (colidx[p] === i) { diag[i] = p; break; }
      return { rowptr, colidx: colidx.subarray(0, nnz), re: re.subarray(0, nnz),
               im: im.subarray(0, nnz), diag, nrows, ncols, nnz };
    }
  };
}
// Read Y[i][k] as {re,im}; binary search in sorted row i. Returns {0,0} if absent.
function csrGet(Y, i, k) {
  const lo = Y.rowptr[i], hi = Y.rowptr[i + 1];
  let a = lo, b = hi - 1;
  while (a <= b) { const mid = (a + b) >> 1, c = Y.colidx[mid];
    if (c === k) return { re: Y.re[mid], im: Y.im[mid] };
    if (c < k) a = mid + 1; else b = mid - 1; }
  return { re: 0, im: 0 };
}
// Diagonal scaling Ypu[i][k] = Y[i][k] * 3*vb[i]*vb[k]/Sb (per-unit on per-bus
// bases). The pattern is identical, so this rescales nonzeros in place and
// reuses rowptr/colidx/diag.
function csrScaleRowsCols(Y, vb, Sb) {
  const n = Y.nnz, re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < Y.nrows; i++) {
    const s = 3 * vb[i] / Sb;
    for (let p = Y.rowptr[i]; p < Y.rowptr[i + 1]; p++) {
      const k = Y.colidx[p], f = s * vb[k];
      re[p] = Y.re[p] * f; im[p] = Y.im[p] * f;
    }
  }
  return { rowptr: Y.rowptr, colidx: Y.colidx, re, im, diag: Y.diag,
           nrows: Y.nrows, ncols: Y.ncols, nnz: n };
}

// Complex bus-admittance matrix over the AC nodes only. Constant-impedance
// blocks stamp here; generators / pq loads do not (they are bus types /
// injections). Returns { Y (CSR), ac2pf (node->pf idx), pf2node, m }.
function buildYbus(topo, w) {
  const ac2pf = new Array(topo.nn).fill(-1), pf2node = [];
  for (let n = 0; n < topo.nn; n++) if (topo.type[n] === 'ac') { ac2pf[n] = pf2node.length; pf2node.push(n); }
  const m = pf2node.length;
  const Yb = new SparseBuilder(m, m);
  const pf = (b, ti) => { const n = topo.nid(b, ti); return n < 0 ? -1 : ac2pf[n]; };
  // Stamps accumulate as COO triplets; duplicate (i,j) entries are summed at
  // CSR build time, so parallel branches compose exactly as cAdd did on the
  // dense Y. Negative off-diagonal values are pushed directly.
  // Largest ORDINARY branch admittance in the network, tracked as we stamp. The
  // ideal shorts below are sized against it rather than against an absolute
  // constant; see the GON_PF derivation after the loop.
  // Ordinary admittance accumulated at each node, tracked as we stamp. The ideal
  // shorts (closed breakers, relays) are sized against their OWN neighbours
  // rather than against an absolute constant; see the derivation after the loop.
  // They are collected in `shorts` and stamped afterwards, so they cannot
  // inflate the very number they are scaled by.
  const nodeY = new Float64Array(m);
  const shorts = [];
  const note = (i, j, y) => {
    const a = Math.hypot(y.re, y.im);
    if (i >= 0) nodeY[i] += a;
    if (j >= 0) nodeY[j] += a;
  };
  const stamp = (i, j, y) => {
    note(i, j, y);
    if (i >= 0) Yb.add(i, i, y.re, y.im);
    if (j >= 0) Yb.add(j, j, y.re, y.im);
    if (i >= 0 && j >= 0) { Yb.add(i, j, -y.re, -y.im); Yb.add(j, i, -y.re, -y.im); }
  };
  const addC = (i, j, c) => { note(i, -1, c); if (i >= 0) Yb.add(i, j, c.re, c.im); }; // direct complex stamp
  S.blocks.forEach(b => {
    const P = b.params;
    if (b.type === 'line') {
      let R = P.R, Lh = P.L * 1e-3;
      if ((P.Rm || 0) !== 0 || (P.Lm || 0) !== 0) { R = P.R - P.Rm; Lh = (P.L - P.Lm) * 1e-3; } // positive-seq z1 = zs - zm
      stamp(pf(b, 0), pf(b, 1), yRL(R, Lh, w));
      if (+(P.C || 0) > 0) { // nominal-pi shunt C/2 at each end
        const ysh = { re: 0, im: w * (P.C * 1e-6) / 2 }, i = pf(b, 0), j = pf(b, 1);
        addC(i, i, ysh); addC(j, j, ysh);
      }
    } else if (b.type === 'xfmr') {
      const y = yRL(P.R, P.L * 1e-3, w), a = xfmrA(P, 'xfmr'), i = pf(b, 0), j = pf(b, 1);
      if (i >= 0 && +(P.Lm || 0) > 0) addC(i, i, { re: 0, im: -1 / (w * P.Lm * 1e-3) }); // linear magnetizing shunt (SPEC §2)
      addC(i, i, y);
      addC(j, j, cScale(y, a * a));
      if (i >= 0 && j >= 0) { const ya = cScale(y, a); Yb.add(i, j, -ya.re, -ya.im); Yb.add(j, i, -ya.re, -ya.im); }
    } else if (b.type === 'xfmr3') {
      // positive-sequence complex-ratio stamp (SPEC §2): c = sqrt3·e^(j·σ30°)
      // for a delta side, 1 for wye; Hermitian off-diagonals carry the
      // clock-number shift into the power flow.
      const conn = xfmr3Conn(P);
      const cOf = side => side.t === 'D' ? { re: 1.5, im: side.sig * Math.sqrt(3) / 2 } : { re: 1, im: 0 };
      const c1 = cOf(conn.p), c2 = cOf(conn.s);
      const y = yRL(P.R, P.L * 1e-3, w), a = xfmrA(P, 'xfmr3'), i = pf(b, 0), j = pf(b, 1);
      const m1 = c1.re * c1.re + c1.im * c1.im, m2 = c2.re * c2.re + c2.im * c2.im;
      addC(i, i, cScale(y, m1));
      addC(j, j, cScale(y, a * a * m2));
      // Linear magnetizing shunt at the primary. It hangs across the same
      // primary PORT as the leakage branch, so it carries the same connection
      // factor m1: for a DELTA primary the three magnetizing branches are
      // line-to-line, and |c1|² = 3 is exactly the delta-to-wye conversion.
      // Stamped without it until 2026-07-25, which understated a delta-primary
      // transformer's magnetizing draw threefold and left the PF solution one
      // the EMT run would not hold. m1 = 1 on a wye primary, so every
      // wye-primary case is unchanged.
      if (i >= 0 && +(P.Lm || 0) > 0) addC(i, i, cScale({ re: 0, im: -1 / (w * P.Lm * 1e-3) }, m1));
      if (i >= 0 && j >= 0) {
        const t12 = cScale(cMul(y, cMul(cConj(c1), c2)), -a);
        const t21 = cScale(cMul(y, cMul(c1, cConj(c2))), -a);
        addC(i, j, t12); addC(j, i, t21);
      }
    } else if (b.type === 'xfmr3w') {
      // positive-sequence star (T) stamp: the SAME analytic star-point
      // elimination as the transient companion (SPEC §2), with the xfmr3
      // complex-ratio factor carrying each side's clock number. Writing
      // A_k = a_k·c_k (a_1 = 1 and the primary is always wye, so c_1 = 1) and
      // g_k = 1/(R_k + jωL_k) for the primary-referred leakage arms,
      //   Y[k][j] = conj(A_k)·A_j·(δ_kj·g_k − g_k·g_j/G),  G = g1+g2+g3
      // which degenerates EXACTLY to the two-winding xfmr3 stamp above when one
      // arm is opened (g3 → 0) — the regression anchor for this derivation.
      // Hermitian off-diagonals, so a delta winding's 30° shift reaches machine
      // init downstream just as it does through an xfmr3.
      const sides = xfmr3wConn(P);
      const cSide = sd => sd.t === 'D' ? { re: 1.5, im: sd.sig * Math.sqrt(3) / 2 } : { re: 1, im: 0 };
      const aw = [1].concat(xfmrA(P, 'xfmr3w'));
      const A = [0, 1, 2].map(k => cScale(cSide(sides[k]), aw[k]));
      // A star arm can legitimately land at (near) zero impedance, and one arm's
      // X is often NEGATIVE — both are normal for the T equivalent of a real
      // 3-winding unit and both are fine here. Only an exact 0 + j0 needs a
      // floor, since 1/0 would put Infinity in the matrix.
      const g = [0, 1, 2].map(k => {
        const Rk = +P['R' + (k + 1)], Lk = +P['L' + (k + 1)] * 1e-3;
        return (Rk === 0 && Lk === 0) ? yRL(1e-6, 0, w) : yRL(Rk, Lk, w);
      });
      const G = cAdd(cAdd(g[0], g[1]), g[2]);
      const t = [0, 1, 2].map(k => pf(b, k));
      for (let r = 0; r < 3; r++) for (let q = 0; q < 3; q++) {
        if (t[r] < 0 || t[q] < 0) continue; // grounded winding: V = 0, no equation
        const core = cSub(r === q ? g[r] : { re: 0, im: 0 }, cDiv(cMul(g[r], g[q]), G));
        addC(t[r], t[q], cMul(cMul(cConj(A[r]), A[q]), core));
      }
      if (t[0] >= 0 && +(P.Lm || 0) > 0) addC(t[0], t[0], { re: 0, im: -1 / (w * P.Lm * 1e-3) }); // linear magnetizing shunt at primary
    } else if (b.type === 'cap') {
      stamp(pf(b, 0), pf(b, 1), { re: 0, im: w * P.C * 1e-6 });
    } else if (b.type === 'rlc') {
      // SPEC section 2: series Z = R + j(wL − 1/(wC)); -1 drops that term
      // (R,L→0; C's −1/(wC) term →0, same "absent" convention as the
      // transient companion in blocks.js).
      const Rc = P.R < 0 ? 0 : P.R, Lh = P.L < 0 ? 0 : P.L * 1e-3;
      const Xc = P.C >= 0 ? 1 / (w * P.C * 1e-6) : 0;
      let Z = { re: Rc, im: w * Lh - Xc };
      if (Z.re === 0 && Z.im === 0) Z = { re: 1e-6, im: 0 }; // R,L,C all absent: forced short
      stamp(pf(b, 0), pf(b, 1), cInv(Z));
    } else if (b.type === 'rlcp') {
      // SPEC section 2 (Parallel RLC): admittances sum directly; -1 drops that
      // component (R/L: -1 absent, 0 is a real short). No cInv() needed — we
      // build Y from the start, not Z.
      const hasR = P.R >= 0, hasL = P.L >= 0, hasC = P.C >= 0;
      // same 1e-6 Ω / 1e-9 H short floors as the transient companion (July
      // 2026 review): a literal 1/0 = Infinity would NaN the solve.
      const GR = hasR ? 1 / Math.max(P.R, 1e-6) : 0;
      const imL = hasL ? -1 / (w * Math.max(P.L * 1e-3, 1e-9)) : 0;
      const imC = hasC ? w * P.C * 1e-6 : 0;
      stamp(pf(b, 0), pf(b, 1), { re: GR, im: imL + imC });
    } else if (b.type === 'brk' && +P.init === 1) {
      shorts.push([pf(b, 0), pf(b, 1)]);   // closed breaker ~ short
    } else if (b.type === 'relay' || b.type === 'zrel') {
      // series sensing element: the same closed-breaker conductance it stamps
      // in the EMT solve. Without this the PF silently severed the network at
      // every relay — converged with dead downstream buses (July 2026 review).
      shorts.push([pf(b, 0), pf(b, 1)]);
    }
  });
  // An ideal short only has to DOMINATE ITS OWN NEIGHBOURS, and until
  // 2026-07-27 this stamped an absolute 1e4 S for every one of them. That is a
  // sensible short at 400 V and a catastrophic one at 400 kV, where a
  // transmission corridor is ~0.04 S: the breaker node's self-admittance ends
  // up 2.5e5 times its links, and the Jacobian is scaled so badly that Newton
  // diverges outright.
  //
  // Measured on an 11-bus 400 kV case with 22 closed breakers
  // (studies/Spain_Blackout, pf_splice_v3.js): at 1e4 and 1e3 S Newton blows up
  // to a 6.6e5 pu residual, while at 1e2 S it converges in 24 iterations and
  // reproduces the breaker-free network's answer to four decimals. Splicing the
  // breakers out by hand gives that same answer, which is what confirms the
  // stamp rather than the extra nodes was the cause. Below ~1e1 S the breaker
  // stops being negligible and the answer drifts (0.26% at 1e1, 2.8% at 1e0),
  // so the useful window is a RATIO to the local network, not a constant.
  //
  // The measure has to be LOCAL. A first attempt scaled every short by the
  // largest admittance anywhere in the network, which failed on the same case:
  // one stiff element far away (a source with Rs = 1 ohm, so 1 S) set the scale
  // for breakers whose own corridors are 0.04 S, and the ratio came straight
  // back. Scaling each short by the admittance already accumulated at its own
  // two nodes is immune to that.
  //
  // 1e3 sits inside the measured window: three orders of magnitude is far more
  // than enough to be a short, and far less than enough to wreck conditioning.
  // The min() keeps the historical 1e4 wherever a node is already that stiff,
  // so low-voltage cases are bit-for-bit unchanged. A node with no ordinary
  // branch at all (two shorts in series) has nothing to scale against and falls
  // back to the historical constant.
  for (const [i, j] of shorts) {
    const loc = Math.max(i >= 0 ? nodeY[i] : 0, j >= 0 ? nodeY[j] : 0);
    stamp(i, j, { re: loc > 0 ? Math.min(GON, 1e3 * loc) : GON, im: 0 });
  }
  return { Y: Yb.build(), ac2pf, pf2node, m };
}

// Dense Gaussian elimination with partial pivoting. Returns the solution in
// place of b, or null if the matrix is singular to working precision — the
// caller (Newton-Raphson) treats that as "this step failed" and falls back
// rather than propagating Infinity through the voltages.
function denseSolve(A, b, n) {
  for (let c = 0; c < n; c++) {
    let piv = c, best = Math.abs(A[c][c]);
    for (let r = c + 1; r < n; r++) { const v = Math.abs(A[r][c]); if (v > best) { best = v; piv = r; } }
    if (!(best > 1e-12)) return null;
    if (piv !== c) { const t = A[piv]; A[piv] = A[c]; A[c] = t; const s = b[piv]; b[piv] = b[c]; b[c] = s; }
    const d = A[c][c];
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / d; if (f === 0) continue;
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * b[k];
    b[r] = s / A[r][r];
  }
  return b;
}

// Sparse LU (real) with threshold partial pivoting, natural column order.
// `A` is a CSR {rowptr, colidx, val} over an n x n real matrix. Returns
// {L, U, prow} or null if a column has no pivot above 1e-12 — the SAME null
// contract as `denseSolve`, so `nrPowerFlow`'s "this step failed, fall back to
// GS" branch is unchanged. L (unit diagonal, off-diagonal multipliers stored)
// and U are arrays of sorted [col, val] sparse rows; `prow[r]` is the original
// row index that now sits at position r after row swaps.
//
// Pivot rule (threshold / "Option B", tau = 0.1): keep the natural-order
// diagonal (row c) when |U[c][c]| >= tau * max-in-column; otherwise pivot on
// the max-magnitude row. Preferring the diagonal keeps the natural bus order
// the overwhelming majority of the time, so factor fill stays close to A's
// own pattern. NR only needs a descent direction, so the threshold choice
// changes the stability margin and the fill, never the Newton fixed point.
// Refactored (symbolic + numeric) every call; caching the pivot sequence
// across iterations (numeric-only refactor) is a later optimization.
const SPARSE_TAU = 0.1;
function srowGet(row, c) { // binary search a sorted [col,val] row
  let a = 0, b = row.length - 1;
  while (a <= b) { const m = (a + b) >> 1; if (row[m][0] === c) return row[m][1];
    if (row[m][0] < c) a = m + 1; else b = m - 1; }
  return 0;
}
// dst := dst - mfac * src, merging (fill-in where src has a col dst lacks).
function srowAxpy(dst, src, mfac) {
  const out = []; let i = 0, j = 0;
  while (i < dst.length && j < src.length) {
    const dc = dst[i][0], sc = src[j][0];
    if (dc < sc) { out.push(dst[i++]); }
    else if (sc < dc) { out.push([sc, -mfac * src[j][1]]); j++; } // fill-in
    else { out.push([dc, dst[i][1] - mfac * src[j][1]]); i++; j++; }
  }
  while (i < dst.length) out.push(dst[i++]);
  while (j < src.length) { out.push([src[j][0], -mfac * src[j][1]]); j++; }
  return out;
}
function sparseLU(A, n) {
  const U = new Array(n), L = new Array(n), prow = new Int32Array(n);
  // colRows[c] = set of row positions that currently hold a nonzero at column c.
  // This is what makes the factorization genuinely sparse: the pivot scan and
  // the elimination step visit only the rows that actually have an entry in the
  // pivot column, instead of binary-searching every row (the O(n^2) scan that
  // capped the previous version at ~1s/iter for n ~ 3000). Maintained
  // incrementally as fill is created.
  const colRows = new Array(n);
  for (let c = 0; c < n; c++) colRows[c] = new Set();
  for (let r = 0; r < n; r++) {
    const u = [];
    for (let p = A.rowptr[r]; p < A.rowptr[r + 1]; p++) { const cc = A.colidx[p]; u.push([cc, A.val[p]]); colRows[cc].add(r); }
    u.sort((a, b) => a[0] - b[0]); // rows are pre-sorted, but sort is cheap insurance
    U[r] = u; L[r] = []; prow[r] = r;
  }
  for (let c = 0; c < n; c++) {
    // Pivot candidates: only the rows that currently have an entry at column c.
    let best = 0, pivRow = -1, diag = 0;
    for (const r of colRows[c]) {
      if (r < c) continue;                 // already used as a pivot
      const v = srowGet(U[r], c); const av = Math.abs(v);
      if (r === c) diag = av;
      if (av > best) { best = av; pivRow = r; }
    }
    if (!(best > 1e-12)) return null;
    if (diag >= SPARSE_TAU * best) pivRow = c; // prefer the natural diagonal
    if (pivRow !== c) {
      // Swap positions c and pivRow, including their colRows memberships
      // (recomputed from the pre-swap and post-swap row contents).
      for (const e of U[c]) colRows[e[0]].delete(c);
      for (const e of U[pivRow]) colRows[e[0]].delete(pivRow);
      const tU = U[c]; U[c] = U[pivRow]; U[pivRow] = tU;
      const tL = L[c]; L[c] = L[pivRow]; L[pivRow] = tL;
      const tp = prow[c]; prow[c] = prow[pivRow]; prow[pivRow] = tp;
      for (const e of U[c]) colRows[e[0]].add(c);
      for (const e of U[pivRow]) colRows[e[0]].add(pivRow);
    }
    const d = srowGet(U[c], c);
    // Eliminate column c from every row below that has an entry there.
    // Snapshot the target set: the loop mutates colRows as it fills new columns.
    const targets = Array.from(colRows[c]);
    for (const r of targets) {
      if (r <= c) continue;
      const v = srowGet(U[r], c);
      if (v === 0) continue;
      const mfac = v / d;
      L[r].push([c, mfac]); // c increases monotonically, so L[r] stays col-sorted
      const oldCols = U[r];
      const newU = srowAxpy(U[r], U[c], mfac);
      U[r] = newU;
      // Rebuild row r's colRows membership from its new column set.
      for (let q = 0; q < oldCols.length; q++) colRows[oldCols[q][0]].delete(r);
      for (let q = 0; q < newU.length; q++) colRows[newU[q][0]].add(r);
    }
    // The pivot row is finished; drop it from every column list.
    for (const e of U[c]) colRows[e[0]].delete(c);
  }
  return { L, U, prow };
}
function sparseSolve(fact, b, n) {
  const { L, U, prow } = fact;
  const y = new Float64Array(n);
  for (let r = 0; r < n; r++) y[r] = b[prow[r]];
  for (let r = 0; r < n; r++) { // forward, unit-diagonal L
    let s = y[r]; const Lr = L[r];
    for (let q = 0; q < Lr.length; q++) { const c = Lr[q][0]; if (c < r) s -= Lr[q][1] * y[c]; }
    y[r] = s;
  }
  for (let r = n - 1; r >= 0; r--) { // back, U
    let s = y[r]; const Ur = U[r]; let diag = 0;
    for (let q = 0; q < Ur.length; q++) { const c = Ur[q][0];
      if (c > r) s -= Ur[q][1] * y[c]; else if (c === r) diag = Ur[q][1]; }
    y[r] = s / diag;
  }
  return y;
}

// Minimum-degree fill-reducing ordering for a symmetric-pattern sparse matrix
// given by its COO edges (jRow[j], jCol[j]). Classical Tinney scheme 2 (1967),
// long public domain. Naive but adequate at power-flow scale (N up to a few
// thousand): the ordering is computed ONCE per solve and reused across every
// NR iteration, so an O(N^2)-ish cost is amortized to nothing. Without it the
// natural (imported) bus order gives a large bandwidth and the sparse LU fill
// explodes — a 1648-bus case went from minutes to seconds once ordered.
// Returns perm (new position -> old index) and iperm (old index -> new pos).
function minDegreeOrder(jRow, jCol, N) {
  const adj = new Array(N);
  for (let v = 0; v < N; v++) adj[v] = new Set();
  for (let e = 0; e < jRow.length; e++) {
    const a = jRow[e], b = jCol[e];
    if (a === b) continue;
    adj[a].add(b); adj[b].add(a); // the Jacobian pattern is symmetric
  }
  const eliminated = new Uint8Array(N), perm = new Int32Array(N), deg = new Int32Array(N);
  for (let v = 0; v < N; v++) deg[v] = adj[v].size;
  for (let step = 0; step < N; step++) {
    let best = -1, bestD = Infinity;
    for (let v = 0; v < N; v++) if (!eliminated[v] && deg[v] < bestD) { bestD = deg[v]; best = v; }
    const v = best; perm[step] = v; eliminated[v] = 1;
    const nbrs = [];
    for (const u of adj[v]) if (!eliminated[u]) nbrs.push(u);
    for (let p = 0; p < nbrs.length; p++) {
      const a = nbrs[p];
      adj[a].delete(v);
      for (let q = p + 1; q < nbrs.length; q++) { // clique the neighbours (fill)
        const b = nbrs[q];
        if (!adj[a].has(b)) { adj[a].add(b); adj[b].add(a); }
      }
      deg[a] = adj[a].size;
    }
  }
  const iperm = new Int32Array(N);
  for (let a = 0; a < N; a++) iperm[perm[a]] = a;
  return { perm, iperm };
}

// Polar-form Newton-Raphson power flow — the classical method (Van Ness 1959,
// Tinney & Hart 1967), named in SPEC §5 item 10 as the successor to the MVP
// Gauss-Seidel. GS is a fixed-point iteration: it converges linearly when it
// converges at all, needs 277 sweeps on a 23-bus utility case, and DIVERGES
// outright on a series-compensated network (a negative branch reactance is not
// diagonally dominant) at every acceleration factor. NR converges quadratically
// and is indifferent to both.
//
// Everything here is PER UNIT on the caller's base. That is not cosmetic: in
// volts and watts the Jacobian's four blocks differ by ~14 orders of magnitude
// and the elimination loses every significant digit.
//
// Unknowns: theta at every non-slack bus, |V| at every PQ bus. Standard
// four-block Jacobian
//     [dP/dth   dP/d|V|] [ dth ]   [dP]
//     [dQ/dth   dQ/d|V|] [d|V| ] = [dQ]
// derived straight from S_i = V_i * conj(sum_k Y_ik V_k), which assumes NOTHING
// about symmetry — so it stays correct for the ASYMMETRIC Ybus that a
// phase-shifting (delta) transformer stamps.
//
// Vm/Va are read and updated IN PLACE. Returns { ok, iters, mismatch }.
const DTH_MAX = 0.5, DV_MAX = 0.25; // per-iteration step limits (rad, pu)
function nrPowerFlow(Y, m, busType, Psch, Qsch, Vm, Va, live, tol, maxIter) {
  const pvpq = [], pq = [];
  for (let i = 0; i < m; i++) {
    if (!live[i] || busType[i] === 'slack') continue;
    pvpq.push(i); if (busType[i] === 'PQ') pq.push(i);
  }
  const n1 = pvpq.length, n2 = pq.length, N = n1 + n2;
  if (N === 0) return { ok: true, iters: 0, mismatch: 0 }; // slack-only island set
  const rowOfTh = new Array(m).fill(-1), rowOfV = new Array(m).fill(-1);
  pvpq.forEach((i, r) => rowOfTh[i] = r);
  pq.forEach((i, r) => rowOfV[i] = n1 + r);
  const P = new Array(m).fill(0), Q = new Array(m).fill(0);
  const cosA = new Array(m).fill(0), sinA = new Array(m).fill(0);
  const inject = () => {
    for (let i = 0; i < m; i++) { cosA[i] = Math.cos(Va[i]); sinA[i] = Math.sin(Va[i]); }
    for (let i = 0; i < m; i++) {
      if (!live[i]) { P[i] = Q[i] = 0; continue; }
      let p = 0, q = 0;
      // CSR row walk: each Y_ik nonzero adds V_i V_k (g cos + b sin) to P/Q.
      for (let pp = Y.rowptr[i]; pp < Y.rowptr[i + 1]; pp++) {
        const k = Y.colidx[pp];
        if (!live[k]) continue;
        const g = Y.re[pp], b = Y.im[pp];
        // cos/sin of (theta_i - theta_k) from the cached per-bus values
        const c = cosA[i] * cosA[k] + sinA[i] * sinA[k], s = sinA[i] * cosA[k] - cosA[i] * sinA[k];
        const vv = Vm[i] * Vm[k];
        p += vv * (g * c + b * s);
        q += vv * (g * s - b * c);
      }
      P[i] = p; Q[i] = q;
    }
  };
  // Build the Jacobian's structural + metadata CSR ONCE, on the Ybus pattern
  // restricted to the PVPQ/PQ row/column subsets. Each Y_ik nonzero yields up
  // to four Jacobian cells (dP/dth, dP/dV, dQ/dth, dQ/dV), emitted only when the
  // matching Jacobian row and column both exist (i in PVPQ for a dP row, i in
  // PQ for a dQ row; k in PVPQ for a dth column, k in PQ for a dV column).
  // Every cell maps to a unique (row, col), so no duplicate-summing is needed.
  // Each nonzero caches (g, b) and a block tag so the per-iteration refill
  // needs no further Ybus access. The pattern equals the dense code's nonzero
  // structure exactly: every off-diagonal Jacobian entry is a function of
  // g = Y_ik.re, b = Y_ik.im alone and reads only the ONE-WAY Y_ik (never
  // Y_ki), so the asymmetric phase-shifting-transformer Ybus does not break it.
  const jRow = [], jCol = [], jG = [], jB = [], jI = [], jK = [], jBlk = [], jDiag = [];
  for (let i = 0; i < m; i++) {
    const rP = rowOfTh[i], rQ = rowOfV[i];
    if (rP < 0 && rQ < 0) continue;              // slack/dead bus: no Jacobian row
    for (let pp = Y.rowptr[i]; pp < Y.rowptr[i + 1]; pp++) {
      const k = Y.colidx[pp], g = Y.re[pp], b = Y.im[pp];
      const cTh = rowOfTh[k], cV = rowOfV[k];
      if (cTh < 0 && cV < 0) continue;            // slack/dead column: no Jacobian col
      const diag = (i === k) ? 1 : 0;
      if (rP >= 0 && cTh >= 0) { jRow.push(rP); jCol.push(cTh); jG.push(g); jB.push(b); jI.push(i); jK.push(k); jBlk.push(0); jDiag.push(diag); }
      if (rP >= 0 && cV >= 0)  { jRow.push(rP); jCol.push(cV);  jG.push(g); jB.push(b); jI.push(i); jK.push(k); jBlk.push(1); jDiag.push(diag); }
      if (rQ >= 0 && cTh >= 0) { jRow.push(rQ); jCol.push(cTh); jG.push(g); jB.push(b); jI.push(i); jK.push(k); jBlk.push(2); jDiag.push(diag); }
      if (rQ >= 0 && cV >= 0)  { jRow.push(rQ); jCol.push(cV);  jG.push(g); jB.push(b); jI.push(i); jK.push(k); jBlk.push(3); jDiag.push(diag); }
    }
  }
  const nnzJ = jRow.length;
  // Minimum-degree ordering of the (symmetric) Jacobian pattern, so the sparse
  // LU fill stays close to nnzJ instead of exploding under the imported bus
  // order. Computed once, reused every iteration. Natural order is kept when
  // N is tiny (the sort below then reduces to the identity permutation) and on
  // slack-only island sets we return before reaching here.
  const { perm, iperm } = (N > 1) ? minDegreeOrder(jRow, jCol, N) : { perm: null, iperm: null };
  const rowNew = (r) => perm ? iperm[r] : r; // natural Jacobian index -> ordered position
  const jidx = Array.from({ length: nnzJ }, (_, q) => q)
    .sort((a, c2) => { const ra = rowNew(jRow[a]), rb = rowNew(jRow[c2]);
      return ra !== rb ? ra - rb : rowNew(jCol[a]) - rowNew(jCol[c2]); });
  const Jrowptr = new Int32Array(N + 1), Jcolidx = new Int32Array(nnzJ);
  const Jg = new Float64Array(nnzJ), Jb = new Float64Array(nnzJ), Jval = new Float64Array(nnzJ);
  const Ji = new Int32Array(nnzJ), Jk = new Int32Array(nnzJ), Jblk = new Int32Array(nnzJ), Jdiag = new Uint8Array(nnzJ);
  const cntJ = new Int32Array(N);
  for (let q = 0; q < nnzJ; q++) {
    const o = jidx[q], r = rowNew(jRow[o]);
    Jcolidx[q] = rowNew(jCol[o]); Jg[q] = jG[o]; Jb[q] = jB[o]; Ji[q] = jI[o]; Jk[q] = jK[o]; Jblk[q] = jBlk[o]; Jdiag[q] = jDiag[o];
    cntJ[r]++;
  }
  for (let r = 0; r < N; r++) Jrowptr[r + 1] = Jrowptr[r] + cntJ[r];
  const J = { rowptr: Jrowptr, colidx: Jcolidx, val: Jval, nrows: N, ncols: N, nnz: nnzJ,
              g: Jg, b: Jb, i: Ji, k: Jk, blk: Jblk, diag: Jdiag };
  let it = 0, mis = Infinity, worst = null;
  for (it = 0; it < maxIter; it++) {
    inject();
    mis = 0;
    const rhs = new Float64Array(N);
    // `worst` tracks the ARGMAX alongside the max, so a failure can name the
    // bus and the equation that would not balance. "Did not converge, 4.8 pu"
    // sends you looking at the whole network; "bus 12's reactive equation is
    // 480 Mvar out" sends you at one plant.
    worst = null;
    for (let r = 0; r < n1; r++) {
      const i = pvpq[r]; rhs[r] = Psch[i] - P[i]; const a = Math.abs(rhs[r]);
      if (a > mis) { mis = a; worst = { bus: i, kind: 'P', d: rhs[r] }; }
    }
    for (let r = 0; r < n2; r++) {
      const i = pq[r]; rhs[n1 + r] = Qsch[i] - Q[i]; const a = Math.abs(rhs[n1 + r]);
      if (a > mis) { mis = a; worst = { bus: i, kind: 'Q', d: rhs[n1 + r] }; }
    }
    if (!isFinite(mis)) return { ok: false, iters: it, mismatch: mis, worst, P, Q };
    // P/Q are the injections at the point just solved for, which is what the
    // caller's reactive-limit check needs — no re-evaluation required.
    if (mis < tol) return { ok: true, iters: it, mismatch: mis, worst, P, Q };
    // Refill the Jacobian values from the cached (g,b) + block tag + current
    // operating point. Diagonal cells (i===k) use P[i],Q[i]; off-diagonals use
    // the cos/sin of (theta_i - theta_k). A structurally present cell may
    // evaluate to a numerical zero; threshold pivoting skips it, and null
    // fires only when a whole column is < 1e-12.
    for (let q = 0; q < nnzJ; q++) {
      const blk = Jblk[q], i = Ji[q], k = Jk[q], g = Jg[q], b = Jb[q];
      let v;
      if (Jdiag[q]) {
        if (blk === 0) v = -Q[i] - b * Vm[i] * Vm[i];
        else if (blk === 1) v = P[i] / Vm[i] + g * Vm[i];
        else if (blk === 2) v = P[i] - g * Vm[i] * Vm[i];
        else v = Q[i] / Vm[i] - b * Vm[i];
      } else {
        const c = cosA[i] * cosA[k] + sinA[i] * sinA[k], s = sinA[i] * cosA[k] - cosA[i] * sinA[k];
        const gcbs = g * c + b * s, gsbc = g * s - b * c;
        if (blk === 0) v = Vm[i] * Vm[k] * gsbc;
        else if (blk === 1) v = Vm[i] * gcbs;
        else if (blk === 2) v = -Vm[i] * Vm[k] * gcbs;
        else v = Vm[i] * gsbc;
      }
      Jval[q] = v;
    }
    const fact = sparseLU(J, N);
    if (!fact) return { ok: false, iters: it, mismatch: mis, worst };
    // The Jacobian is stored in ordered positions; permute the RHS into that
    // order, solve, then scatter the step back to natural Jacobian indices.
    let rhsPerm, dx;
    if (perm) {
      rhsPerm = new Float64Array(N);
      for (let a = 0; a < N; a++) rhsPerm[a] = rhs[perm[a]];
      const dxPerm = sparseSolve(fact, rhsPerm, N);
      dx = new Float64Array(N);
      for (let a = 0; a < N; a++) dx[perm[a]] = dxPerm[a];
    } else {
      dx = sparseSolve(fact, rhs, N);
    }
    // Damped Newton. A flat start on a heavily loaded case produces a first step
    // that overshoots far past the solution — on PSS/E's own `sample.raw` it
    // drove a bus magnitude through zero, where the polar formulation is not
    // even defined. Scale the WHOLE step by one factor rather than clipping
    // components, so the Newton direction is preserved; near the solution the
    // limit never binds and quadratic convergence is untouched.
    let big = 0;
    for (let r = 0; r < n1; r++) big = Math.max(big, Math.abs(dx[r]) / DTH_MAX);
    for (let r = 0; r < n2; r++) big = Math.max(big, Math.abs(dx[n1 + r]) / DV_MAX);
    const s = big > 1 ? 1 / big : 1;
    for (let r = 0; r < n1; r++) Va[pvpq[r]] += s * dx[r];
    for (let r = 0; r < n2; r++) {
      const i = pq[r];
      Vm[i] += s * dx[n1 + r];
      if (!(Vm[i] > 1e-6)) return { ok: false, iters: it, mismatch: mis, worst, P, Q }; // collapsed off the solvable sheet
    }
  }
  inject();
  return { ok: false, iters: it, mismatch: mis, worst, P, Q };
}

// Solve the power flow. Returns { converged, iters, maxMismatch, f0, Vnom,
// buses:[{node,Vmag,Vpu,ang,type}], genInit:[{id,type,busType,pf}], err }.
// Side effect on success: writes `pfInit` onto each generator block.
// opt.busType {id: 'slack'|'PV'|'PQ'} overrides the block's pfType param.
function solvePowerFlow(opt) {
  opt = opt || {};
  const vll = S.vconv === 'll'; // report bus Vmag/Vnom in the circuit's convention (LL or phase)
  const topo = buildNodes(3);
  if (topo.err) return { err: topo.err };
  // Series elements with no power-flow model would DISCONNECT the network at
  // their location (not just "miss their draw" like a shunt block), so refuse
  // to solve rather than return a converged solution with dead downstream
  // buses (July 2026 review). Shunt-injection blocks (svc, wt4, hvdc, im)
  // stay allowed: PF simply ignores their steady-state draw (SPEC §7).
  // `tap` joins this list for a different reason than the others: a
  // single-phase lateral is not representable in a POSITIVE-SEQUENCE power
  // flow at all (that is the whole point of the block — an unbalanced
  // connection), so there is no stamp to write, and silently dropping it
  // would leave the lateral's buses dead. Refuse with a clear message
  // instead; the EMT solve handles these circuits directly.
  // `xfmr3w` LEFT this list on 2026-07-23: buildYbus now carries its star (T)
  // equivalent, which is what PSS/E cases with 3-winding units needed.
  const pfSeries = S.blocks.find(b => b.type === 'tline' || b.type === 'fdline' || b.type === 'scale' || b.type === 'tap');
  if (pfSeries) {
    return { err: 'Power flow has no model for ' + DEFS[pfSeries.type].label + ' #' + pfSeries.id + ' — a series element it can\'t stamp would disconnect the network there. Replace it with a plain line/transformer for the PF, or skip the power flow and run the EMT solve directly.' };
  }
  const badXA = xfmrRatioBad();
  if (badXA) {
    return { err: 'Transformer #' + badXA.id + ': rated winding voltages must all be > 0 — check V1/V2' + (badXA.type === 'xfmr3w' ? '/V3' : '') + '.' };
  }
  const freqSrc = S.blocks.find(b => b.type === 'src' || b.type === 'gfm' || b.type === 'syncgen' || b.type === 'gfl');
  const f0 = freqSrc ? (freqSrc.params.f || freqSrc.params.f0 || 60) : 60;
  const w = 2 * Math.PI * f0;
  const { Y, ac2pf, pf2node, m } = buildYbus(topo, w);
  if (!m) return { err: 'No AC buses to solve.' };

  const busType = new Array(m).fill('PQ'), Vset = new Array(m).fill(0);
  const Pset = new Array(m).fill(0), Sinj = Array.from({ length: m }, () => ({ re: 0, im: 0 })), genAt = new Array(m).fill(null);
  // Aggregate reactive band per bus, in VAr (3-phase), plus the two flags that
  // decide whether the band is enforceable at all: qSome = at least one machine
  // declares a band, qFree = at least one machine has none.
  const Qmx = new Array(m).fill(0), Qmn = new Array(m).fill(0);
  const qSome = new Array(m).fill(false), qFree = new Array(m).fill(false);
  const gens = S.blocks.filter(b => b.type === 'syncgen' || b.type === 'gfm' || b.type === 'gfl' || b.type === 'src');
  // A generator's network bus is normally terminal 1 (terminal 0 grounded);
  // fall back to terminal 0 if 1 is the grounded one, so a machine wired the
  // other way round still registers as a PV/slack bus (July 2026 review).
  const genBus = b => { const t1 = topo.nid(b, 1); return t1 >= 0 ? t1 : topo.nid(b, 0); };
  // Machines SHARE a bus in real cases: three motors sit on bus 7 of the IEC
  // 60909 network, and eight buses of `ieee_25bus` carry more than one unit.
  // Until 2026-07-24 each machine simply OVERWROTE the previous one's entry, so
  // only the last record's dispatch ever reached the network — the IEC case
  // injected -2 MW at bus 7 where the file says -9 MW, silently. Aggregate the
  // bus instead: P and the reactive band add up, a declared slack anywhere on
  // the bus wins, and the voltage setpoint comes from the largest unit.
  // `genOn[i]` keeps the machine list so the solved bus generation can be split
  // back onto the individual machines for their EMT initialization (pfResult).
  const genOn = Array.from({ length: m }, () => []);
  let bigS = new Array(m).fill(-1);
  gens.forEach(b => {
    const tb = genBus(b); if (tb < 0) return; const i = ac2pf[tb]; if (i < 0) return;
    const type = (opt.busType && opt.busType[b.id]) || b.params.pfType || 'PV';
    const Pg = (b.type === 'syncgen' ? b.params.Pm0 : (b.type === 'gfm' || b.type === 'gfl') ? b.params.P0 : 0) * 1000;
    // vconv: Vset/E0/Vrms are entered per the circuit's convention (phase RMS,
    // or line-to-line when S.vconv==='ll'). Internally V[i] is per-phase, so
    // divide an LL value by sqrt(3) here (PF always runs at nph=3). The 277/480
    // fallback is the nominal per-phase/LL voltage for the active convention.
    const vs = vPh((b.params.Vset && b.params.Vset > 0) ? b.params.Vset : (b.params.E0 || b.params.Vrms || b.params.Vrated || (vll ? 480 : 277)), 3);
    const sb = +b.params.Sbase || 0;
    if (genOn[i].length === 0 || type === 'slack') busType[i] = (type === 'slack') ? 'slack' : 'PV';
    if (sb > bigS[i]) { Vset[i] = vs; bigS[i] = sb; genAt[i] = b; }
    Pset[i] += Pg;
    genOn[i].push(b);
    // Reactive capability. Both limits zero means "no limit" — the default for
    // every hand-built machine, so pre-2026-07-24 circuits solve unchanged — and
    // ONE machine without a band makes the whole bus unlimited, since it can
    // absorb whatever the others cannot.
    const qx = (+b.params.Qmax || 0) * 1000, qn = (+b.params.Qmin || 0) * 1000;
    if (qx === 0 && qn === 0) qFree[i] = true;
    else { Qmx[i] += qx; Qmn[i] += qn; qSome[i] = true; }
  });
  // A bus's band is enforceable only when EVERY machine on it declares one.
  const hasQLim = new Array(m).fill(false);
  let anyQLim = false;
  for (let i = 0; i < m; i++) if (qSome[i] && !qFree[i]) { hasQLim[i] = true; anyQLim = true; }
  // zip enters at its NOMINAL P0/Q0, like pq — the solve lands near V0
  // where the ZIP polynomial evaluates to ~1 (SPEC §2, approximation in §7)
  S.blocks.filter(b => b.type === 'pq' || b.type === 'zip').forEach(b => {
    const n = topo.nid(b, 0) >= 0 ? topo.nid(b, 0) : topo.nid(b, 1), i = n < 0 ? -1 : ac2pf[n];
    if (i >= 0) Sinj[i] = cSub(Sinj[i], { re: b.params.P * 1000, im: b.params.Q * 1000 });
  });
  // ---- electrical islands -------------------------------------------------
  // A power flow needs one voltage reference per ISLAND, not one per case. Real
  // utility cases are routinely multi-island (a RAW file marks a swing bus per
  // island: PSS/E's own `sample.raw` has six), and a bus whose every element is
  // a record the importer does not model — an HVDC-only converter bus, say —
  // ends up with NO incident admittance and so forms its own island of one.
  // Before July 2026 the solve used the first slack it found and iterated over
  // everything else, so such a bus divided by a zero Y[i][i] and the resulting
  // NaN flooded every other bus through the dense row sums (41 of 45 in
  // `sample.raw`). Label the components first, give each its own reference, and
  // set aside the ones that have no source at all.
  const comp = new Array(m).fill(-1);
  let nComp = 0;
  for (let s = 0; s < m; s++) {
    if (comp[s] >= 0) continue;
    const stack = [s]; comp[s] = nComp;
    while (stack.length) {
      const i = stack.pop();
      // CSR adjacency walk: every stored nonzero is a real edge (Y_ik != 0),
      // so this is O(nnz) rather than the old O(m^2) dense row scan. The diagonal
      // self-entry is skipped because comp[i] is already set when i is pushed.
      for (let p = Y.rowptr[i]; p < Y.rowptr[i + 1]; p++) {
        const k = Y.colidx[p];
        if (comp[k] >= 0) continue;
        comp[k] = nComp; stack.push(k);
      }
    }
    nComp++;
  }
  const hasRef = new Array(nComp).fill(false);
  for (let i = 0; i < m; i++) if (busType[i] === 'slack') hasRef[comp[i]] = true;
  // An island with generation but no declared swing gets its largest machine
  // promoted — the same rule as the old global fallback, applied per island.
  for (let c = 0; c < nComp; c++) {
    if (hasRef[c]) continue;
    let best = -1, bestS = -1;
    for (let i = 0; i < m; i++) if (comp[i] === c && genAt[i]) { const s = genAt[i].params.Sbase || 1e9; if (s > bestS) { bestS = s; best = i; } }
    if (best >= 0) { busType[best] = 'slack'; hasRef[c] = true; }
  }
  // What is left is de-energized in this model: no source anywhere in its
  // island. Hold it out of the iteration and report it by name rather than
  // dividing by a zero diagonal.
  const dead = new Array(m).fill(false);
  let nDead = 0;
  for (let i = 0; i < m; i++) if (!hasRef[comp[i]]) { dead[i] = true; nDead++; }
  let slack = busType.indexOf('slack');
  if (slack < 0) return { err: 'Power flow needs at least one source, generator, or inverter as the slack bus.' };
  const Vnom = Vset[slack] || 199185.8;

  // PER-BUS voltage base. Ybus is in volts and spans every voltage level at
  // once, so a single system-wide base is not enough to start from: normalizing
  // by the slack's base starts a 500 kV bus at 25 pu when the slack is a 20 kV
  // machine. Each bus block already carries its own Vbase (the importer sets it
  // from BASKV) and generators pin their terminal at Vset; anything left over
  // falls back to Vnom, which is the pre-July-2026 behaviour.
  const vb = new Array(m).fill(0);
  S.blocks.forEach(b => {
    if (b.type !== 'bus' || !(+b.params.Vbase > 0)) return;
    const n = topo.nid(b, 0); if (n < 0) return; const i = ac2pf[n];
    if (i >= 0) vb[i] = vPh(+b.params.Vbase, 3);
  });
  for (let i = 0; i < m; i++) if (!(vb[i] > 0)) vb[i] = (Vset[i] > 0 ? Vset[i] : Vnom);

  // Which buses are currently pinned to a reactive limit: 0 free, +1 held at
  // Qmax, -1 at Qmin. Written by whichever solver ran, read by pfResult.
  const qHeld = new Array(m).fill(0);
  const V = new Array(m);
  const flatStart = () => {
    for (let i = 0; i < m; i++) V[i] = { re: dead[i] ? 0 : (busType[i] === 'PQ' ? vb[i] : (Vset[i] || vb[i])), im: 0 };
  };
  flatStart();

  // ---- solve ---------------------------------------------------------------
  // Gauss-Seidel warm start, then Newton-Raphson (SPEC §5 item 10), with plain
  // Gauss-Seidel as the fallback if NR cannot finish.
  //
  // Why the warm start rather than NR straight from flat: the power-flow
  // equations have more than one root, and NR converges to whichever one its
  // start is nearest. On `ieee_harmonics_test_case` a flat start put it on the
  // LOW-VOLTAGE root — a real solution of the equations, 0.036 pu at one bus,
  // and quietly wrong. A handful of unaccelerated GS sweeps cost microseconds
  // and land inside the operating root's basin, which is the whole job of a
  // starter. NR then does what it is good at.
  //
  // opt.method 'nr' | 'gs' | 'auto' (default) pins the choice, which is what the
  // regression test uses to require the two methods agree bus-for-bus.
  const method = opt.method || 'auto';
  const maxIter = opt.maxIter || 4000, tol = (opt.tol || 1e-5) * Vnom, accel = opt.accel || 1.5;
  // Power tolerance Gauss-Seidel is REPORTED against (pu on the same 100 MVA
  // base Newton uses). `tol` above stays what it always was: the voltage step
  // GS stops iterating on. 1e-4 pu is 10 kW across the whole network, loose by
  // Newton's standards and far tighter than the 0.5 MW a utility solver ships
  // with — GS is the fallback, and the point is to catch a wrong answer, not to
  // match Newton digit for digit.
  const GS_PTOL = opt.gsPTol !== undefined ? opt.gsPTol : 1e-4;
  // Blow-up guard: an ill-posed case (no load anywhere, a PV bus that cannot
  // hold its setpoint) used to run every iteration and hand back voltages of
  // order 1e160 as if they were an answer. Stop as soon as the iterate leaves
  // any physical range and say so instead.
  const vBlow = 1e3 * Vnom;
  let iter = 0, maxDelta = 0, diverged = false;
  // One Gauss-Seidel run over V, in place. Returns true if it blew up.
  const gsRun = (nIter, acc) => {
    for (iter = 0; iter < nIter; iter++) {
      maxDelta = 0;
      for (let i = 0; i < m; i++) {
        if (busType[i] === 'slack' || dead[i]) continue;
        let sumOff = { re: 0, im: 0 }, sumAll = { re: 0, im: 0 };
        for (let p = Y.rowptr[i]; p < Y.rowptr[i + 1]; p++) {
          const k = Y.colidx[p];
          const yv = cMul({ re: Y.re[p], im: Y.im[p] }, V[k]);
          sumAll = cAdd(sumAll, yv);
          if (k !== i) sumOff = cAdd(sumOff, yv);
        }
        let Snet, clamped = 0;
        if (busType[i] === 'PV') {
          const Sc = cScale(cMul(V[i], cConj(sumAll)), 3);
          let qb = Sc.im;
          // Reactive limits, Gauss-Seidel form: compute the reactive the bus is
          // taking, and if it leaves the band, hold the limit and let the
          // magnitude float (the bus behaves as PQ from here).
          //
          // The pin has to LATCH, for the same reason the Newton loop's does.
          // Once the magnitude floats, the reactive recomputed from it is the
          // reactive actually being injected, which after clamping sits AT the
          // limit rather than beyond it — so a test that only asks "is it over
          // the limit now" releases the bus every sweep, snaps the magnitude
          // back to the setpoint, and chatters. Release on the same condition
          // the Newton loop uses: the magnitude coming back through the
          // setpoint from the side that means the limit has stopped binding.
          if (hasQLim[i]) {
            if (qHeld[i]) {
              const vmag = cAbs(V[i]);
              if ((qHeld[i] > 0 && vmag > Vset[i]) || (qHeld[i] < 0 && vmag < Vset[i])) qHeld[i] = 0;
              else { qb = (qHeld[i] > 0 ? Qmx[i] : Qmn[i]) + Sinj[i].im; clamped = qHeld[i]; }
            }
            if (!qHeld[i]) {
              const qg = qb - Sinj[i].im; // machine reactive: bus injection less the colocated load
              if (qg > Qmx[i]) { qb = Qmx[i] + Sinj[i].im; clamped = 1; }
              else if (qg < Qmn[i]) { qb = Qmn[i] + Sinj[i].im; clamped = -1; }
            }
          }
          // dispatch NET of any load on the same bus, as in the NR schedule
          Snet = { re: Pset[i] + Sinj[i].re, im: qb };
        } else Snet = Sinj[i];
        const Ii = cConj(cDiv(Snet, cScale(V[i], 3)));
        const dp = Y.diag[i];
        const Yii = { re: Y.re[dp], im: Y.im[dp] };
        let Vnew = cDiv(cSub(Ii, sumOff), Yii);
        if (busType[i] === 'PV' && !clamped) { const mag = cAbs(Vnew) || 1; Vnew = cScale(Vnew, Vset[i] / mag); }
        if (busType[i] === 'PV') qHeld[i] = clamped;
        const Vacc = cAdd(V[i], cScale(cSub(Vnew, V[i]), acc));
        maxDelta = Math.max(maxDelta, cAbs(cSub(Vacc, V[i]))); V[i] = Vacc;
        if (!(cAbs(Vacc) < vBlow)) { diverged = true; break; } // also catches NaN
      }
      if (diverged) { iter++; return true; }
      if (maxDelta < tol) { iter++; return false; }
    }
    return false;
  };

  if (method !== 'gs') {
    const nWarm = opt.gsWarm === undefined ? 6 : opt.gsWarm;
    // unaccelerated: the starter's job is to be in the right basin, not fast
    let warmed = nWarm > 0;
    if (warmed && gsRun(nWarm, 1)) { diverged = false; flatStart(); warmed = false; }
    // Standard pu transformation for a common 3-phase Sb:
    //   Ypu[i][k] = Y[i][k] * 3*Vb_i*Vb_k/Sb,   Spu_i = S_3ph,i/Sb
    // (an exact diagonal rescaling, so any base choice is valid; per-bus bases
    // are chosen because they make the Jacobian entries O(1)).
    // Ypu, live and the declared bus types do not depend on the starting point,
    // so they are built once and shared across both Newton attempts below.
    const Sb = 100e6;
    const Ypu = csrScaleRowsCols(Y, vb, Sb);
    const live = dead.map(d => !d);
    const busTypeDecl = busType.slice();
    // Newton's residual has a NOISE FLOOR, and until 2026-07-27 the default
    // tolerance sat below it. The injection sum for bus i accumulates terms of
    // size Vm_i·Vm_k·|Ypu_ik|, so its rounding error is about eps times that
    // row's sum — no iteration count removes it. A closed breaker used to stamp
    // a fixed 1e4 S, which is 1e4·3·vb²/Sb ≈ 1.6e7 pu at 400 kV, and one such
    // branch in a three-bus case measured a floor of 1.1e-10 pu: the old
    // hardcoded 1e-10 tolerance itself. (buildYbus above now scales that stamp
    // to the branch's own neighbours, which drops the floor by two to three
    // orders on a transmission case but does not remove it, so this estimate
    // still earns its keep.) Newton therefore
    // burned its whole budget AT A SOLVED POINT and reported failure, and the
    // failure path discards the iterate, so the caller got a flat start back.
    // (Spain_Blackout DIAGNOSTICS.md 2026-07-27 — the study was blocked on this
    // for three days, with the breaker stamp and the `gfl` block both wrongly
    // accused along the way.)
    //
    // Raise the default to the floor only when the matrix demands it. A case
    // with no near-short branch has a row sum of order 1e2, so the estimate
    // lands ~1e-13 and `max` keeps the historical 1e-10: every such case is
    // bit-for-bit unchanged. An explicit opt.nrTol still wins outright.
    let yRowMax = 0;
    for (let i = 0; i < m; i++) {
      let s = 0;
      for (let p = Ypu.rowptr[i]; p < Ypu.rowptr[i + 1]; p++) s += Math.hypot(Ypu.re[p], Ypu.im[p]);
      if (s > yRowMax) yRowMax = s;
    }
    // Safety factor 10 over the raw eps·|Y| estimate: the estimate is an upper
    // bound on a single row's rounding, and the measured floors run about an
    // order of magnitude under it, so this accepts the solved point without
    // opening the door to a genuinely unconverged one (the full Spain case
    // still fails at 4.8 pu here, which is what it should do).
    const nrTolDflt = Math.max(1e-10, 10 * Number.EPSILON * yRowMax);
    const nrTol = opt.nrTol !== undefined ? opt.nrTol : nrTolDflt;
    const QTOL = 1e-6, VTOL = 1e-6; // pu, well above round-off and below anything physical
    let r, itersTot = 0, Vmag, Vang;
    // The Gauss-Seidel warm start usually helps, but it can also land Newton in
    // a basin it cannot climb out of inside its iteration budget. A network with
    // SERIES CAPACITORS is the case in point: a RAW branch with X < 0 puts two
    // large, nearly cancelling admittances on one bus, whose small diagonal is
    // exactly what unaccelerated Gauss-Seidel handles worst. PSS/E's own
    // `sample.raw` has three of them and fails from the warm start while
    // converging in 21 iterations from flat. So when Newton fails, throw the
    // warm start away and try once more from a flat start before falling back to
    // Gauss-Seidel. This only ever runs AFTER a failure, so no case that already
    // converged is affected.
    for (let attempt = 0; ; attempt++) {
      const Psch = new Array(m).fill(0), Qsch = new Array(m).fill(0);
      Vmag = new Array(m).fill(1); Vang = new Array(m).fill(0);
      for (let i = 0; i < m; i++) {
        if (dead[i]) continue;
        Vang[i] = cAng(V[i]);
        if (busType[i] === 'PQ') {
          Psch[i] = Sinj[i].re / Sb; Qsch[i] = Sinj[i].im / Sb;
          Vmag[i] = cAbs(V[i]) / vb[i] || 1;
        } else {
          // PV/slack: |V| is held at the setpoint, and the scheduled injection is
          // the machines' dispatch NET of any load on the same bus (Sinj already
          // carries that load, with its sign). Until 2026-07-24 the load was
          // simply dropped here, so a 100 MW machine on a 20 MW load bus pushed
          // 100 MW into the network instead of 80. That is not a rounding-level
          // convention difference on an imported case: `ieee_25bus` puts 1889 MW
          // of its 3528 MW of load on generator buses, and dropping it left the
          // slack absorbing about a thousand MW of phantom surplus.
          Psch[i] = (Pset[i] + Sinj[i].re) / Sb; Vmag[i] = (Vset[i] || vb[i]) / vb[i];
        }
      }
      // Drop anything the warm-start sweeps latched: those clamps were transient
      // guesses on an unconverged iterate, and leaving them set would report a bus
      // as limited that the Newton solve never confirms.
      qHeld.fill(0);
      // A zero band (QT == QB in a RAW file) is the standard way of saying "this
      // machine holds a FIXED reactive output". Such a bus can never regulate, so
      // start it as PQ instead of spending a round discovering that.
      for (let i = 0; i < m; i++) {
        if (!hasQLim[i] || dead[i] || busType[i] !== 'PV' || Qmx[i] !== Qmn[i]) continue;
        busType[i] = 'PQ'; qHeld[i] = 1; Qsch[i] = (Qmx[i] + Sinj[i].im) / Sb;
      }
      // ---- reactive limits: the classical PV-to-PQ outer loop -----------------
      // A PV bus holds its setpoint with unlimited reactive; a real machine has a
      // band. Standard treatment: solve, and wherever the reactive the solution
      // asks for falls outside the band, pin the bus AT the limit and let its
      // magnitude float (it becomes a PQ bus), then re-solve. A pinned bus is
      // released again only if its voltage returns through the setpoint from the
      // side that means the limit has stopped binding: held at Qmax a bus sits
      // BELOW its setpoint, so a magnitude above it means the machine can
      // regulate once more.
      //
      // The switch is an OUTER loop rather than a test inside the Newton
      // iteration because the set of bus types fixes the Jacobian's row/column
      // STRUCTURE, which nrPowerFlow builds and minimum-degree orders once per
      // call. Rounds are bounded, and each re-solve starts warm from the last, so
      // a round typically costs one or two Newton iterations rather than a full
      // solve.
      const flips = new Array(m).fill(0);
      const maxRounds = anyQLim ? (opt.qRounds === undefined ? 10 : opt.qRounds) : 0;
      let rounds = 0;
      for (;;) {
        r = nrPowerFlow(Ypu, m, busType, Psch, Qsch, Vmag, Vang, live, nrTol, opt.nrIter || 40);
        itersTot += r.iters;
        if (!r.ok || rounds >= maxRounds) break;
        let changed = false;
        for (let i = 0; i < m; i++) {
          if (!hasQLim[i] || dead[i] || busType[i] === 'slack') continue;
          const vTgt = (Vset[i] || vb[i]) / vb[i];
          if (busType[i] === 'PV') {
            // r.Q is the BUS injection; the machine's own reactive is that less
            // the colocated load (Sinj already carries the load with its sign),
            // which is the same split pfResult reports the machine by.
            const qg = r.Q[i] - Sinj[i].im / Sb;
            if (qg > Qmx[i] / Sb + QTOL) { busType[i] = 'PQ'; qHeld[i] = 1; Qsch[i] = (Qmx[i] + Sinj[i].im) / Sb; changed = true; flips[i]++; }
            else if (qg < Qmn[i] / Sb - QTOL) { busType[i] = 'PQ'; qHeld[i] = -1; Qsch[i] = (Qmn[i] + Sinj[i].im) / Sb; changed = true; flips[i]++; }
          } else if (qHeld[i] && flips[i] < 3) {
            // A bus that keeps flipping is one whose limit binds almost exactly;
            // stop releasing it after a few tries and leave it pinned, which is
            // the physically meaningful of the two states and terminates.
            if ((qHeld[i] > 0 && Vmag[i] > vTgt + VTOL) || (qHeld[i] < 0 && Vmag[i] < vTgt - VTOL)) {
              busType[i] = 'PV'; qHeld[i] = 0; Vmag[i] = vTgt; changed = true; flips[i]++;
            }
          }
        }
        if (!changed) break;
        rounds++;
      }
      if (r.ok || attempt > 0 || !warmed) break;
      // Newton failed from the warm-started point: reset to the declared bus types
      // and a flat start, and give it one more go.
      for (let i = 0; i < m; i++) busType[i] = busTypeDecl[i];
      qHeld.fill(0);
      flatStart(); diverged = false;
    }
    if (r.ok) {
      for (let i = 0; i < m; i++) V[i] = dead[i] ? { re: 0, im: 0 }
        : { re: Vmag[i] * vb[i] * Math.cos(Vang[i]), im: Vmag[i] * vb[i] * Math.sin(Vang[i]) };
      return pfResult(true, itersTot, r.mismatch, 'nr', false, r.worst);
    }
    if (method === 'nr') return pfResult(false, itersTot, r.mismatch, 'nr', !isFinite(r.mismatch), r.worst);
    // Falling through to Gauss-Seidel alone: put the DECLARED bus types back
    // first. Gauss-Seidel reads Sinj (the load only) at a PQ bus, so leaving a
    // converted generator bus as PQ would drop its machine from the network.
    //
    // `busType0` is NOT that snapshot and restoring it did exactly the damage
    // this comment warns about: it is taken further down, AFTER the zero-width
    // band conversion has already turned every fixed-reactive machine's bus
    // into a PQ bus. `busTypeDecl` is the declared set. Measured on the Spain
    // v2 case before the fix: method 'gs' put gfl#25 at +2541 MW and method
    // 'auto' at -1458 MW on identical voltages, because the fallback had
    // dropped all four inverters' dispatch (DIAGNOSTICS.md 2026-07-27).
    for (let i = 0; i < m; i++) busType[i] = busTypeDecl[i];
    qHeld.fill(0);
    flatStart(); diverged = false; // fall through to Gauss-Seidel alone
  }
  gsRun(maxIter, accel);
  // Gauss-Seidel STOPS on a voltage step, because that is the quantity its
  // iteration produces. It must not REPORT on one. A voltage-delta test asks
  // "did the last sweep move?", and on an ill-conditioned matrix the answer is
  // no long before the network balances: on the Spain v2 case GS returned
  // converged=true after 20 sweeps with the synchronous fleet at 8635 MW
  // against its 15000 MW setpoint — a silent wrong answer, which is worse than
  // the reported failure Newton was giving on the same case (DIAGNOSTICS.md
  // 2026-07-27). Before 2026-07-27 `unit` was 'V' for GS and 'pu' for NR, so
  // the two methods' `maxMismatch` were not even the same quantity.
  //
  // Score the finished iterate the way Newton does instead: the max power
  // mismatch in pu on the same 100 MVA base, so `converged` means the network
  // balances and the number is comparable across methods.
  const gsm = gsMismatch();
  return pfResult(!diverged && gsm.mis < GS_PTOL, iter, gsm.mis, 'gs', diverged, gsm.worst);

  // Max scheduled-minus-actual injection over the live non-slack buses, pu on
  // Sb, with the bus and equation that own it. P is scheduled everywhere; Q
  // only where it is not free to float (a PQ bus, or a PV bus pinned at a
  // reactive limit).
  function gsMismatch() {
    const Sb = 100e6;
    let mis = 0, worst = null;
    const take = (i, kind, d) => { const a = Math.abs(d); if (a > mis) { mis = a; worst = { bus: i, kind, d }; } };
    for (let i = 0; i < m; i++) {
      if (busType[i] === 'slack' || dead[i]) continue;
      let sum = { re: 0, im: 0 };
      for (let p = Y.rowptr[i]; p < Y.rowptr[i + 1]; p++)
        sum = cAdd(sum, cMul({ re: Y.re[p], im: Y.im[p] }, V[Y.colidx[p]]));
      const Sact = cScale(cMul(V[i], cConj(sum)), 3); // 3-phase injection, W/var
      const isPV = busType[i] === 'PV';
      take(i, 'P', ((isPV ? Pset[i] : 0) + Sinj[i].re - Sact.re) / Sb);
      if (!isPV) take(i, 'Q', (Sinj[i].im - Sact.im) / Sb);
      else if (qHeld[i]) take(i, 'Q', ((qHeld[i] > 0 ? Qmx[i] : Qmn[i]) + Sinj[i].im - Sact.im) / Sb);
    }
    return { mis, worst };
  }

  function pfResult(converged, iters, mismatch, meth, blew, worstBus) {
  // Machine-level accessors, shared by the split below. Q limits are 0/0 for
  // "none", so a FIXED output (Qmax === Qmin, both nonzero) is distinguishable
  // from an undeclared band.
  const pOf = g => (g.type === 'syncgen' ? g.params.Pm0 : (g.type === 'gfm' || g.type === 'gfl') ? g.params.P0 : 0) * 1000;
  const sOf = g => Math.max(+g.params.Sbase || 0, 0);
  const qFix = g => { const x = (+g.params.Qmax || 0) * 1000, n = (+g.params.Qmin || 0) * 1000; return (x || n) && x === n ? x : null; };
  const qBand = g => { const x = (+g.params.Qmax || 0) * 1000, n = (+g.params.Qmin || 0) * 1000; return (x || n) ? Math.max(x - n, 0) : 0; };
  // The solve knows only the BUS, so when machines share one, its total output
  // has to be divided among them to initialize each machine separately. P
  // follows each unit's own dispatch, with the residual (which is the entire
  // output at a slack bus, and ~0 at a PV bus) shared by rating. Q gives a
  // fixed-output unit exactly its fixed value and splits what is left by
  // reactive band, falling back to rating when no band is declared.
  const shareGen = (b, Sbus, mates) => {
    let pSum = 0, sSum = 0, fixSum = 0, bandSum = 0, minSum = 0, allBand = true;
    mates.forEach(g => {
      pSum += pOf(g); sSum += sOf(g);
      const f = qFix(g);
      if (f !== null) { fixSum += f; return; }
      const bw = qBand(g);
      if (bw > 0) { bandSum += bw; minSum += (+g.params.Qmin || 0) * 1000; } else allBand = false;
    });
    const wS = sSum > 0 ? sOf(b) / sSum : 1 / mates.length;
    const fx = qFix(b);
    // Q follows the classical rule "proportional to reactive RANGE, offset by
    // each unit's own minimum": Q_i = Qmin_i + (Qbus - sum Qmin)*band_i/sum band.
    // That allocation is what puts every machine exactly on its OWN limit when
    // the bus is pinned at the aggregate one; a plain band-proportional share
    // does not, and would report a unit above its Qmax while the bus total was
    // right. A unit with a FIXED output takes it first; if any unit has no band
    // the bus is unlimited anyway, so share by rating instead.
    const Q = fx !== null ? fx
      : (allBand && bandSum > 0
        ? (+b.params.Qmin || 0) * 1000 + (Sbus.im - fixSum - minSum) * (qBand(b) / bandSum)
        : (Sbus.im - fixSum) * wS);
    return { re: pOf(b) + (Sbus.re - pSum) * wS, im: Q };
  };
  const genInit = [];
  const busGen = {}; // pf bus -> total machine output there, computed once
  let nQlim = 0;
  for (let i = 0; i < m; i++) if (qHeld[i] && !dead[i]) nQlim++;
  gens.forEach(b => {
    const tb = genBus(b); if (tb < 0) return; const i = ac2pf[tb]; if (i < 0 || dead[i]) return;
    if (busGen[i] === undefined) {
      let sumAll = { re: 0, im: 0 };
      for (let p = Y.rowptr[i]; p < Y.rowptr[i + 1]; p++) {
        const k = Y.colidx[p];
        sumAll = cAdd(sumAll, cMul({ re: Y.re[p], im: Y.im[p] }, V[k]));
      }
      const Snetwork = cScale(cMul(V[i], cConj(sumAll)), 3);
      busGen[i] = cSub(Snetwork, Sinj[i]); // machines also supply any local pq draw
    }
    const mates = genOn[i];
    const Sgen = mates.length > 1 ? shareGen(b, busGen[i], mates) : busGen[i];
    const Igen = cConj(cDiv(Sgen, cScale(V[i], 3)));
    const Ra = (b.type === 'syncgen') ? b.params.Ra : (b.type === 'gfm') ? b.params.Rf : (b.params.Rs || 0);
    const Lint = (b.type === 'syncgen') ? b.params.Ld * 1e-3 : (b.type === 'gfm') ? b.params.Lf * 1e-3 : 0;
    const Eprime = cAdd(V[i], cMul({ re: Ra, im: w * Lint }, Igen));
    b.pfInit = { th: cAng(Eprime), E: cAbs(Eprime), Vt: cAbs(V[i]), ang: cAng(V[i]), P: Sgen.re, Q: Sgen.im, f: f0 };
    genInit.push({ id: b.id, type: b.type, busType: busType[i], pf: b.pfInit,
      qlim: qHeld[i] > 0 ? 'max' : qHeld[i] < 0 ? 'min' : null });
  });
  // Per-TERMINAL node voltage phasor (phase A, per-phase RMS volts), written
  // onto every block alongside the machines' `pfInit`. This is what lets the
  // EMT solve seed passive element histories from the operating point (SPEC §2
  // "Passive-history initialization", §5 item 32). It is stored per block and
  // terminal rather than per node on purpose: `simulate()` rebuilds `topo` with
  // its own node numbering (and possibly a different nph), so a node-indexed
  // array would not survive the trip. A block's terminals do.
  //   { re, im } — solved phasor
  //   grounded terminal -> the phasor 0 (a real, known value, not "unknown")
  //   null             -> not solvable here (DC node, or a de-energized bus):
  //                       the element seeds nothing and cold-starts as before.
  S.blocks.forEach(b => {
    b.pfV = getTerms(b).map((_, ti) => {
      const n = topo.nid(b, ti);
      if (n < 0) return { re: 0, im: 0 };
      const i = ac2pf[n];
      if (i < 0 || dead[i]) return null;
      return { re: V[i].re, im: V[i].im };
    });
  });
  // per bus-block result, for canvas annotation (maps the solution back to the
  // 'bus' blocks the user sees, not the internal node numbering). Vmag/Vnom are
  // reported in the circuit's convention (LL = per-phase * sqrt(3) when vconv='ll');
  // Vpu is convention-independent (per-phase / per-phase).
  const Vm = i => vll ? cAbs(V[i]) * Math.sqrt(3) : cAbs(V[i]);
  const VnomR = vll ? Vnom * Math.sqrt(3) : Vnom;
  const busBlocks = [], deadBuses = [];
  S.blocks.filter(b => b.type === 'bus').forEach(b => {
    const n = topo.nid(b, 0); if (n < 0) return; const i = ac2pf[n]; if (i < 0) return;
    // Per-bus voltage base: when Vbase > 0 use it (entered in the circuit's
    // convention, so vPh recovers the per-phase base), else fall back to the
    // slack-derived Vnom so a bus without an explicit base still reads ~1.0 pu
    // at the slack voltage. This fixes multi-voltage-level circuits where a 480 V
    // bus behind a 13.8 kV:480 V transformer otherwise reads 0.035 pu.
    const base = +b.params.Vbase > 0 ? vPh(+b.params.Vbase, 3) : Vnom;
    // Per-bus voltage limits for the canvas band: NVHI/NVLO from the import
    // (or hand-set), falling back to 0.95/1.05 when 0 so every existing circuit
    // (Vhi=Vlo=0) colors identically to the old hardcoded band.
    const Vhi = +b.params.Vhi > 0 ? +b.params.Vhi : 1.05;
    const Vlo = +b.params.Vlo > 0 ? +b.params.Vlo : 0.95;
    const rec = { id: b.id, name: b.params.name || ('Bus #' + b.id), Vmag: Vm(i), Vpu: cAbs(V[i]) / base, ang: cAng(V[i]) * 180 / Math.PI, Vhi, Vlo };
    if (dead[i]) { rec.dead = true; deadBuses.push(rec.name); }
    busBlocks.push(rec);
  });
  // Human name for a power-flow bus index. A `bus` block's name is the best
  // label; failing that, name whatever machine or load sits on the node, since
  // an internal node (the point between a step-up transformer and its breaker,
  // say) has no name of its own and "pf bus 12" tells nobody anything.
  const busLabel = i => {
    const node = pf2node[i];
    let gen = null, any = null;
    for (const b of S.blocks) {
      // getTerms, not DEFS[type].terms: a `bus` block's tap count is a PARAM,
      // so the static list has one entry while the block has a dozen terminals.
      const nt = getTerms(b).length;
      for (let t = 0; t < nt; t++) {
        if (topo.nid(b, t) !== node) continue;
        if (b.type === 'bus') return 'bus "' + (b.params.name || ('#' + b.id)) + '"';
        if (!gen && (b.type === 'syncgen' || b.type === 'gfm' || b.type === 'gfl' || b.type === 'src')) gen = b;
        if (!any && b.type !== 'gnd' && b.type !== 'probe') any = b;
      }
    }
    const pick = gen || any;
    return pick ? (DEFS[pick.type].label + ' #' + pick.id + "'s bus") : ('pf bus ' + i);
  };
  const notes = [];
  if (!converged) {
    notes.push(blew
      ? 'Diverged: bus voltages left any physical range.'
      : 'Did not reach tolerance in ' + iters + ' iterations.');
    // Name the equation that would not balance. A bare "mismatch 4.8 pu" is a
    // property of the whole network and sends you looking everywhere; the worst
    // bus and whether it was the P or the Q equation usually points straight at
    // the offending machine or load (added 2026-07-27, after three days of
    // bisecting the Spain case by deleting blocks one at a time).
    if (worstBus) {
      const lbl = busLabel(worstBus.bus);
      notes.push('Worst residual: ' + worstBus.kind + ' at ' + lbl + ', off by ' +
        Math.abs(worstBus.d * 100).toPrecision(3) + (worstBus.kind === 'P' ? ' MW' : ' Mvar') + '.');
    }
    // Most real non-convergence is a POWER BALANCE problem, not a numerical one,
    // and the balance is knowable before any iteration runs. The common case
    // after an import is an island whose infeed came through equipment the
    // importer does not model (HVDC above all), leaving its slack machine to
    // make up thousands of MW it has no rating for. Say that instead of making
    // the user guess. Reported per island, worst first.
    const bal = [];
    for (let c = 0; c < nComp; c++) {
      let load = 0, gen = 0, slackMVA = 0, n = 0;
      for (let i = 0; i < m; i++) {
        if (comp[i] !== c) continue;
        n++; load -= Sinj[i].re;
        if (busType[i] === 'slack') slackMVA += (genAt[i] && genAt[i].params.Sbase || 0) * 1000;
        else if (genAt[i]) gen += Pset[i];
      }
      if (n) bal.push({ c, n, need: load - gen, slackMVA });
    }
    bal.sort((a, b) => Math.abs(b.need) - Math.abs(a.need));
    const w = bal[0];
    if (w && Math.abs(w.need) > 1e6) {
      notes.push('Largest imbalance: an island of ' + w.n + ' bus(es) needs ' + (w.need / 1e6).toFixed(0) +
        ' MW from its slack machine' + (w.slackMVA > 0 ? ', which is rated ' + (w.slackMVA / 1e6).toFixed(0) + ' MVA' : '') +
        '. If this case was imported, check whether its infeed arrives through equipment the importer does not model (HVDC, FACTS, induction machines).');
    } else {
      notes.push('Check that every PV generator can hold its setpoint and that the slack bus voltage is right.');
    }
  }
  if (nDead) notes.push(nDead + ' bus(es) de-energized (' + deadBuses.slice(0, 4).join(', ') + (nDead > 4 ? ', ...' : '') + '): no source anywhere in their island. Solved without them.');
  if (nQlim) notes.push(nQlim + ' bus(es) held at a generator reactive limit, so their voltage is off setpoint.');
  return {
    converged, iters, maxMismatch: mismatch, unit: 'pu', method: meth,
    f0, Vnom: VnomR, diverged: !!blew, islands: nComp, deadBuses, nDead, nQlim,
    note: notes.join(' '),
    buses: pf2node.map((node, i) => ({ node, Vmag: Vm(i), Vpu: cAbs(V[i]) / Vnom, ang: cAng(V[i]) * 180 / Math.PI, type: busType[i], dead: dead[i] })),
    busBlocks, genInit
  };
  }
}

// Clear any stored power-flow initialization (revert to cold start).
function clearPowerFlowInit() { S.blocks.forEach(b => { delete b.pfInit; delete b.pfV; }); }
