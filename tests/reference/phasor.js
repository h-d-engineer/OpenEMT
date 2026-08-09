// phasor.js — independent phasor reference for the validation suite (SPEC §5
// item 9). Complex arithmetic plus a small nodal solver, used to cross-check
// time-domain simulation results against a solution that does NOT share code
// with src/solver.js's trapezoidal companion model.
//
// This file is deliberately self-contained: no require of src/, no DOM stubs,
// no app state. It is pure complex linear algebra. The pi-line smoke test
// (smoke_test.js) was the first check pointed at it; the helper is the path
// for giving other blocks an independent nodal cross-check alongside their
// closed-form analytical checks.
//
// Reference type: independent-solver. Distinct from the "analytical" checks
// (a closed-form phasor derived by hand) and from any future reference-tool
// (PSCAD-Free) cross-check.

// Complex numbers are [re, im] pairs (arrays, not objects: cheaper and the
// shape the nodal solver wants for its Ybus entries).
const c = (re, im) => [re, im];
const cadd = (a, b) => [a[0] + b[0], a[1] + b[1]];
const csub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const cmul = (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
const cdiv = (a, b) => {
  const d = b[0] * b[0] + b[1] * b[1];
  return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d];
};
const cabs = a => Math.hypot(a[0], a[1]);
const cinv = a => cdiv([1, 0], a);
const conj = a => [a[0], -a[1]];

// Admittance of a series R + jwL branch (R in ohms, L in henries).
const yRL = (R, L, w) => {
  const re = R, im = w * L;
  const d = re * re + im * im;
  return [re / d, -im / d];
};
// Admittance of a capacitance C (farads) to ground.
const yC = (C, w) => [0, w * C];

// nodalSolve: build a complex Ybus for a small circuit and solve for the
// non-slack node voltages. The circuit is described by:
//   nodes:   number of unknown nodes (numbered 0..nodes-1)
//   slackV:  complex voltage of the slack (reference) node, treated as node -1
//   inj:     map node -> complex current injection (A), e.g. a Norton source
//   branches: array of {from, to, y} where from/to are node indices 0..nodes-1
//            OR -1 for the slack node, and y is a complex admittance.
// Returns an array of complex node voltages (one per unknown node).
//
// This is a standard complex nodal formulation: Y V = I, solved by Gaussian
// elimination with partial pivoting. It is the same math any phasor solver
// does, kept independent of the time-domain companion-model code.
function nodalSolve(nodes, slackV, inj, branches) {
  // Build Ybus (nodes x nodes) and Iinj.
  const Y = Array.from({ length: nodes }, () => Array.from({ length: nodes }, () => [0, 0]));
  const I = Array.from({ length: nodes }, () => [0, 0]);
  for (const k in inj) I[+k] = inj[k];
  for (const br of branches) {
    const { from, to, y } = br;
    const sFrom = from === -1, sTo = to === -1;
    if (!sFrom && !sTo) {
      Y[from][from] = cadd(Y[from][from], y);
      Y[to][to] = cadd(Y[to][to], y);
      const ny = [-y[0], -y[1]];
      Y[from][to] = cadd(Y[from][to], ny);
      Y[to][from] = cadd(Y[to][from], ny);
    } else if (sFrom && !sTo) {
      // branch from slack to node `to`: admittance to ground at `to` driven
      // by slackV through y. Move the slack contribution to the RHS.
      Y[to][to] = cadd(Y[to][to], y);
      I[to] = cadd(I[to], cmul(y, slackV));
    } else if (!sFrom && sTo) {
      Y[from][from] = cadd(Y[from][from], y);
      I[from] = cadd(I[from], cmul(y, slackV));
    }
    // both-slack branch contributes nothing to the unknowns.
  }
  // Gaussian elimination with partial pivoting over complex entries.
  const A = Y.map((row, i) => [...row, I[i]]);
  for (let col = 0; col < nodes; col++) {
    let piv = col, best = cabs(A[col][col]);
    for (let r = col + 1; r < nodes; r++) {
      const m = cabs(A[r][col]);
      if (m > best) { best = m; piv = r; }
    }
    if (piv !== col) { const t = A[col]; A[col] = A[piv]; A[piv] = t; }
    const pv = A[col][col];
    for (let r = col + 1; r < nodes; r++) {
      const f = cdiv(A[r][col], pv);
      if (f[0] === 0 && f[1] === 0) continue;
      for (let k = col; k <= nodes; k++) A[r][k] = csub(A[r][k], cmul(f, A[col][k]));
    }
  }
  const V = Array.from({ length: nodes }, () => [0, 0]);
  for (let r = nodes - 1; r >= 0; r--) {
    let s = A[r][nodes];
    for (let k = r + 1; k < nodes; k++) s = csub(s, cmul(A[r][k], V[k]));
    V[r] = cdiv(s, A[r][r]);
  }
  return V;
}

module.exports = { c, cadd, csub, cmul, cdiv, cabs, cinv, conj, yRL, yC, nodalSolve };