// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Hiva Nasiri. Commercial licensing: see LICENSING.md
// blocks.js — block catalog + companion-model element factory.
// To add a block: (1) derive its companion model in SPEC.md section 2,
// (2) add a DEFS entry, (3) add a case in makeElements, (4) add SVG in ui.js
// renderBlock if it needs a custom symbol (default is a labeled rect).

const DEFS = {
  src: {
    w: 80, h: 52, label: 'AC Src',
    params: { Vrms: { v: 277, l: 'V rms' }, f: { v: 60, l: 'Hz' }, Rs: { v: 0.5, l: 'Rs (Ω)' } },
    terms: [[0, 26], [80, 26]]
  },
  line: {
    w: 88, h: 40, label: 'Line',
    params: {
      R: { v: 0.3, l: 'R (Ω)' }, L: { v: 2, l: 'L (mH)' },
      Rm: { v: 0, l: 'R mutual (Ω)' }, Lm: { v: 0, l: 'L mutual (mH)' },
      C: { v: 0, l: 'C total (µF, π-split)' },
      RATE1: { v: 0, l: 'rating 1 (MVA, 0=none)' },
      RATE2: { v: 0, l: 'rating 2 (MVA, 0=none)' },
      RATE3: { v: 0, l: 'rating 3 (MVA, 0=none)' },
      LEN: { v: 0, l: 'length (user units, 0=none)' },
      metre: { v: 0, l: 'metered end (1=from,2=to,0=none)' }
    },
    terms: [[0, 20], [88, 20]]
  },
  tline: {
    w: 96, h: 40, label: 'TW Line',
    params: {
      Z: { v: 300, l: 'surge Z (Ω)' },
      tau: { v: 100, l: 'travel time (µs)' },
      R: { v: 0, l: 'R total (Ω, lumped)' }
    },
    terms: [[0, 20], [96, 20]]
  },
  fdline: {
    w: 96, h: 40, label: 'FD Line',
    params: {
      Zh: { v: 250, l: 'Zc high-f (Ω)' }, Zlf: { v: 320, l: 'Zc low-f (Ω)' },
      fz: { v: 100, l: 'Zc pole (Hz)' },
      att: { v: 0.95, l: 'H dc gain (att)' }, fh: { v: 2000, l: 'H pole (Hz)' },
      tau: { v: 100, l: 'travel time (µs)' }
    },
    terms: [[0, 20], [96, 20]]
  },
  pq: {
    w: 76, h: 48, label: 'AC PQ',
    params: {
      P: { v: 8, l: 'P (kW)' }, Q: { v: 3, l: 'Q (kvar, +lag/-lead)' },
      f: { v: 60, l: 'f (Hz)' }, Tf: { v: 20, l: 'meas filter (ms)' },
      vmin: { v: 50, l: 'UVLO (V)' }
    },
    terms: [[0, 24], [76, 24]]
  },
  zip: {
    w: 76, h: 48, label: 'ZIP Load',
    params: {
      P: { v: 8, l: 'P @ V0 (kW)' }, Q: { v: 3, l: 'Q @ V0 (kvar)' },
      V0: { v: 277, l: 'V0 nominal (V rms)' },
      az: { v: 0.4, l: 'P: Z frac' }, ai: { v: 0.3, l: 'P: I frac' }, ap: { v: 0.3, l: 'P: P frac' },
      bz: { v: 0.4, l: 'Q: Z frac' }, bi: { v: 0.3, l: 'Q: I frac' }, bp: { v: 0.3, l: 'Q: P frac' },
      f: { v: 60, l: 'f (Hz)' }, Tf: { v: 20, l: 'meas filter (ms)' },
      vmin: { v: 50, l: 'UVLO (V, sheds I+P parts)' }
    },
    terms: [[0, 24], [76, 24]]
  },
  cap: {
    w: 70, h: 44, label: 'Cap',
    params: { C: { v: 100, l: 'C (µF)' } },
    terms: [[0, 22], [70, 22]]
  },
  rlc: {
    w: 84, h: 44, label: 'Series RLC',
    params: {
      R: { v: 10, l: 'R (Ω, -1=absent)' }, L: { v: 5, l: 'L (mH, -1=absent)' },
      C: { v: 100, l: 'C (µF, -1=absent)' }
    },
    terms: [[0, 22], [84, 22]]
  },
  rlcp: {
    w: 84, h: 44, label: 'Parallel RLC',
    params: {
      R: { v: 1000, l: 'R (Ω, -1=absent)' }, L: { v: 5, l: 'L (mH, -1=absent)' },
      C: { v: 100, l: 'C (µF, -1=absent)' }
    },
    terms: [[0, 22], [84, 22]]
  },
  brk: {
    w: 74, h: 40, label: 'Brk',
    params: {
      tclose: { v: 30, l: 't close (ms)' }, topen: { v: -1, l: 't open (ms)' }, init: { v: 0, l: 'init (0=open)' },
      nOps: { v: 1, l: '# operations (1-5)' }
    },
    // nOps>1: operations 2-5 add tclose2/topen2 .. tclose5/topen5 (rendered
    // dynamically in ui.js showProps, not listed here so a plain single-op
    // breaker's panel stays uncluttered). See SPEC.md brk section.
    terms: [[0, 20], [74, 20]]
  },
  relay: {
    w: 74, h: 44, label: 'OC Relay',
    params: {
      Ipu: { v: 20, l: 'pickup (A rms)' },
      curve: { v: 'VI', l: 'curve (MI/VI/EI)', t: 'text' },
      TD: { v: 0.5, l: 'time dial' },
      Iinst: { v: 0, l: 'inst 50 (A rms, 0=off)' },
      brkId: { v: 0, l: 'breaker block #' },
      f: { v: 60, l: 'f (Hz, RMS window)' }
    },
    terms: [[0, 22], [74, 22]]
  },
  xfmr: {
    w: 88, h: 44, label: 'Xfmr',
    params: {
      V1: { v: 240, l: 'V rated wdg 1' }, V2: { v: 120, l: 'V rated wdg 2' },
      R: { v: 0.1, l: 'R leak (Ω)' }, L: { v: 0.5, l: 'L leak (mH)' },
      Lm: { v: 0, l: 'magnetizing Lm (mH, 0=off)' },
      lknee: { v: 0, l: 'knee flux (V·s pk, 0=linear)' },
      Lsat: { v: 20, l: 'saturated L (mH)' }
    },
    terms: [[0, 22], [88, 22]]
  },
  xfmr3: {
    w: 88, h: 52, label: 'Xfmr 3ph',
    params: {
      conn: { v: 'Dy11', l: 'conn (Yy0/Dy1/Dy11/Yd1/Yd11)', t: 'text' },
      V1: { v: 4160, l: 'V rated wdg 1 (LL)' }, V2: { v: 480, l: 'V rated wdg 2 (LL)' },
      R: { v: 0.1, l: 'R leak (Ω)' }, L: { v: 0.5, l: 'L leak (mH)' },
      Rn1: { v: 0, l: 'Y1 neutral Rn (Ω, -1=ungnd)' },
      Rn2: { v: 0, l: 'Y2 neutral Rn (Ω, -1=ungnd)' },
      Lm: { v: 0, l: 'magnetizing Lm (mH, 0=off)' }
    },
    // 3-ph only. Winding ratio a = N1/N2 is derived from the line-line nameplate
    // voltages and the Y/D connection: a = (V1/V2)*(k2/k1), k = sqrt(3) for a wye
    // side, 1 for a delta side (SPEC §2). V1/V2 are fixed LL, not vconv-scaled.
    terms: [[0, 26], [88, 26]]
  },
  xfmr3w: {
    w: 96, h: 56, label: 'Xfmr 3W',
    params: {
      conn: { v: 'Yy0d1', l: 'conn (Yy0y0/Yy0d1/Yy0d11/Yd1d1)', t: 'text' },
      V1: { v: 13800, l: 'V rated wdg 1 (LL)' }, V2: { v: 480, l: 'V rated wdg 2 (LL)' },
      V3: { v: 12470, l: 'V rated wdg 3 (LL)' },
      R1: { v: 0.05, l: 'R1 (Ω)' }, L1: { v: 0.3, l: 'L1 (mH)' },
      R2: { v: 0.05, l: "R2' (Ω, pri-ref)" }, L2: { v: 0.3, l: "L2' (mH)" },
      R3: { v: 0.05, l: "R3' (Ω, pri-ref)" }, L3: { v: 0.3, l: "L3' (mH)" },
      Rn1: { v: 0, l: 'Y1 neutral Rn (Ω, -1=ungnd)' },
      Rn2: { v: 0, l: 'Y2 neutral Rn (Ω, -1=ungnd)' },
      Rn3: { v: 0, l: 'Y3 neutral Rn (Ω, -1=ungnd)' },
      Lm: { v: 0, l: 'magnetizing Lm (mH, 0=off)' }
    },
    // term 0 = primary (left), term 1 = secondary (right top),
    // term 2 = tertiary (right bottom). 3-ph only (SPEC §2).
    terms: [[0, 28], [96, 14], [96, 42]]
  },
  gfm: {
    w: 96, h: 72, label: 'GFM Inv',
    params: {
      mode: { v: 0, l: 'mode (0=GFM droop,1=GFL)' },
      E0: { v: 277, l: 'E0 (V rms)' }, f0: { v: 60, l: 'f0 (Hz)' },
      mp: { v: 0.05, l: 'P droop/gain (Hz/kW)' }, mq: { v: 0.5, l: 'Q droop/gain (V/kvar)' },
      P0: { v: 0, l: 'P set (kW)' }, Q0: { v: 0, l: 'Q set (kvar)' },
      kiP: { v: 0.05, l: 'GFL ki P (Hz/kW/s)' }, kiQ: { v: 2, l: 'GFL ki Q (V/kvar/s)' },
      Rf: { v: 0.1, l: 'Rf (Ω)' }, Lf: { v: 1, l: 'Lf (mH)' }, Tf: { v: 20, l: 'meas filter (ms)' },
      Idcmax: { v: 100, l: 'I dc max (A)' },
      Iacmax: { v: 0, l: 'I ac max (A rms/ph, 0=off)' },
      pfType: { v: 'PV', l: 'PF bus (slack/PV/PQ)', t: 'text' }, Vset: { v: 0, l: 'PF V set (V, 0=E0)' },
      Qmax: { v: 0, l: 'PF Q max (kvar, 0/0=none)' }, Qmin: { v: 0, l: 'PF Q min (kvar, 0/0=none)' }
    },
    // term 0/1 = AC (3-ph, series EMF-behind-Rf-Lf across them, unchanged);
    // term 2 = DC+ (bottom-center, off the main AC axis like fault's top
    // terminal) — DC return via ground, same convention as pfc/batt. Optional:
    // unwired, the block behaves exactly as before (idealized AC-only source).
    terms: [[0, 28], [96, 28], [48, 72]]
  },
  syncgen: {
    w: 84, h: 52, label: 'Sync Gen',
    params: {
      H: { v: 4, l: 'inertia H (s)' }, Sbase: { v: 50, l: 'rated S (kVA)' },
      Ra: { v: 0.05, l: 'Ra (Ω)' }, Ld: { v: 2, l: "Xd' transient (mH)" },
      f0: { v: 60, l: 'f0 (Hz)' }, E0: { v: 277, l: 'E0 (V rms)' },
      Pm0: { v: 0, l: 'Pm mech power (kW)' }, Kgov: { v: 15, l: 'governor droop (kW/Hz)' },
      D: { v: 25, l: 'damping (kW/Hz)' },
      Q0: { v: 0, l: 'Q set (kvar)' }, mq: { v: 0.5, l: 'AVR droop (V/kvar)' }, Tf: { v: 20, l: 'meas filter (ms)' },
      Tg: { v: 0, l: 'governor lag Tg (s, 0=off)' }, Pmax: { v: 0, l: 'Pm ceiling (kW, 0=off)' },
      Te: { v: 0, l: 'exciter lag Te (s, 0=off)' }, Ka: { v: 50, l: 'AVR gain Ka' },
      Vref: { v: 0, l: 'AVR Vref (V rms, 0=E0)' }, Emax: { v: 0, l: 'E ceiling (V, 0=off)' },
      pfType: { v: 'PV', l: 'PF bus (slack/PV/PQ)', t: 'text' }, Vset: { v: 0, l: 'PF V set (V, 0=E0)' },
      Qmax: { v: 0, l: 'PF Q max (kvar, 0/0=none)' }, Qmin: { v: 0, l: 'PF Q min (kvar, 0/0=none)' }
    },
    // 3-ph AC only — a rotating machine has no natural DC side, unlike gfm.
    // term 0/1 = AC (series EMF-behind-Ra-Ld, same branch topology as gfm's
    // AC pair). Rotor angle/frequency are dynamic states (swing equation,
    // SPEC §2) instead of gfm's algebraic droop/PI — that's the whole point
    // of this block: real inertial response, not an instantaneous P-f line.
    terms: [[0, 26], [84, 26]]
  },
  im: {
    w: 84, h: 52, label: 'Ind Motor',
    params: {
      Rs: { v: 0.45, l: 'Rs stator (Ω)' }, Lls: { v: 4, l: 'Lls stator leak (mH)' },
      Lm: { v: 120, l: 'Lm magnetizing (mH)' },
      Rr: { v: 0.6, l: "Rr' rotor (Ω)" }, Llr: { v: 4, l: "Llr' rotor leak (mH)" },
      H: { v: 0.5, l: 'inertia H (s)' }, Sbase: { v: 15, l: 'rated S (kVA)' },
      PL: { v: 10, l: 'load P @ sync (kW)' }, kexp: { v: 2, l: 'torque exp k (0=const,2=fan)' },
      s0: { v: 0.03, l: 'slip init (1=DOL start)' }, f0: { v: 60, l: 'f0 (Hz)' }
    },
    // 3-ph AC only. QSS phasor model behind a Norton current-source
    // interface (passive convention, like pq/cpl), so plotted P is
    // positive-absorbing with no FLOW_REVERSED entry (SPEC §2).
    terms: [[0, 26], [84, 26]]
  },
  hvdc: {
    w: 96, h: 56, label: 'HVDC',
    params: {
      Pset: { v: 50, l: 'P schedule A→B (kW)' }, Tp: { v: 50, l: 'ramp lag (ms)' },
      VdcRef: { v: 800, l: 'V dc ref (V)' }, Cdc: { v: 20000, l: 'C dc (µF)' },
      kp: { v: 0.5, l: 'kp (kW/V)' }, ki: { v: 20, l: 'ki (kW/V·s)' },
      Prate: { v: 200, l: 'P rating (kW)' }, eff: { v: 0.97, l: 'efficiency' },
      QA: { v: 0, l: 'Q side A (kvar)' }, QB: { v: 0, l: 'Q side B (kvar)' },
      Imax: { v: 200, l: 'I max (A rms/ph)' }, vmin: { v: 50, l: 'UVLO (V rms)' },
      f0: { v: 60, l: 'f0 (Hz)' }
    },
    // term 0 = AC side A (link regulator), term 1 = AC side B (dispatch);
    // shunt injections, ground return (svc convention). 3-ph only.
    terms: [[0, 28], [96, 28]]
  },
  wt4: {
    w: 84, h: 56, label: 'Wind T4',
    params: {
      Prated: { v: 100, l: 'P rated (kW)' }, vrated: { v: 12, l: 'v rated (m/s)' },
      vw: { v: 10, l: 'wind (m/s)' }, vw2: { v: 0, l: 'gust wind (m/s)' },
      tgust: { v: -1, l: 't gust (ms, -1=off)' },
      Q0: { v: 0, l: 'Q dispatch (kvar)' }, Imax: { v: 150, l: 'I max (A rms/ph)' },
      vmin: { v: 50, l: 'UVLO (V rms)' }, f0: { v: 60, l: 'f0 (Hz)' }
    },
    terms: [[0, 28], [84, 28]]
  },
  gfl: {
    w: 84, h: 56, label: 'GFL Solar',
    params: {
      Sbase: { v: 250000, l: 'S rated (kVA, 3ph)' }, Vrated: { v: 400000, l: 'V rated (V rms)' },
      P0: { v: 0, l: 'P set (kW)' }, Q0: { v: 0, l: 'Q set (kvar)' },
      Imax: { v: 1.2, l: 'I limit (pu of rated)' }, Vfloor: { v: 0.5, l: 'V floor (pu, off=0)' },
      Xt: { v: 0.1, l: 'Xt leakage (pu)' }, Emax: { v: 0, l: 'E ceiling (pu, 0=off)' },
      f0: { v: 60, l: 'f0 (Hz)' }, KpPLL: { v: 30, l: 'PLL kp (1/s)' }, KiPLL: { v: 900, l: 'PLL ki (1/s^2)' },
      pfType: { v: 'PV', l: 'PF bus (slack/PV/PQ)', t: 'text' }, Vset: { v: 0, l: 'PF V set (V, 0=Vrated)' },
      Qmax: { v: 0, l: 'PF Q max (kvar, 0/0=none)' }, Qmin: { v: 0, l: 'PF Q min (kvar, 0/0=none)' }
    },
    // 3-ph AC only. Term 0/1 = AC (a Norton current source across them, generator
    // convention / FLOW_REVERSED like wt4). NO series filter branch is stamped: the
    // block is a current-source primitive, which is exactly what avoids the Lf-C
    // resonance that destabilised `gfm` at transmission scale (SPEC section 5 item
    // 33, studies/Spain_Blackout/DIAGNOSTICS.md). The transformer leakage `Xt` is
    // reflected into the current-limiting algebra and the power-flow internal-EMF
    // back-computation, not a real branch.
    terms: [[0, 28], [84, 28]]
  },
  pfc: {
    w: 84, h: 52, label: 'PFC rect',
    params: {
      Vref: { v: 380, l: 'V ref (V)' }, Imax: { v: 40, l: 'I max (A)' },
      kp: { v: 2, l: 'kp (A/V)' }, ki: { v: 2000, l: 'ki (A/V·s)' },
      Vac: { v: 277, l: 'AC nom (V rms)' }, tgrid: { v: -1, l: 'grid lost (ms)' },
      rev: { v: 0, l: 'reverse (0/1)' },
      // only used on a single-phase lateral, where v² ripples at 2f and the
      // peak estimate needs a one-cycle window (SPEC §2). Absent in files
      // saved before this param existed; the element falls back to 60 Hz.
      f: { v: 60, l: 'f (Hz, 1-ph window)' }
    },
    terms: [[0, 26], [84, 26]] // term 0 = AC in (3-ph or 1-ph lateral) / unused in 1-ph mode; term 1 = DC+ out
  },
  batt: {
    w: 84, h: 52, label: 'Batt',
    params: {
      Vref: { v: 360, l: 'V ref (V)' }, Imax: { v: 50, l: 'I max (A)' },
      kp: { v: 2, l: 'kp (A/V)' }, ki: { v: 2000, l: 'ki (A/V·s)' },
      Ah: { v: 0.02, l: 'capacity (Ah)' }, soc0: { v: 100, l: 'SOC init (%)' },
      Ichg: { v: 10, l: 'I charge (A)' }
    },
    terms: [[0, 26], [84, 26]]
  },
  dcdc: {
    w: 84, h: 52, label: 'DC/DC',
    params: {
      mode: { v: 0, l: 'mode (0=CV,1=CC)' },
      Vref: { v: 380, l: 'V ref (V, CV)' }, Imax: { v: 40, l: 'I max (A)' },
      kp: { v: 2, l: 'kp (A/V)' }, ki: { v: 2000, l: 'ki (A/V·s)' },
      I0: { v: 10, l: 'I set (A, CC)' }
    },
    terms: [[0, 26], [84, 26]] // term 0 = IN, term 1 = OUT (regulated side)
  },
  pv: {
    w: 84, h: 52, label: 'PV',
    params: {
      Voc: { v: 45, l: 'Voc (V, STC)' }, Isc: { v: 10, l: 'Isc (A, STC)' },
      Vmpp: { v: 36, l: 'Vmpp (V, STC)' }, Impp: { v: 9.3, l: 'Impp (A, STC)' },
      G: { v: 1000, l: 'irradiance (W/m²)' }, Imax: { v: 15, l: 'I max (A)' },
      Tmppt: { v: 1, l: 'MPPT period (ms)' }, dV: { v: 0.5, l: 'MPPT step (V)' }
    },
    terms: [[0, 26], [84, 26]] // term 0 = return, term 1 = DC+ out
  },
  cpl: {
    w: 76, h: 48, label: 'DC CPL',
    params: { P: { v: 10, l: 'P (kW)' }, vmin: { v: 300, l: 'UVLO (V)' } },
    terms: [[0, 24], [76, 24]]
  },
  fault: {
    w: 60, h: 44, label: 'Fault',
    params: { Rf: { v: 0.05, l: 'R fault (Ω)' }, ton: { v: 60, l: 't on (ms)' }, toff: { v: -1, l: 't off (ms)' }, ph: { v: 0, l: 'phase (0=ABC,1=A,2=B,3=C)' } },
    terms: [[30, 0]]
  },
  tap: {
    w: 64, h: 44, label: 'Phase Tap',
    // term 0 = 3-phase side, term 1 = single-phase lateral (SPEC §2).
    params: {
      ph: { v: 1, l: 'phase (1=A,2=B,3=C)' },
      Rc: { v: 1e-4, l: 'connector R (Ω)' }
    },
    terms: [[0, 22], [64, 22]]
  },
  bus: {
    w: 160, h: 16, label: 'Bus',
    params: { name: { v: '', l: 'Name', t: 'text' }, taps: { v: 1, l: '# taps' }, len: { v: 50, l: 'length' }, Vbase: { v: 0, l: 'V base (0=slack)' },
      Vhi: { v: 0, l: 'V high limit (pu, 0=0.95 default)' }, Vlo: { v: 0, l: 'V low limit (pu, 0=1.05 default)' },
      area: { v: 0, l: 'area (id)' }, zone: { v: 0, l: 'zone (id)' }, owner: { v: 0, l: 'owner (id)' } },
    terms: [] // dynamic — see getTerms(); tap count/spacing come from params
  },
  svc: {
    w: 64, h: 48, label: 'SVC',
    params: {
      mode: { v: 0, l: 'mode (0=SVC,1=STATCOM)' },
      Vref: { v: 277, l: 'V ref (V rms)' }, Xs: { v: 0.5, l: 'droop slope (V/A)' },
      Ki: { v: 200, l: 'Ki (A/V·s)' },
      Bmax: { v: 0.02, l: 'B max cap (S)' }, Bmin: { v: -0.02, l: 'B min ind (S)' },
      Imax: { v: 10, l: 'I max (A rms, STATCOM)' },
      f: { v: 60, l: 'f (Hz)' }
    },
    terms: [[32, 0]]
  },
  scale: {
    w: 84, h: 48, label: 'Scale',
    params: {
      N: { v: 100, l: 'replica count N' },
      Rf: { v: 0.01, l: 'coupling Rf (Ω)' }
    },
    // term 0 = network/facility side, term 1 = reference-unit side (see
    // SPEC §2: N identical replicas represented by one simulated unit).
    terms: [[0, 24], [84, 24]]
  },
  mov: {
    w: 56, h: 44, label: 'Arrester',
    params: { Vc: { v: 450, l: 'clamp knee (V peak)' }, Rd: { v: 5, l: 'Rd slope (Ω)' } },
    terms: [[28, 0]]
  },
  vsw: {
    w: 60, h: 40, label: 'Shunt Ctl',
    params: {
      brkId: { v: 0, l: 'breaker block #' },
      mode: { v: 0, l: 'mode (0=support,1=limit)' },
      Von: { v: 250, l: 'V act (V rms)' }, Voff: { v: 280, l: 'V release (V rms)' },
      Td: { v: 50, l: 'delay (ms)' }, f: { v: 60, l: 'f (Hz, RMS window)' }
    },
    terms: [[30, 40]]
  },
  gtrip: {
    w: 60, h: 40, label: 'Gen Trip',
    params: {
      brkId: { v: 0, l: 'breaker block #' },
      Vov: { v: 0, l: '59 pickup (V rms, 0=off)' },
      Vuv: { v: 0, l: '27 pickup (V rms, 0=off)' },
      Tdv: { v: 100, l: 'V delay (ms)' },
      hysV: { v: 2, l: 'V dropout band (%)' },
      Fov: { v: 0, l: '81O pickup (Hz, 0=off)' },
      Fuv: { v: 0, l: '81U pickup (Hz, 0=off)' },
      Tdf: { v: 300, l: 'f delay (ms)' },
      hysF: { v: 0.05, l: 'f dropout band (Hz)' },
      Vblk: { v: 0, l: '81 V block (V rms, 0=off)' },
      tarm: { v: 0, l: 'arm delay (ms, 0=armed at t=0)' },
      f0: { v: 60, l: 'f0 (Hz)' },
      KpPLL: { v: 30, l: 'PLL kp (1/s)' },
      KiPLL: { v: 900, l: 'PLL ki (1/s^2)' }
    },
    terms: [[30, 40]]
  },
  zrel: {
    w: 74, h: 44, label: 'Dist Relay',
    params: {
      brkId: { v: 0, l: 'breaker block #' },
      Z1: { v: 50, l: 'Z1 reach (Ω)' },
      T1: { v: 0, l: 'Z1 delay (ms)' },
      Z2: { v: 100, l: 'Z2 reach (Ω)' },
      T2: { v: 300, l: 'Z2 delay (ms)' },
      Z3: { v: 200, l: 'Z3 reach (Ω)' },
      T3: { v: 600, l: 'Z3 delay (ms)' },
      theta: { v: 80, l: 'char angle (deg)' },
      mode: { v: 'mho', l: 'mode (mho/imp)', t: 'text' },
      Imin: { v: 0, l: 'min current (A, 0=off)' },
      tarm: { v: 0, l: 'arming delay (ms)' },
      oos: { v: 0, l: 'OOS trip (0=off,1=way out,2=way in)' },
      RB1: { v: 0, l: 'OOS inner blinder (Ω)' },
      RB2: { v: 0, l: 'OOS outer blinder (Ω)' },
      Tsw: { v: 50, l: 'OOS swing time (ms)' },
      f: { v: 60, l: 'f (Hz, RMS window)' }
    },
    terms: [[0, 22], [74, 22]]
  },
  gnd: { w: 44, h: 36, label: 'GND', params: {}, terms: [[22, 0]] },
  probe: { w: 52, h: 36, label: 'V probe', params: {}, terms: [[26, 36]] }
};

// Terminal offsets for one block INSTANCE. Static for every type except
// 'bus', whose tap count and length are user-editable params — taps are
// evenly spaced along the centerline of its w x h bounding box. A bus
// contributes no branch (see makeElements); its many terminals are unioned
// into a single electrical node in buildNodes (solver.js, SPEC section 1),
// so "many things share a node" becomes "many things touch one bus bar"
// instead of a tangle of wires converging on an invisible point.
function getTerms(b) {
  if (b.type !== 'bus') return DEFS[b.type].terms;
  const n = Math.max(1, Math.round(b.params.taps || 1));
  const len = Math.max(40, b.params.len || 50);
  const midY = DEFS.bus.h / 2;
  const terms = [];
  for (let i = 0; i < n; i++) terms.push([len * (i + 0.5) / n, midY]);
  return terms;
}

// Build solver elements for one phase (p = 0..nph-1). Each element:
//   n1, n2   node indices (-1 = ground)
//   G        conductance stamped into the matrix (brk uses closed flag instead)
//   inject(I, t, phi)   add source/history currents to RHS (optional)
//   update(vb, t, phi)  post-solve: record current, advance state
// Lines with mutual coupling are handled by makeCoupledLines in 3-ph mode
// and are skipped here; a fault with a phase selector only exists in its phase.
function isCoupled(b) { return b.type === 'line' && ((b.params.Rm || 0) !== 0 || (b.params.Lm || 0) !== 0); }
function isPiLine(b) { return b.type === 'line' && +(b.params.C || 0) > 0; }

// Voltage-convention boundary helper (SPEC §2). Circuit-level `S.vconv` selects
// how AC source/bus voltage params are entered: 'ph' (phase RMS, legacy) or
// 'll' (line-to-line RMS). The solver is per-phase internally, so an LL value
// is divided by sqrt(3) to recover the per-phase quantity — but only in 3-ph
// (in 1-ph the line voltage IS the phase voltage, so no factor). Absent/other
// `S.vconv` reads as 'ph', which is why every legacy file and test stays
// byte-identical and unchanged. DC voltages, peak clamps, and currents are not
// run through this (LL is a 3-ph AC concept); only the params listed in SPEC.
function vPh(v, nph) { return (S.vconv === 'll' && nph === 3) ? v / Math.sqrt(3) : v; }

// Polarity of a source block's EMF against the power-flow bus it was solved at
// (SPEC §2 "Passive-history initialization from the power flow").
//
// Source blocks (src, syncgen, gfm) inject with TERMINAL 0 as the + node:
// `I[n1] += ...; I[n2] -= ...` with n1 = terminal 0. But solvePowerFlow()'s
// `genBus` takes TERMINAL 1 as the machine's network bus whenever it isn't
// grounded, which is the normal wiring (terminal 0 to ground, terminal 1 to the
// network). In that wiring the network therefore sees −EMF: the EMT solution
// comes out 180° from the power flow it was initialized from. Harmless while
// only machines were initialized (one global sign flip is not observable in a
// swing equation, and every source in a circuit flips together), but fatal once
// PASSIVE histories are seeded from the PF phasors — the seed would be exactly
// anti-phase with the sources driving it, which is the worst possible start.
//
// So under PF init the EMF is driven as −E' in that wiring, and the EMT run
// reproduces its own power flow, sign included. Reversed wiring (terminal 1
// grounded) already agreed and returns +1. Verified empirically both ways
// before the seeder was written. COLD STARTS NEVER CALL THIS, so every
// pre-feature run is bit-identical.
function pfPolarity(topo, b) { return topo.nid(b, 1) >= 0 ? -1 : 1; }

// Seed hook body shared by the plain series-RL family (line, xfmr): the
// history pair is the branch voltage and current one step BEFORE the first
// solve. `a` is the transformer ratio (1 for a line), matching the solver's own
// vb = v(n1) − a·v(n2). Returns false to mean "power flow didn't reach both
// terminals, keep the cold start" (SPEC §2).
function seedRL(el, c, ph, R, Lh, a) {
  const Vb = c.vbr(el.b, ph, a);
  if (!Vb) return false;
  el.v = c.inst(Vb, c.t0);
  el.i = c.inst(c.mul(c.yRL(R, Lh), Vb), c.t0);
  return true;
}

// Transformer winding ratio from per-side line-line nameplate voltages. The
// solver's internal `a` is the winding turns ratio N1/N2; a winding's line-line
// terminal voltage is k * V_winding with k = sqrt(3) for a wye side, 1 for a
// delta side, so a = (V1/V2) * (k2/k1). For the per-phase / 1-ph xfmr block the
// terminal voltage IS the winding voltage (no connection), so a = V1/V2. Falls
// back to the legacy `a`/`a2`/`a3` param when V1/V2(/V3) are absent, so older
// saved files still load unchanged. Shared by the transient companion, the
// power-flow stamp, and the UI science panels so the derived a never drifts.
function xfmrK(side) { return side && side.t === 'Y' ? Math.sqrt(3) : 1; }
function xfmrA(p, kind) {
  if (kind === 'xfmr')
    return (+p.V1 && +p.V2) ? +p.V1 / +p.V2 : +p.a;
  if (kind === 'xfmr3') {
    const c = xfmr3Conn(p);
    return (+p.V1 && +p.V2) ? (+p.V1 / +p.V2) * (xfmrK(c.s) / xfmrK(c.p)) : +p.a;
  }
  // xfmr3w: returns [a2, a3]; primary is always Y per xfmr3wConn.
  const s = xfmr3wConn(p), k1 = xfmrK(s[0]);
  const a2 = (+p.V1 && +p.V2) ? (+p.V1 / +p.V2) * (xfmrK(s[1]) / k1) : +p.a2;
  const a3 = (+p.V1 && +p.V3) ? (+p.V1 / +p.V3) * (xfmrK(s[2]) / k1) : +p.a3;
  return [a2, a3];
}

// Find a transformer whose derived ratio is not a finite positive number (a
// 0/absent winding voltage with no legacy `a` fallback — e.g. a V2 typo'd to
// 0). Left unguarded this puts NaN in the matrix, which buildLU's singularity
// test cannot see (Math.abs(NaN) < eps is false), so the whole run would
// silently output NaN (July 2026 solver review). Shared by simulate() and
// solvePowerFlow(); returns the offending block or null.
function xfmrRatioBad() {
  const ok = a => isFinite(a) && a > 0;
  return S.blocks.find(b => {
    if (b.type === 'xfmr' || b.type === 'xfmr3') return !ok(xfmrA(b.params, b.type));
    if (b.type === 'xfmr3w') { const [a2, a3] = xfmrA(b.params, 'xfmr3w'); return !ok(a2) || !ok(a3); }
    return false;
  }) || null;
}

function makeElements(topo, dt, p, nph) {
  const arr = [];
  S.blocks.forEach(b => {
    if (b.type === 'gfm' || b.type === 'pfc') return; // spanning: see makeSpanning
    const dcb = topo.isDC(b);
    if (dcb && p > 0) return; // DC-side elements exist once, not per phase
    // Single-phase lateral (SPEC §2 "Phase tap"): the block lives on ONE phase,
    // so it is instantiated once, on that phase — same shape as the DC rule
    // above and as `fault`'s own phase selector below. bph is -1 (all phases)
    // for every block on an ordinary 3-phase node, so nothing else changes.
    const bph = topo.blockPh(b);
    if (bph >= 0 && p !== bph) return;
    // A lateral is a genuine phase-to-neutral connection, so its voltage
    // parameters are phase quantities even when the circuit is entered in
    // line-to-line convention — vPh must not apply the √3 here (see §2).
    const nphB = bph >= 0 ? 1 : nph;
    if (nph === 3 && isCoupled(b) && !dcb) return; // spanning coupled line
    if (isPiLine(b)) return; // spanning PI (RLC) line — see makePiLines
    if (b.type === 'fault' && !dcb && +(b.params.ph || 0) !== 0 && +b.params.ph - 1 !== p) return;
    const n1 = topo.gIdx(b, 0, p), n2 = getTerms(b).length > 1 ? topo.gIdx(b, 1, p) : -1;

    if (b.type === 'src') {
      const G = 1 / b.params.Rs;
      // Power-flow init (SPEC §2 "Passive-history initialization"): `src` is a
      // THEVENIN source — it drives Vrms behind Rs, so its terminal is not
      // Vrms∠0, while the power flow pins its bus AT Vset and (at a non-slack
      // bus) at a solved angle that is not 0 at all. pfResult already
      // back-computes this block's Thevenin EMF E' = V + Rs·I into pfInit
      // (`gens` includes src, with Ra = Rs and no internal L), so driving E'∠th
      // at the solved polarity makes the EMT terminal land exactly on the PF
      // bus voltage — the same treatment syncgen has had since §5 item 10, for
      // the one source block that was left out of it. No pfInit (cold start) =
      // the original Vrms∠0 behaviour, bit-identical.
      const pi = b.pfInit;
      const sgn = pi ? pfPolarity(topo, b) : 1;
      const Vph = pi ? sgn * pi.E : vPh(b.params.Vrms, nphB);
      const th0 = pi ? pi.th : 0;
      const vs = (t, phi) => Vph * Math.SQRT2 * Math.sin(2 * Math.PI * b.params.f * t + phi + th0);
      arr.push({
        b, n1, n2, G, kind: 'src', cur: 0,
        inject(I, t, phi) {
          const v = vs(t, phi);
          if (n1 >= 0) I[n1] += v * G;
          if (n2 >= 0) I[n2] -= v * G;
        },
        update(vb, t, phi) { this.cur = (vs(t, phi) - vb) * G; }
      });
    }

    if (b.type === 'line') {
      const Lh = b.params.L * 1e-3;
      const Req = b.params.R + 2 * Lh / dt;
      const k2 = b.params.R - 2 * Lh / dt, kL = 2 * Lh / dt;
      arr.push({
        b, n1, n2, G: 1 / Req, kind: 'line', i: 0, v: 0, cur: 0,
        seed(c, ph) { return seedRL(this, c, ph, b.params.R, Lh, 1); },
        // be = backward-Euler half-step history (CDA, SPEC section 2)
        ihf(be) { return (be ? this.i * kL : this.v - this.i * k2) * this.G; },
        inject(I, t, phi, be) {
          const Ih = this.ihf(be);
          if (n1 >= 0) I[n1] -= Ih;
          if (n2 >= 0) I[n2] += Ih;
        },
        update(vb, t, phi, be) {
          this.i = vb * this.G + this.ihf(be);
          this.v = vb;
          this.cur = this.i;
        }
      });
    }

    if (b.type === 'cap') {
      // SPEC section 2: G = 2C/dt, i_n = G·v_n − [G·v_{n−1} + i_{n−1}]
      const G = 2 * (b.params.C * 1e-6) / dt;
      arr.push({
        b, n1, n2, G, kind: 'cap', i: 0, v: 0, cur: 0,
        // SPEC §2 "Passive-history initialization": I = jωC·V, both at t = −Δt.
        seed(c, ph) {
          const Vb = c.vbr(b, ph, 1);
          if (!Vb) return false;
          this.v = c.inst(Vb, c.t0);
          this.i = c.inst(c.mul({ re: 0, im: c.w * (b.params.C * 1e-6) }, Vb), c.t0);
          return true;
        },
        ihf(be) { return be ? -this.v * this.G : -(this.v * this.G + this.i); },
        inject(I, t, phi, be) {
          const Ih = this.ihf(be);
          if (n1 >= 0) I[n1] -= Ih;
          if (n2 >= 0) I[n2] += Ih;
        },
        update(vb, t, phi, be) {
          this.i = vb * this.G + this.ihf(be);
          this.v = vb;
          this.cur = this.i;
        }
      });
    }

    if (b.type === 'rlc') {
      // SPEC section 2 (Series RLC, July 2026): -1 drops that component from
      // the series chain. R/-1 aliases to 0 (already 'no resistor', a wire);
      // L/-1 aliases to 0 (already 'no inductor', a wire); C/-1 drops the
      // dt/(2C) term to 0 (as if C→∞, a wire) — NOT the same as C=0, which
      // would blow the term up (open circuit, the opposite of absent).
      const Rc = b.params.R < 0 ? 0 : b.params.R;
      const Lh = b.params.L < 0 ? 0 : b.params.L * 1e-3;
      const hasC = b.params.C >= 0;
      const Cterm = hasC ? dt / (2 * b.params.C * 1e-6) : 0;
      const kL = 2 * Lh / dt;
      let Req = Rc + kL + Cterm;
      if (Req <= 0) Req = 1e-6; // R,L,C all absent: numerically-forced short
      const G = 1 / Req;
      const k = Rc - kL + Cterm;
      arr.push({
        b, n1, n2, G, kind: 'rlc', i: 0, v: 0, vC: 0, cur: 0,
        // SPEC §2 "Passive-history initialization": Z = R + jωL + 1/(jωC), with
        // an absent component dropping out of Z exactly as it drops out of the
        // companion above. `vC` carries the SAME time index as v and i (derived
        // in SPEC §2) — it looks half a step off because update() writes it
        // after i, but it is not.
        seed(c, ph) {
          const Vb = c.vbr(b, ph, 1);
          if (!Vb) return false;
          const xC = hasC ? -1 / (c.w * b.params.C * 1e-6) : 0; // Im{1/(jωC)}
          const Z = { re: Rc, im: c.w * Lh + xC };
          if (Z.re === 0 && Z.im === 0) Z.re = 1e-6; // R,L,C all absent: same forced short as Req
          const Ib = c.div(Vb, Z);
          this.v = c.inst(Vb, c.t0);
          this.i = c.inst(Ib, c.t0);
          this.vC = hasC ? c.inst(c.mul(Ib, { re: 0, im: xC }), c.t0) : 0;
          return true;
        },
        // be = backward-Euler half-step history (CDA, SPEC section 2)
        ihf(be) { return (be ? this.i * kL - this.vC : this.v - this.i * k - 2 * this.vC) * this.G; },
        inject(I, t, phi, be) {
          const Ih = this.ihf(be);
          if (n1 >= 0) I[n1] -= Ih;
          if (n2 >= 0) I[n2] += Ih;
        },
        update(vb, t, phi, be) {
          const Ih = this.ihf(be);
          const iNew = vb * this.G + Ih;
          if (hasC) this.vC += Cterm * (iNew + this.i);
          this.i = iNew;
          this.v = vb;
          this.cur = this.i;
        }
      });
    }

    if (b.type === 'rlcp') {
      // SPEC section 2 (Parallel RLC, July 2026): -1 drops that component.
      // Sentinel convention is INVERSE of rlc's: R=-1 and L=-1 mean absent
      // (open, G contribution 0) — 0 means a real short for both. C accepts
      // -1 or 0 (both give GC=0 naturally). No Req floor guard needed for the
      // all-absent case: G=0 is a genuine open branch. R/L are floored
      // (1e-6 Ω / 1e-9 H, mirroring rlc's Req floor) so a 0-value short is a
      // large finite conductance — a literal 1/0 = Infinity stamp NaNs the LU
      // whenever the branch sits between two live nodes (July 2026 review).
      const hasR = b.params.R >= 0;
      const hasL = b.params.L >= 0;
      const hasC = b.params.C >= 0;
      const GR = hasR ? 1 / Math.max(b.params.R, 1e-6) : 0;
      const GL = hasL ? dt / (2 * Math.max(b.params.L * 1e-3, 1e-9)) : 0;
      const GC = hasC ? 2 * (b.params.C * 1e-6) / dt : 0;
      const G = GR + GL + GC; // total conductance: sum of independent admittances
      arr.push({
        b, n1, n2, G, kind: 'rlcp', iL: 0, iC: 0, v: 0, cur: 0,
        // SPEC §2 "Passive-history initialization": the parallel splits
        // I_L = V/(jωL) and I_C = V·jωC, both at t = −Δt. The resistor branch is
        // algebraic and keeps no register. L is read through the same 1e-9 floor
        // the companion's GL uses, so seed and companion cannot disagree.
        seed(c, ph) {
          const Vb = c.vbr(b, ph, 1);
          if (!Vb) return false;
          this.v = c.inst(Vb, c.t0);
          this.iL = hasL ? c.inst(c.div(Vb, { re: 0, im: c.w * Math.max(b.params.L * 1e-3, 1e-9) }), c.t0) : 0;
          this.iC = hasC ? c.inst(c.mul(Vb, { re: 0, im: c.w * (b.params.C * 1e-6) }), c.t0) : 0;
          return true;
        },
        // be = backward-Euler half-step history (CDA, SPEC section 2)
        ihf(be) {
          const IhL = hasL ? (be ? this.iL : this.iL + GL * this.v) : 0;
          const IhC = hasC ? (be ? -this.v * GC : -(this.v * GC + this.iC)) : 0;
          return IhL + IhC;
        },
        inject(I, t, phi, be) {
          const Ih = this.ihf(be);
          if (n1 >= 0) I[n1] -= Ih;
          if (n2 >= 0) I[n2] += Ih;
        },
        update(vb, t, phi, be) {
          const Ih = this.ihf(be);
          if (hasL) this.iL = vb * GL + (be ? this.iL : this.iL + GL * this.v);
          if (hasC) this.iC = vb * GC + (be ? -this.v * GC : -(this.v * GC + this.iC));
          this.v = vb;
          this.cur = vb * G + Ih; // total branch current
        }
      });
    }

    if (b.type === 'xfmr' && +(b.params.Lm || 0) > 0) return; // saturable variant is spanning — see makeSatXfmrs
    if (b.type === 'xfmr') {
      // SPEC section 2: ideal a:1 + primary-referred RL leakage, grounded two-port.
      // Same companion as 'line' on vb = v1 − a·v2; node-2 injection scaled by a.
      const Lh = b.params.L * 1e-3;
      const Req = b.params.R + 2 * Lh / dt;
      const k2 = b.params.R - 2 * Lh / dt, kL = 2 * Lh / dt;
      const a = xfmrA(b.params, 'xfmr');
      arr.push({
        b, n1, n2, G: 1 / Req, a, kind: 'xfmr', i: 0, v: 0, cur: 0,
        // Same RL seed as `line`, on the RATIO-WEIGHTED branch voltage
        // v1 − a·v2 the companion itself uses (SPEC §2).
        seed(c, ph) { return seedRL(this, c, ph, b.params.R, Lh, a); },
        ihf(be) { return (be ? this.i * kL : this.v - this.i * k2) * this.G; },
        inject(I, t, phi, be) {
          const Ih = this.ihf(be);
          if (n1 >= 0) I[n1] -= Ih;
          if (n2 >= 0) I[n2] += a * Ih;
        },
        update(vb, t, phi, be) {
          this.i = vb * this.G + this.ihf(be); // primary current; secondary = a·i
          this.v = vb;
          this.cur = this.i;
        }
      });
    }

    // Battery DC/DC AVM (SPEC section 2): controlled Norton current source,
    // PI voltage loop + SOC-gated bidirectional current limit. No G stamp —
    // the DC bus cap carries G. One PI, two clamp bounds: bus above Vref
    // drives raw negative → CC charge at Ichg (until SOC hits 100, when the
    // floor rises to 0 — no chatter, err stays negative and icmd pins at 0);
    // bus sagging to Vref → discharge PI exactly as the old backup model
    // (until SOC hits 0, when the ceiling drops to 0 and the bus collapses).
    // soc0 = 100 (default) therefore reproduces the old discharge-only idle.
    if (b.type === 'batt') {
      const P = b.params;
      // polarity convention: terminal 1 (right) = DC+ output, terminal 0 = return.
      // vb = v(n1) − v(n2), so output voltage = −vb; inject into n2.
      arr.push({
        b, n1, n2, G: 0, kind: 'batt', cur: 0, integ: 0, icmd: 0,
        soc: Math.max(0, Math.min(100, +(P.soc0 ?? 100))),
        inject(I) {
          if (n2 >= 0) I[n2] += this.icmd;
          if (n1 >= 0) I[n1] -= this.icmd;
        },
        update(vb, t, phi, be) {
          const h = be ? dt / 2 : dt;
          const err = P.Vref - (-vb);
          this.integ += P.ki * h * err;
          const raw = P.kp * err + this.integ;
          const hi = this.soc > 0 ? P.Imax : 0;          // empty → can't source
          const lo = this.soc < 100 ? -(P.Ichg || 0) : 0; // full → can't absorb
          this.icmd = Math.max(lo, Math.min(hi, raw));
          this.integ += this.icmd - raw; // anti-windup back-calculation
          this.cur = this.icmd;
          // SOC integration: icmd > 0 discharges. %-units: Ah·3600 A·s per
          // 100 % ⇒ d(soc)/dt = −icmd/(36·Ah) %/s.
          if (P.Ah > 0) this.soc = Math.max(0, Math.min(100, this.soc - this.icmd * h / (36 * P.Ah)));
        }
      });
    }

    // PV array with embedded MPPT AVM (SPEC section 2): single-exponential
    // I-V curve (fit to the datasheet Voc/Isc/Vmpp/Impp), driven by a real
    // Perturb & Observe search on its own internal operating voltage `vop`
    // (fully decoupled from the actual bus voltage — that decoupling is what
    // the embedded converter is for). Generation-only Norton source (floor
    // of 0 — a panel can't absorb power), same 1 ms LPF stabilization as
    // CPL/dcdc's derived-current ports (identical negative-incremental-
    // conductance shape: injected current is P/v with P roughly fixed).
    if (b.type === 'pv') {
      const P = b.params;
      const curveI = V => {
        const Voc = P.Voc, Isc = P.Isc, Vmpp = P.Vmpp, Impp = P.Impp;
        if (Voc <= 0 || Isc <= 0) return 0;
        const IscG = Isc * (P.G / 1000);
        const ratio = Math.min(0.999, Impp / Isc);
        const C2 = (Vmpp / Voc - 1) / Math.log(Math.max(1e-9, 1 - ratio));
        const C1 = (1 - ratio) * Math.exp(-Vmpp / (C2 * Voc));
        const I = IscG * (1 - C1 * (Math.exp(V / (C2 * Voc)) - 1));
        return Math.max(0, Math.min(IscG, I));
      };
      arr.push({
        b, n1, n2, G: 0, kind: 'pv', cur: 0, icmd: 0,
        vop: 0.8 * P.Voc, dv: P.dV, Pprev: 0, tAcc: 0,
        inject(I) {
          if (n2 >= 0) I[n2] += this.icmd;
          if (n1 >= 0) I[n1] -= this.icmd;
        },
        update(vb, t, phi, be) {
          const h = be ? dt / 2 : dt;
          const vbus = -vb;
          this.tAcc += h;
          const Tmppt = Math.max(0.1, P.Tmppt) * 1e-3;
          if (this.tAcc >= Tmppt) { // P&O runs on its own slower clock (SPEC §2)
            this.tAcc -= Tmppt;
            const Pnow = this.vop * curveI(this.vop);
            if (Pnow < this.Pprev) this.dv = -this.dv; // power dropped -> reverse
            this.vop = Math.max(0, Math.min(P.Voc, this.vop + this.dv));
            this.Pprev = Pnow;
          }
          const Ppv = this.vop * curveI(this.vop);
          const target = Math.max(0, Math.min(P.Imax, Ppv / (vbus || 1e-6)));
          this.icmd += Math.min(1, h / 1e-3) * (target - this.icmd); // 1 ms LPF
          this.cur = this.icmd;
        }
      });
    }

    if (b.type === 'cpl') {
      arr.push({
        b, n1, n2, G: 0, kind: 'cpl', cur: 0, icmd: 0,
        inject(I) {
          if (n1 >= 0) I[n1] -= this.icmd;
          if (n2 >= 0) I[n2] += this.icmd;
        },
        update(vb, t, phi, be) {
          const h = be ? dt / 2 : dt;
          const tgt = vb > b.params.vmin ? b.params.P * 1000 / vb : 0; // UVLO
          this.icmd += Math.min(1, h / 1e-3) * (tgt - this.icmd); // 1 ms LPF
          this.cur = this.icmd;
        }
      });
    }

    // PQ load AVM (SPEC section 2): constant real+reactive power, the
    // standard power-flow load model — extends CPL's "adjust current to
    // hold P constant" idea to AC. A naive P/v(t) blows up at v(t)'s zero
    // crossings (CPL avoids this only because it's DC), so both P and Q are
    // normalized against a filtered Vrms², not the instantaneous voltage.
    // Q needs a CAUSAL 90°-shifted reference; a quarter-PERIOD-delayed
    // voltage sample IS that reference (derivation in SPEC) and is robust
    // through the sharp transients this tool specializes in, unlike a
    // numerical-derivative quadrature generator which would spike right
    // when a fault/breaker event matters most.
    if (b.type === 'pq') {
      const P = b.params;
      const N = Math.max(1, Math.round(1 / (4 * Math.max(1, P.f)) / dt)); // quarter-period buffer
      const Tf = Math.max(P.Tf, 0.1) * 1e-3;
      // P/Q are the block's TOTAL power (SPEC §2 "Power convention"), so the
      // per-phase share each companion injects is P/nphB. Until July 2026 the
      // full P went into EVERY phase, making a 3-phase pq draw 3x its label
      // while solvePowerFlow() (a 3-phase-total solve) read it at face value —
      // a silent 3x disagreement between the two solvers. nphB is 1 on a
      // lateral or in 1-ph mode, where the block's total IS its one phase.
      const Pph = P.P * 1000 / nphB, Qph = P.Q * 1000 / nphB;
      arr.push({
        b, n1, n2, G: 0, kind: 'pq', cur: 0, icmd: 0, v2f: 0,
        vbuf: new Float64Array(N), bufIdx: 0,
        // SPEC §2 "Passive-history initialization": pq/zip are shunt current
        // sources, not SEED_REQUIRED, but starting their measurement state at
        // zero still mis-measures for a full Tf. v2f is a DISCRETE recursion,
        // v2f[n+1] = (1−a)·v2f[n] + a·v²(t_{n+1}), a = Δt/Tf — the continuous
        // RC steady state is only an O(Δt/Tf) approximation of its true fixed
        // point (~0.25% at the default Tf=20ms, too coarse for this pass), so
        // this seeds the EXACT discrete one. v²(t) = Vrms² − Vrms²·cos(Ωt+θ),
        // Ω = 2ω, θ = 2φ: a DC term (unit discrete gain, same as continuous)
        // plus a tone at Ω sampled every Δt, i.e. forced by z = e^{jΩΔt} each
        // step. Solving v2f(t) = Vrms² + Re{Y·e^{jΩt}} against the recursion
        // (matching the e^{jΩt} coefficient one step apart) gives
        //   Y = a·U1·z / (z − (1−a)),   U1 = −Vrms²·e^{jθ}
        // vbuf is a plain ring of raw v(t) samples spaced dt apart; the same
        // indexing the solver's context comment prescribes fills slot j with
        // the sample the PF implies at t = −(N−j)·Δt, which is exactly what N
        // real update() calls starting from t = 0 would have written into it.
        // icmd itself is seeded from v(t0) and v(t0 − N·Δt) (one buffer-length
        // before t0, i.e. one more step back than vbuf[0]) through the same
        // v2f/UVLO logic update() uses, so inject() at k=0 sees exactly what a
        // long-running steady state would hand it.
        seed(c, ph) {
          const Vb = c.vbr(b, ph, 1);
          if (!Vb) return false;
          const Vrms2 = Vb.re * Vb.re + Vb.im * Vb.im;
          const phi = Math.atan2(Vb.im, Vb.re);
          const Om = 2 * c.w, a = c.dt / Tf, theta = 2 * phi;
          const U1 = { re: -Vrms2 * Math.cos(theta), im: -Vrms2 * Math.sin(theta) };
          const z = { re: Math.cos(Om * c.dt), im: Math.sin(Om * c.dt) };
          const Y = c.div(c.scale(c.mul(U1, z), a), c.sub(z, { re: 1 - a, im: 0 }));
          const eIWt0 = { re: Math.cos(Om * c.t0), im: Math.sin(Om * c.t0) };
          this.v2f = Vrms2 + c.mul(Y, eIWt0).re;
          for (let j = 0; j < N; j++) this.vbuf[j] = c.inst(Vb, -(N - j) * c.dt);
          this.bufIdx = 0;
          const vT0 = c.inst(Vb, c.t0), vQuadT0 = c.inst(Vb, c.t0 - N * c.dt);
          const v2 = Math.max(this.v2f, 1e-6);
          const ok = Math.sqrt(v2) > vPh(P.vmin, nphB);
          this.icmd = ok ? (Pph * vT0 + Qph * vQuadT0) / v2 : 0;
          this.cur = this.icmd;
          return true;
        },
        inject(I) {
          if (n1 >= 0) I[n1] -= this.icmd;
          if (n2 >= 0) I[n2] += this.icmd;
        },
        update(vb, t, phi, be) {
          const h = be ? dt / 2 : dt;
          this.v2f += h * (vb * vb - this.v2f) / Tf;
          const vQuad = this.vbuf[this.bufIdx]; // v(t - T/4), read before overwrite
          this.vbuf[this.bufIdx] = vb;
          this.bufIdx = (this.bufIdx + 1) % N;
          const v2 = Math.max(this.v2f, 1e-6);
          const ok = Math.sqrt(v2) > vPh(P.vmin, nphB); // UVLO on the tracked RMS, not instantaneous vb
          this.icmd = ok ? (Pph * vb + Qph * vQuad) / v2 : 0;
          this.cur = this.icmd;
        }
      });
    }

    // ZIP composite load (SPEC section 2): pq's machinery (Tf-filtered
    // Vrms² tracker, quarter-period reactive reference, UVLO on tracked
    // RMS) with per-part normalization — fixed V0² for the constant-Z part,
    // V0·Vrms for constant-I, Vrms² for constant-P. Coefficient triples are
    // normalized to sum 1 here (an all-zero triple falls back to pure Z).
    // UVLO sheds only the I and P parts; the Z part rides through
    // (SPEC section 2).
    //
    // The Z part is STAMPED; only I and P are injected (2026-07-27). Until
    // then all three went out through pq's G = 0 Norton injection. For I and P
    // that is right — their currents depend on the tracked RMS, so there is no
    // fixed admittance to put in the matrix. The Z part is not like them:
    // az·P0/V0² IS a plain conductance and bz·Q0/V0² IS a plain susceptance,
    // both constant and both known here at build time. Injecting a fixed
    // admittance off the PREVIOUS step's voltage is an explicit feedback loop
    // of gain G_z/G_node, and it diverges as soon as the load's conductance
    // passes the node's own companion conductance. Measured on the Spain study
    // before this change: the run blew up after the same ~4 STEPS at every
    // timestep from 20 us to 1 ms, which is the fingerprint of a numerical
    // loop and not of a physical instability (a physical one has a time
    // constant in seconds and blows up at the same ABSOLUTE time whatever the
    // timestep). az = 0.1 was enough to do it. Stamped, the Z part is an
    // ordinary passive element and cannot misbehave at any dt or load size.
    if (b.type === 'zip') {
      const P = b.params;
      const norm = (z, i, pp) => { const s = z + i + pp; return s > 0 ? [z / s, i / s, pp / s] : [1, 0, 0]; };
      const [az, ai, ap] = norm(+P.az, +P.ai, +P.ap);
      const [bz, bi, bp] = norm(+P.bz, +P.bi, +P.bp);
      const V0ph = vPh(P.V0, nphB); // LL->per-phase at the boundary (V0 is a nominal reference, like a source voltage)
      const V02 = V0ph * V0ph;
      const N = Math.max(1, Math.round(1 / (4 * Math.max(1, P.f)) / dt)); // quarter-period buffer
      const Tf = Math.max(P.Tf, 0.1) * 1e-3;
      const Pph = P.P * 1000 / nphB, Qph = P.Q * 1000 / nphB; // total -> per phase, as pq
      // ---- the stamped constant-impedance part ----------------------------
      // Both are SIGNED: a negative P0 or Q0 (an embedded generator entered as
      // a load) gives a negative conductance or a capacitive susceptance,
      // which is what the polynomial says. The matrix does not require
      // passivity of an entry, only that it be constant.
      const wz = 2 * Math.PI * Math.max(1, P.f);
      const Gz = az * Pph / V02;   // S, constant conductance
      const Bz = bz * Qph / V02;   // S, constant susceptance (+ = absorbing = inductive)
      // Susceptance companion at the block's own nominal frequency: absorbing
      // (Bz > 0) is an inductor L = 1/(ω·Bz), injecting (Bz < 0) a capacitor
      // C = |Bz|/ω. Same trapezoidal companions rlcp uses, so the Z part now
      // carries history state where before it carried none. Bz = 0 means the
      // branch is simply absent, as it should be.
      const indz = Bz > 0, capz = Bz < 0;
      const GLz = indz ? dt * wz * Bz / 2 : 0;      // = dt/(2L)
      const GCz = capz ? 2 * (-Bz / wz) / dt : 0;   // = 2C/dt
      arr.push({
        b, n1, n2, G: Gz + GLz + GCz, kind: 'zip', cur: 0, icmd: 0, v2f: 0,
        iLz: 0, iCz: 0, vz: 0,
        vbuf: new Float64Array(N), bufIdx: 0,
        // SPEC §2 "Measurement-window pre-fill": same v2f/vbuf machinery as
        // pq (exact discrete steady state, quarter-period ring), just fed
        // through the Z/I/P-normalized current law instead of pq's plain one.
        seed(c, ph) {
          const Vb = c.vbr(b, ph, 1);
          if (!Vb) return false;
          const Vrms2 = Vb.re * Vb.re + Vb.im * Vb.im;
          const phi0 = Math.atan2(Vb.im, Vb.re);
          const Om = 2 * c.w, a = c.dt / Tf, theta = 2 * phi0;
          const U1 = { re: -Vrms2 * Math.cos(theta), im: -Vrms2 * Math.sin(theta) };
          const z = { re: Math.cos(Om * c.dt), im: Math.sin(Om * c.dt) };
          const Y = c.div(c.scale(c.mul(U1, z), a), c.sub(z, { re: 1 - a, im: 0 }));
          const eIWt0 = { re: Math.cos(Om * c.t0), im: Math.sin(Om * c.t0) };
          this.v2f = Vrms2 + c.mul(Y, eIWt0).re;
          for (let j = 0; j < N; j++) this.vbuf[j] = c.inst(Vb, -(N - j) * c.dt);
          this.bufIdx = 0;
          const vT0 = c.inst(Vb, c.t0), vQuadT0 = c.inst(Vb, c.t0 - N * c.dt);
          const v2 = Math.max(this.v2f, 1e-6);
          const ok = Math.sqrt(v2) > vPh(P.vmin, nphB);
          const Pk = Pph, Qk = Qph;
          // Z part is stamped now, so it is NOT in icmd. Its companion history
          // seeds the same way rlcp's does: I_L = V/(jωL) = V·(−j·Bz) and
          // I_C = V·jωC = V·(−j·Bz) as well, since Bz already carries the sign
          // (absorbing positive). One expression covers both branches.
          this.vz = vT0;
          this.iLz = indz ? c.inst(c.mul(Vb, { re: 0, im: -Bz }), c.t0) : 0;
          this.iCz = capz ? c.inst(c.mul(Vb, { re: 0, im: -Bz }), c.t0) : 0;
          let i = 0;
          if (ok) {
            i += (ai * Pk * vT0 + bi * Qk * vQuadT0) / (V0ph * Math.sqrt(v2))
              + (ap * Pk * vT0 + bp * Qk * vQuadT0) / v2;
          }
          this.icmd = i;
          this.cur = this.icmd + Gz * vT0 + this.iLz + this.iCz;
          return true;
        },
        // History current of the stamped susceptance, sign-matched to the
        // Norton injection below (positive = drawn from n1). be = backward-
        // Euler half-step (CDA, SPEC §2), same convention as rlcp.
        ihz(be) {
          const IhL = indz ? (be ? this.iLz : this.iLz + GLz * this.vz) : 0;
          const IhC = capz ? (be ? -this.vz * GCz : -(this.vz * GCz + this.iCz)) : 0;
          return IhL + IhC;
        },
        inject(I, t, phi, be) {
          const Ih = this.icmd + this.ihz(be);
          if (n1 >= 0) I[n1] -= Ih;
          if (n2 >= 0) I[n2] += Ih;
        },
        update(vb, t, phi, be) {
          const h = be ? dt / 2 : dt;
          this.v2f += h * (vb * vb - this.v2f) / Tf;
          const vQuad = this.vbuf[this.bufIdx]; // v(t - T/4), read before overwrite
          this.vbuf[this.bufIdx] = vb;
          this.bufIdx = (this.bufIdx + 1) % N;
          const v2 = Math.max(this.v2f, 1e-6);
          const ok = Math.sqrt(v2) > vPh(P.vmin, nphB);
          const Pk = Pph, Qk = Qph;
          // UVLO sheds I and P only; the Z part rides through, which is now
          // automatic — a stamped admittance is always in the matrix.
          let i = 0;
          if (ok) {
            i += (ai * Pk * vb + bi * Qk * vQuad) / (V0ph * Math.sqrt(v2))
              + (ap * Pk * vb + bp * Qk * vQuad) / v2;
          }
          this.icmd = i;
          // Advance the susceptance companion before overwriting vz, exactly
          // as rlcp does.
          if (indz) this.iLz = vb * GLz + (be ? this.iLz : this.iLz + GLz * this.vz);
          if (capz) this.iCz = vb * GCz + (be ? -this.vz * GCz : -(this.vz * GCz + this.iCz));
          this.vz = vb;
          // Reported current is the TOTAL the block draws: the injected I/P
          // parts plus the stamped Z branch. The smoke test measures P and Q
          // from this against the ZIP polynomial, so it has to be the whole
          // current, not just the part that goes through inject().
          this.cur = this.icmd + Gz * vb + this.iLz + this.iCz;
        }
      });
    }

    // Surge arrester (SPEC section 2): one-terminal piecewise-linear shunt
    // clamp. Stamps its CURRENT segment's conductance (stampPhase reads
    // e.G fresh at each rebuild); the generic segCheck hook in the solver
    // event scan refactorizes when the segment changes. Continuous at the
    // knee (i = 0 at |v| = Vc), so switching causes no numerical shock.
    if (b.type === 'mov') {
      const P = b.params;
      const Gon = 1 / Math.max(P.Rd, 1e-3);
      arr.push({
        b, n1, n2: -1, kind: 'mov', G: GOFF, seg: 0, v: 0, cur: 0,
        segCheck() {
          const want = this.v > P.Vc ? 1 : this.v < -P.Vc ? -1 : 0;
          if (want === this.seg) return false;
          this.seg = want;
          this.G = want === 0 ? GOFF : Gon;
          return true;
        },
        inject(I) {
          if (this.seg !== 0 && n1 >= 0) I[n1] += this.seg * P.Vc * Gon;
        },
        update(vb) {
          this.v = vb;
          this.cur = this.seg === 0 ? vb * GOFF : (vb - this.seg * P.Vc) * Gon;
        }
      });
    }

    if (b.type === 'brk' || b.type === 'fault') {
      // both are conductance switches; fault = switch to ground through Rf,
      // applied at ton, cleared at first current zero after toff (like a breaker)
      const isFault = b.type === 'fault';
      const P = b.params;
      // brk only: operation schedule (SPEC section 2). sched[0] is the
      // tclose/topen pair (kept for back-compat with every existing example);
      // ops 2..nOps read tclose2/topen2 .. tclose5/topen5, dynamically added
      // to b.params by ui.js as the user raises nOps (not in DEFS.brk.params).
      // fault keeps its single ton/toff auto-clear model, no schedule.
      let sched = null;
      if (!isFault) {
        const nOps = Math.max(1, Math.min(5, Math.round(+P.nOps || 1)));
        sched = [{ tc: +P.tclose, to: +P.topen }];
        for (let i = 2; i <= nOps; i++) sched.push({ tc: +P['tclose' + i], to: +P['topen' + i] });
      }
      arr.push({
        b, n1, n2: isFault ? -1 : n2, kind: 'brk',
        gon: isFault ? 1 / b.params.Rf : GON, goff: GOFF,
        tc: isFault ? b.params.ton : sched[0].tc,
        to: isFault ? b.params.toff : sched[0].to,
        closed: !isFault && +b.params.init === 1, cur: 0,
        sched, opIdx: 0,
        // current-zero opening state: armed at t-open; opened latches unless
        // a next scheduled op advances tc/to and clears it (solver.js)
        armed: false, opened: false, pcur: 0,
        update(vb) { this.pcur = this.cur; this.cur = vb * (this.closed ? this.gon : this.goff); }
      });
    }
    if (b.type === 'tap') {
      // Phase tap (SPEC §2): connects ONE phase of a 3-phase node to a
      // single-phase lateral. Pure topology, so it is a plain 2-terminal
      // conductance — buildNodes has already restricted the lateral node to
      // this phase, and the generic `bph` skip above means this element is
      // only ever built at p === that phase. A union-find merge would NOT
      // work here: the merged node would carry all 3 unknowns again and the
      // phase restriction would be lost. Rc is a small, explicit connector
      // resistance rather than an ideal short, for the same reason `brk`
      // uses GON: a literal 0 Ω branch between two live nodes NaNs the LU.
      const G = 1 / Math.max(+b.params.Rc, 1e-6);
      arr.push({
        b, n1, n2, G, kind: 'tap', cur: 0,
        update(vb) { this.cur = vb * this.G; }
      });
    }
    // gnd, probe, and bus contribute no branches — a bus is pure topology,
    // its taps already unioned into one node in buildNodes (solver.js)
  });
  return arr;
}

// ---- coupled 3-phase lines (SPEC section 2, 3-ph mode only) ----
function inv3(M) {
  const [[a, b, c], [d, e, f], [g, h, i]] = M;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det]
  ];
}
const sym3 = (s, m) => [[s, m, m], [m, s, m], [m, m, s]];
const mv3 = (M, x) => M.map(r => r[0] * x[0] + r[1] * x[1] + r[2] * x[2]);

// ---- spanning elements: coupled lines, GFM, PFC, DC/DC (global indices + own stamp) ----
function makeSpanning(topo, dt, nph) {
  const arr = [];
  arr.push(...makeConverters(topo, dt)); // gfm: 3-ph, 1-ph mode, or a lateral
  if (nph === 3) arr.push(...makeCoupledLines(topo, dt), ...makeSyncGens(topo, dt), ...makeIMs(topo, dt), ...makeXfmr3s(topo, dt), ...makeXfmr3ws(topo, dt), ...makeSvcs(topo, dt), ...makeWt4s(topo, dt), ...makeGfls(topo, dt), ...makeHvdcs(topo, dt), ...makeScales(topo, dt));
  arr.push(...makePFCs(topo, dt, nph));
  arr.push(...makeDCDCs(topo, dt));
  arr.push(...makePiLines(topo, dt, nph));
  arr.push(...makeTlines(topo, dt, nph));
  arr.push(...makeFdlines(topo, dt, nph));
  arr.push(...makeSatXfmrs(topo, dt, nph));
  arr.push(...makeRelays(topo, dt, nph));
  arr.push(...makeZrels(topo, dt, nph));
  arr.push(...makeVsws(topo, dt, nph));
  arr.push(...makeGtrips(topo, dt, nph));
  return arr;
}

// GFM inverter AVM (SPEC section 2): controlled EMF
// e = √2·E·sin(θ+φp) behind an RL filter companion, PLUS an optional DC port
// (term 2): a lossless Norton current injection that follows whatever power
// the AC branch is already measured to deliver, so the inverter actually
// draws the energy it delivers from a real DC bus/battery instead of acting
// like an infinite-energy AC source. Two control modes share this same
// branch/state (mode param): GFM droop (open-loop, sets its own V/f, can
// island) or GFL dispatch (closed-loop PI toward a P0/Q0 setpoint, assumes
// the network is already near f0 — no explicit PLL, "lightweight" per SPEC).
function makeConverters(topo, dt) {
  const arr = [];
  const SHIFT = [0, -2 * Math.PI / 3, 2 * Math.PI / 3];
  S.blocks.forEach(b => {
    if (b.type !== 'gfm') return;
    const p = b.params;
    const Lf = p.Lf * 1e-3, Tf = Math.max(p.Tf, 0.1) * 1e-3;
    const G = 1 / (p.Rf + 2 * Lf / dt);
    const k2 = p.Rf - 2 * Lf / dt, kL = 2 * Lf / dt;
    // The phases this inverter occupies: all three normally, ONE on a
    // single-phase lateral or in 1-ph mode (SPEC §2 "Single-phase GFM").
    const pl = topo.phList(b), nP = pl.length, lat = nP === 1;
    const a1 = pl.map(ph => topo.gIdx(b, 0, ph));
    const a2 = pl.map(ph => topo.gIdx(b, 1, ph));
    const dc = topo.gIdx(b, 2, 0); // DC+ (optional — -1 if term 2 is unwired)
    // Single-phase measurement windows (SPEC §2): one phase's v·i pulsates at
    // 2f with amplitude equal to its own mean, so instantaneous p/q do not
    // exist the way they do for a balanced set. One-cycle moving averages give
    // exact, ripple-free P and Q; the quarter-cycle delay supplies the
    // orthogonal voltage reference Q needs (same technique as `pq`).
    const NW = Math.max(1, Math.round(1 / (Math.max(1, p.f0) * dt)));
    const ND = Math.max(1, Math.round(NW / 4));
    // AC current limiter (SPEC §2): EMF-magnitude backoff. 0/absent/negative
    // Iacmax = disabled (mu pinned at 1), so pre-feature files are unchanged.
    const Ilim = +p.Iacmax > 0 ? +p.Iacmax : 0;
    // W2 = 3·(Iacmax·|Zf|)²: balanced-set sum of squares of the RL-branch
    // voltage samples when the current is exactly at the limit (at f0).
    // nP·(Iacmax·|Zf|)²: the limiter's A/B/C sums below are per-phase rms²
    // quantities summed over the phases present, so W2 carries the same count.
    const W2 = nP * Ilim * Ilim * (p.Rf * p.Rf + Math.pow(2 * Math.PI * p.f0 * Lf, 2));
    // Taus: 5 ms measurement filter, 10 ms limiting relaxation, 100 ms release.
    // The backoff target is an affine phasor solve, NOT the proportional
    // mu·Iacmax/If fixed point: that assumed current ∝ mu, true only islanded.
    // Grid-tied, current follows the (mu·E − Vgrid) phasor DIFFERENCE, so the
    // proportional law drove mu to the floor after a cleared fault and latched
    // there (5x over-limit, inverter absorbing power). See SPEC §2.
    const TLIM = 5e-3, TDN = 10e-3, TUP = 100e-3, MUMIN = 0.02;
    const pi = b.pfInit; // power-flow init if solved (null = cold start, unchanged)
    // LL->per-phase at the boundary (cold start); pi.E is already per-phase.
    // A lateral is phase-to-neutral, so its E0 is a phase value already.
    const E0ph = vPh(p.E0, lat ? 1 : 3);
    const P0e = pi ? pi.P / 1000 : p.P0, E0e = pi ? pi.E : E0ph, Q0e = pi ? pi.Q / 1000 : p.Q0;
    arr.push({
      b, kind: 'gfm',
      th: pi ? pi.th : 0, E: pi ? pi.E : E0ph, Pf: pi ? pi.P : 0, Qf: pi ? pi.Q : 0, integP: 0, integQ: 0, idc: 0,
      // EMF polarity against the power-flow bus — see syncgen and SPEC §2.
      // Cold start = +1 (bit-identical to pre-feature runs).
      sgn: pi ? pfPolarity(topo, b) : 1,
      // limiter state: EMF scale, filtered E·V / V·V phasor sums (init = the
      // no-load point v ≈ e so startup sees tgt = 1, not a phantom fault),
      // and the actively-limited flag the GFL anti-windup keys on.
      mu: 1, Bf: nP * E0e * E0e, Cf: nP * E0e * E0e, lim: false,
      nEff: nP, // solver.js sizes this element's recorded traces from here
      x: new Array(nP).fill(0), i: new Array(nP).fill(0), cur: 0, // x = prev EMF-to-terminal branch voltage
      // 1-ph measurement state (unused when nP === 3): one-cycle projections
      // of v and i onto the inverter's OWN rotating reference
      bVs: new Float64Array(NW), bVc: new Float64Array(NW),
      bIs: new Float64Array(NW), bIc: new Float64Array(NW),
      sVs: 0, sVc: 0, sIs: 0, sIc: 0, wIdx: 0, wCnt: 0,
      stamp(M) {
        for (let k = 0; k < nP; k++) {
          if (a1[k] >= 0) M[a1[k]][a1[k]] += G;
          if (a2[k] >= 0) M[a2[k]][a2[k]] += G;
          if (a1[k] >= 0 && a2[k] >= 0) { M[a1[k]][a2[k]] -= G; M[a2[k]][a1[k]] -= G; }
        }
      },
      // SPEC §2 "Passive-history initialization": same shape as syncgen's
      // stator-branch seed — the inverter's OWN EMF-behind-(Rf+jωLf) branch,
      // x[k] = e − vb, i[k] = x/(Rf+jωLf), at mu = 1 (its own value at
      // t = −Δt, so no backoff term here). pl[k] is the GLOBAL phase this
      // local index sits on, matching e(k)'s own SHIFT[pl[k]] indexing. A
      // lateral inverter's pfV is always null (solvePowerFlow refuses tap
      // circuits), so the ready() gate has already cancelled the whole pass
      // before this can run with nP === 1 — but the loop is written generic
      // over nP/pl anyway rather than assuming 3-phase.
      seed(c) {
        if (!pi) return false;
        const Y = c.yRL(p.Rf, Lf), xs = [], is = [];
        for (let k = 0; k < nP; k++) {
          const Vb = c.vbr(b, pl[k], 1);
          if (!Vb) return false;
          const ang = pi.th + SHIFT[pl[k]];
          const Ep = { re: this.sgn * pi.E * Math.cos(ang), im: this.sgn * pi.E * Math.sin(ang) };
          const Xp = c.sub(Ep, Vb);
          xs.push(c.inst(Xp, c.t0)); is.push(c.inst(c.mul(Y, Xp), c.t0));
        }
        this.x = xs; this.i = is;
        return true;
      },
      // SHIFT is indexed by the GLOBAL phase, so a cold-started lateral
      // inverter on phase B is already aligned with the network's phase B
      // rather than starting 120° out and having to swing (or slip) into it —
      // the standing cold-start trap, and there is no PF init to fall back on
      // here since solvePowerFlow() refuses tap circuits.
      e(k) { return this.sgn * this.E * this.mu * Math.SQRT2 * Math.sin(this.th + SHIFT[pl[k]]); }, // mu = current-limiter backoff (SPEC §2)
      ihf(k, be) { return (be ? this.i[k] * kL : this.x[k] - this.i[k] * k2) * G; },
      inject(I, be) {
        for (let k = 0; k < nP; k++) {
          const inj = G * this.e(k) + this.ihf(k, be);
          if (a1[k] >= 0) I[a1[k]] += inj;
          if (a2[k] >= 0) I[a2[k]] -= inj;
        }
        if (dc >= 0) I[dc] -= this.idc; // one-step lag, same pattern as pfc/batt
      },
      update(V, be) {
        const h = be ? dt / 2 : dt;
        const nv = n => (n < 0 ? 0 : V[n]);
        const idx = []; for (let k = 0; k < nP; k++) idx.push(k);
        const vb = idx.map(k => nv(a1[k]) - nv(a2[k]));
        this._vb = vb; // branch voltage exposed for P/Q (SPEC §3), distinct from x (EMF-referenced)
        this._vt = idx.map(k => nv(a1[k])); // terminal-0 node voltage, for through-power
        const xNew = idx.map(k => this.e(k) - vb[k]); // EMF at θ used in inject
        const iNew = idx.map(k => G * xNew[k] + this.ihf(k, be));
        let pI, qI, lA = 0, lB = 0, lC = 0;
        if (!lat) {
          // BALANCED 3-PHASE (unchanged): these sums are instantaneous-exact
          // and ripple-free — 3E², 3·E·V·cosδ, 3V² for the limiter, and the
          // standard instantaneous p and q for the droop.
          if (Ilim) for (let k = 0; k < 3; k++) {
            const eu = this.e(k) / this.mu; // mu ≥ MUMIN, division safe
            lA += eu * eu; lB += eu * vb[k]; lC += vb[k] * vb[k];
          }
          pI = vb[0] * iNew[0] + vb[1] * iNew[1] + vb[2] * iNew[2];
          qI = ((vb[1] - vb[2]) * iNew[0] + (vb[2] - vb[0]) * iNew[1] + (vb[0] - vb[1]) * iNew[2]) / Math.sqrt(3);
        } else {
          // SINGLE PHASE (SPEC §2): none of those identities exist. Project v
          // and i onto the inverter's OWN rotating reference (θ plus its phase
          // shift) and average over one cycle. Using θ is the point: it tracks
          // the ACTUAL droop frequency, so nothing here mistunes when the
          // inverter runs off-nominal — which for a droop machine is the
          // normal operating state, not an edge case. (A fixed quarter-cycle
          // delay, the technique `pq` uses, is 90° only at exactly f0; at a
          // 47 Hz droop point it is 84.5°, which injected ~9% phantom Q into a
          // purely resistive load and then fed it back through the Q droop.)
          //
          // Convention matches `im`: √2·(U_re·sin ang + U_im·cos ang) has
          // phasor U_re + j·U_im, so U_re = √2·⟨u·sin ang⟩ over one cycle.
          const ang = this.th + SHIFT[pl[0]];
          const sn = Math.sin(ang), cs = Math.cos(ang);
          const v = vb[0], iw = iNew[0];
          const vs = v * sn, vc = v * cs, is = iw * sn, ic = iw * cs;
          this.sVs += vs - this.bVs[this.wIdx]; this.bVs[this.wIdx] = vs;
          this.sVc += vc - this.bVc[this.wIdx]; this.bVc[this.wIdx] = vc;
          this.sIs += is - this.bIs[this.wIdx]; this.bIs[this.wIdx] = is;
          this.sIc += ic - this.bIc[this.wIdx]; this.bIc[this.wIdx] = ic;
          this.wIdx = (this.wIdx + 1) % NW;
          if (this.wCnt < NW) this.wCnt++;
          const n = this.wCnt;
          const Vre = Math.SQRT2 * this.sVs / n, Vim = Math.SQRT2 * this.sVc / n;
          const Ire = Math.SQRT2 * this.sIs / n, Iim = Math.SQRT2 * this.sIc / n;
          // S = V·conj(I): P = VreIre + VimIim, Q = VimIre − VreIim, which
          // reproduces the 3-phase sign convention (Q > 0 lagging/inductive).
          pI = Vre * Ire + Vim * Iim;
          qI = Vim * Ire - Vre * Iim;
          // Limiter in the same frame, and analytically for the EMF: e/µ is
          // exactly √2·E·sin(ang), i.e. phasor (E, 0), so A = E², B = E·V·cosδ
          // = E·Vre, and C = |V|². No separate measurement needed.
          lA = this.E * this.E; lB = this.E * Vre; lC = Vre * Vre + Vim * Vim;
        }
        this.x = xNew; this.i = iNew; this.cur = iNew[0];
        this.Pf += h * (pI - this.Pf) / Tf;
        this.Qf += h * (qI - this.Qf) / Tf;
        let w;
        if (+p.mode === 1) { // GFL dispatch (SPEC §2): PI toward P0/Q0, not away from it
          const errP = p.P0 * 1000 - this.Pf, errQ = p.Q0 * 1000 - this.Qf;
          if (!this.lim) { // anti-windup: freeze trims while actively limited (SPEC §2)
            this.integP += p.kiP * h * errP / 1000; // kiP/kiQ are Hz/(kW·s), V/(kvar·s) — errP/Q are in W/VAR
            this.integQ += p.kiQ * h * errQ / 1000;
          }
          w = 2 * Math.PI * (p.f0 + p.mp * errP / 1000 + this.integP);
          this.E = E0ph + p.mq * errQ / 1000 + this.integQ;
        } else { // GFM droop about the PF-consistent P0/E/Q0 (falls back to params when no pfInit)
          w = 2 * Math.PI * (p.f0 - p.mp * (this.Pf / 1000 - P0e));
          this.E = E0e - p.mq * (this.Qf / 1000 - Q0e);
        }
        this.th += w * h;
        // AC current limiter (SPEC §2): the forced-response current magnitude
        // is |mu·Ê − V̂|/|Zf|, so the largest mu holding it at Iacmax solves
        // the quadratic mu²·A − 2·mu·B + C = W2 (terminal voltage held frozen
        // over the step). No real root means the network drives the current
        // regardless of mu (e.g. reclosing against a drifted angle): fall back
        // to the projection B/A, which tracks the terminal voltage for minimum
        // mismatch until the angle recloses (grid-voltage ride-through). Relax
        // toward tgt (no integrator): 10 ms while limited, 100 ms release.
        if (Ilim) {
          if (lat) { this.Bf = lB; this.Cf = lC; } // already one-cycle averaged; a second lag would only slow the loop
          else {
            this.Bf += h * (lB - this.Bf) / TLIM;
            this.Cf += h * (lC - this.Cf) / TLIM;
          }
          const A = Math.max(lA, 1e-9), disc = this.Bf * this.Bf - A * (this.Cf - W2);
          const tgt = Math.min(1, Math.max(0, disc >= 0 ? (this.Bf + Math.sqrt(disc)) / A : this.Bf / A));
          this.lim = tgt < 1;
          this.mu = Math.max(MUMIN, this.mu + h * (tgt - this.mu) / (this.lim ? TDN : TUP));
          // snap: the exponential release never REACHES 1 in floating point;
          // within 1e-4 (0.01% EMF) call it fully released so mu terminates.
          if (this.mu > 1 - 1e-4) this.mu = 1;
        }
        // DC port (SPEC §2): lossless AVM — DC current follows the just-measured
        // AC power, current-limited; one-step lag into the next inject().
        const vdc = dc >= 0 ? nv(dc) : 0;
        this.idc = dc >= 0 ? Math.max(-p.Idcmax, Math.min(p.Idcmax, this.Pf / (vdc || 1e-6))) : 0;
      }
    });
  });
  return arr;
}

// Synchronous generator, classical model (SPEC section 2, 3-ph mode only —
// same requirement as gfm, and for the same reason: the AVR needs the phase
// set to measure Q). Same EMF-behind-series-RL branch as makeConverters
// above (Ra/Ld here play Rf/Lf's role) — the only real difference is what
// drives theta: gfm's frequency is an ALGEBRAIC function of filtered P/Q
// (droop/PI, no memory); a real machine's rotor is a spinning mass, so
// frequency is a DYNAMIC STATE integrated from power imbalance via the
// swing equation — that's the actual capability this block adds. No DC
// port (a rotating machine has no natural DC side, unlike an inverter).
function makeSyncGens(topo, dt) {
  const arr = [];
  const SHIFT = [0, -2 * Math.PI / 3, 2 * Math.PI / 3];
  S.blocks.forEach(b => {
    if (b.type !== 'syncgen') return;
    const p = b.params;
    const Ld = p.Ld * 1e-3, Tf = Math.max(p.Tf, 0.1) * 1e-3;
    const G = 1 / (p.Ra + 2 * Ld / dt);
    const k2 = p.Ra - 2 * Ld / dt, kL = 2 * Ld / dt;
    const a1 = [0, 1, 2].map(ph => topo.gIdx(b, 0, ph));
    const a2 = [0, 1, 2].map(ph => topo.gIdx(b, 1, ph));
    const pi = b.pfInit; // power-flow init if solved (null = cold start, unchanged)
    const E0ph = vPh(p.E0, 3), VrefPh = vPh(p.Vref, 3); // LL->per-phase at the boundary (cold start); pi.* is already per-phase. Literal 3: makeSyncGens only runs at nph=3.
    const Pm0e = pi ? pi.P / 1000 : p.Pm0, E0e = pi ? pi.E : E0ph, Q0e = pi ? pi.Q / 1000 : p.Q0;
    // opt-in control dynamics (SPEC section 2): both default OFF (0), which
    // preserves the original algebraic laws bit-for-bit.
    const Tg = Math.max(0, +(p.Tg || 0)), Te = Math.max(0, +(p.Te || 0));
    const VrefA = +(p.Vref || 0) > 0 ? VrefPh : E0ph;
    arr.push({
      b, kind: 'syncgen',
      // Qf is the filter state of the INSTANTANEOUS reactive power qI, which is
      // in VAr — so the PF init is pi.Q (VAr), not pi.Q/1000. It was in kvar
      // until 2026-07-25, which started the droop-AVR law (E = E0 − mq·(Qf/1000
      // − Q0)) 1000x off in its Q term and let E walk for the first ~Tf. Too
      // small to see against a cold start's own inrush; it is 99% of what is
      // left once the passive histories are seeded (§5 item 32), which is how it
      // surfaced. `gfm` already stored VAr here.
      th: pi ? pi.th : 0, f: p.f0, E: pi ? pi.E : E0ph, Qf: pi ? pi.Q : 0,
      Pm: Pm0e, Vt2f: (pi ? pi.Vt : E0ph) ** 2,
      // EMF polarity against the power-flow bus (SPEC §2). Cold start = +1, so
      // every pre-feature run is bit-identical; under PF init this is what makes
      // the EMT waveforms agree with the power flow they were initialized from,
      // which the passive-history seed below depends on. The swing equation is
      // untouched either way: Pe = vb·i, and both flip together.
      sgn: pi ? pfPolarity(topo, b) : 1,
      x: [0, 0, 0], i: [0, 0, 0], cur: 0,
      stamp(M) {
        for (let ph = 0; ph < 3; ph++) {
          if (a1[ph] >= 0) M[a1[ph]][a1[ph]] += G;
          if (a2[ph] >= 0) M[a2[ph]][a2[ph]] += G;
          if (a1[ph] >= 0 && a2[ph] >= 0) { M[a1[ph]][a2[ph]] -= G; M[a2[ph]][a1[ph]] -= G; }
        }
      },
      e(ph) { return this.sgn * this.E * Math.SQRT2 * Math.sin(this.th + SHIFT[ph]); },
      // The machine's OWN stator branch (EMF behind Ra + jXd') is a history
      // register like any line's, and leaving it at rest while the EMF is
      // already at full magnitude is an inrush of exactly the kind §5 item 32
      // exists to remove. Its branch voltage is x = e − vb, so it seeds as an RL
      // branch driven by (E' − V_terminal): x at t = −Δt, i = x/(Ra + jXd').
      // Phase-by-phase into temporaries first, so a partial power flow (one
      // terminal on a dead bus) leaves a clean cold start rather than a mixture.
      seed(c) {
        if (!pi) return false;
        const Y = c.yRL(p.Ra, Ld), xs = [], is = [];
        for (let ph = 0; ph < 3; ph++) {
          const Vb = c.vbr(b, ph, 1);
          if (!Vb) return false;
          const ang = pi.th + SHIFT[ph];
          const Ep = { re: this.sgn * pi.E * Math.cos(ang), im: this.sgn * pi.E * Math.sin(ang) };
          const Xp = c.sub(Ep, Vb);
          xs.push(c.inst(Xp, c.t0)); is.push(c.inst(c.mul(Y, Xp), c.t0));
        }
        this.x = xs; this.i = is;
        return true;
      },
      ihf(ph, be) { return (be ? this.i[ph] * kL : this.x[ph] - this.i[ph] * k2) * G; },
      inject(I, be) {
        for (let ph = 0; ph < 3; ph++) {
          const inj = G * this.e(ph) + this.ihf(ph, be);
          if (a1[ph] >= 0) I[a1[ph]] += inj;
          if (a2[ph] >= 0) I[a2[ph]] -= inj;
        }
      },
      update(V, be) {
        const h = be ? dt / 2 : dt;
        const nv = n => (n < 0 ? 0 : V[n]);
        const vb = [0, 1, 2].map(ph => nv(a1[ph]) - nv(a2[ph]));
        this._vb = vb;
        this._vt = [0, 1, 2].map(ph => nv(a1[ph])); // terminal-0 node voltage, for through-power
        const xNew = [0, 1, 2].map(ph => this.e(ph) - vb[ph]);
        const iNew = [0, 1, 2].map(ph => G * xNew[ph] + this.ihf(ph, be));
        const pI = vb[0] * iNew[0] + vb[1] * iNew[1] + vb[2] * iNew[2];
        const qI = ((vb[1] - vb[2]) * iNew[0] + (vb[2] - vb[0]) * iNew[1] + (vb[0] - vb[1]) * iNew[2]) / Math.sqrt(3);
        this.x = xNew; this.i = iNew; this.cur = iNew[0];
        this.Qf += h * (qI - this.Qf) / Tf;
        // Swing equation (SPEC §2): frequency is a dynamic state, not an
        // algebraic droop line — advance it FIRST from its OLD value (same
        // sequencing gfm uses: advance Pf, then derive w from the new Pf),
        // then integrate theta from the freshly-updated f (semi-implicit
        // Euler — better damping behavior than fully-explicit). Pe feeds
        // the swing equation UNFILTERED (instantaneous, like real torque);
        // filtering it would add unphysical lag to the one term that should
        // respond immediately.
        const Pe = pI / 1000, Df = this.f - p.f0;
        const PmCmd = Pm0e - p.Kgov * Df; // governor droop about the PF-consistent Pm (Kgov=0 => fixed)
        let Pm = PmCmd;
        if (Tg > 0) { // opt-in turbine lag (SPEC §2): Pm becomes a state
          this.Pm += h * (PmCmd - this.Pm) / Tg;
          if (+p.Pmax > 0) this.Pm = Math.min(this.Pm, +p.Pmax);
          this.Pm = Math.max(0, this.Pm);
          Pm = this.Pm;
        }
        this.f += h * p.f0 * (Pm - Pe - p.D * Df) / (2 * p.H * p.Sbase);
        this.th += 2 * Math.PI * this.f * h;
        if (Te > 0) { // opt-in proportional AVR with lag REPLACES the Q-droop E law (SPEC §2)
          // branch voltage, not _vt: with the usual one-side-grounded wiring
          // |vb| IS the terminal voltage whichever terminal is grounded
          const vt2 = (vb[0] ** 2 + vb[1] ** 2 + vb[2] ** 2) / 3; // = Vrms² for balanced sets
          this.Vt2f += h * (vt2 - this.Vt2f) / Tf;
          const Ecmd = E0ph + p.Ka * (VrefA - Math.sqrt(Math.max(this.Vt2f, 0)));
          this.E += h * (Ecmd - this.E) / Te;
          if (+p.Emax > 0) this.E = Math.min(this.E, +p.Emax);
          this.E = Math.max(0, this.E);
        } else {
          this.E = E0e - p.mq * (this.Qf / 1000 - Q0e); // AVR droop about the PF-consistent E/Q
        }
      }
    });
  });
  return arr;
}

// Induction motor, classical single-cage third-order model (SPEC section 2,
// 3-ph mode only). QSS PHASOR model behind a Norton CURRENT-SOURCE
// interface (same G=0 interface family as pq/cpl/pfc): each step the
// terminal-voltage phasor is extracted with a one-cycle moving average,
// the stator current phasor is computed ALGEBRAICALLY as
// I = (V - E')/(Rs + jX'), and clean balanced sinusoids at exactly ws are
// injected. An EMF-behind-impedance branch (syncgen-style) was tried first
// and is fundamentally unstable here: the rotor EMF transient spins at
// -s*ws in the frame, the instantaneous stator branch answers its near-dc
// EMF content with up to 1/Rs gain, and that loop has round-trip gain
// ~dX/Rs >> 1 that no linear filter can kill across the whole slip range
// (found empirically; SPEC section 2). The current-source interface
// removes the loop's plant entirely. States: rotor transient EMF phasor
// (Ed,Eq) in the synchronous frame (sin reference), per-unit speed nu.
// theta is the FRAME clock (advances at exactly ws), not a rotor angle.
function makeIMs(topo, dt) {
  const arr = [];
  const SHIFT = [0, -2 * Math.PI / 3, 2 * Math.PI / 3];
  S.blocks.forEach(b => {
    if (b.type !== 'im') return;
    const p = b.params;
    const ws = 2 * Math.PI * p.f0;
    const Lp = (p.Lls + p.Lm * p.Llr / (p.Lm + p.Llr)) * 1e-3; // transient L'
    const Lt = (p.Lls + p.Lm) * 1e-3;                          // total (synchronous) L
    const T0 = ((p.Llr + p.Lm) * 1e-3) / p.Rr;                 // rotor o/c time constant
    const dX = ws * (Lt - Lp);                                 // X - X'
    const Xp = ws * Lp, den = p.Rs * p.Rs + Xp * Xp;           // |Rs + jX'|^2
    const Sb = p.Sbase * 1000, PL0 = p.PL * 1000, kx = +p.kexp;
    // one-cycle moving-average window for the voltage-phasor extraction
    // (integer cycles, the standing RMS-window rule): exact null at +/-ws
    // and all harmonics, unity gain at dc (the envelope), so steady state
    // is untouched and switching/fault transients enter over one cycle.
    const NMA = Math.max(1, Math.round(1 / (p.f0 * dt)));
    const a1 = [0, 1, 2].map(ph => topo.gIdx(b, 0, ph));
    const a2 = [0, 1, 2].map(ph => topo.gIdx(b, 1, ph));
    const s0 = Math.max(0, Math.min(1, +p.s0));
    arr.push({
      b, kind: 'im',
      th: 0, Ed: 0, Eq: 0, nu: 1 - s0, s: s0,
      bufR: new Float64Array(NMA), bufI: new Float64Array(NMA), bidx: 0, bcnt: 0, sumR: 0, sumI: 0,
      icmd: [0, 0, 0], i: [0, 0, 0], cur: 0,
      // no stamp(): pure current source, G = 0 (pq/cpl/pfc pattern)
      inject(I, be) {
        for (let ph = 0; ph < 3; ph++) { // passive convention: positive = absorbing
          if (a1[ph] >= 0) I[a1[ph]] -= this.icmd[ph];
          if (a2[ph] >= 0) I[a2[ph]] += this.icmd[ph];
        }
      },
      update(V, be) {
        const h = be ? dt / 2 : dt;
        const nv = n => (n < 0 ? 0 : V[n]);
        const vb = [0, 1, 2].map(ph => nv(a1[ph]) - nv(a2[ph]));
        this._vb = vb;
        this._vt = [0, 1, 2].map(ph => nv(a1[ph]));
        // terminal-voltage phasor (RMS, sin reference): (sqrt2/3)*sum(u*sin/
        // cos) is instantaneously exact for balanced sets (SPEC section 2),
        // then one-cycle-averaged to null dc offsets/harmonics at +/-ws.
        let Vre = 0, Vim = 0;
        for (let ph = 0; ph < 3; ph++) {
          Vre += vb[ph] * Math.sin(this.th + SHIFT[ph]);
          Vim += vb[ph] * Math.cos(this.th + SHIFT[ph]);
        }
        Vre *= Math.SQRT2 / 3; Vim *= Math.SQRT2 / 3;
        this.sumR += Vre - this.bufR[this.bidx]; this.bufR[this.bidx] = Vre;
        this.sumI += Vim - this.bufI[this.bidx]; this.bufI[this.bidx] = Vim;
        this.bidx = (this.bidx + 1) % NMA;
        if (this.bcnt < NMA) this.bcnt++;
        const Vrf = this.sumR / this.bcnt, Vif = this.sumI / this.bcnt;
        // stator current phasor, MOTOR convention (into machine), by phasor
        // algebra: I = (V - E')/(Rs + jX') = (V - E')*(Rs - jX')/den
        const dRe = Vrf - this.Ed, dIm = Vif - this.Eq;
        const Ire = (dRe * p.Rs + dIm * Xp) / den;
        const Iim = (dIm * p.Rs - dRe * Xp) / den;
        // airgap power (W, RMS phasors)
        const Pe = 3 * (this.Ed * Ire + this.Eq * Iim);
        // rotor EMF: decay/forcing explicit, slip rotation exact
        // (rotate-then-decay splitting, SPEC section 2: explicit Euler on
        // the -j*s*ws*E' rotation alone amplifies |1 + j*s*ws*h| per step
        // and can outrun the 1/T0' damping at locked rotor for large T0')
        const sl = 1 - this.nu;
        const Eds = this.Ed - h * (this.Ed + dX * Iim) / T0;
        const Eqs = this.Eq - h * (this.Eq - dX * Ire) / T0;
        const phi = sl * ws * h, c = Math.cos(phi), sn = Math.sin(phi);
        this.Ed = c * Eds + sn * Eqs;
        this.Eq = c * Eqs - sn * Eds;
        // mechanical state from the OLD Pe (semi-implicit, syncgen pattern);
        // load torque TL0*nu^k compared at the airgap-power point (both
        // sides divided by ws, SPEC section 2)
        this.nu += h * (Pe - PL0 * Math.pow(Math.max(this.nu, 0), kx)) / (2 * p.H * Sb);
        this.s = 1 - this.nu;
        this.th += ws * h;
        // next step's injected currents: balanced sinusoids of the just-
        // computed phasor at the advanced frame angle (one-step lag, same
        // pattern as pfc/gfm's dc port)
        for (let ph = 0; ph < 3; ph++) {
          this.icmd[ph] = Math.SQRT2 * (Ire * Math.sin(this.th + SHIFT[ph]) + Iim * Math.cos(this.th + SHIFT[ph]));
        }
        this.i = this.icmd.slice();
        this.cur = this.i[0];
      },
      // SPEC §2 "Passive-history initialization" / "Blocks entirely absent
      // from buildYbus". im is a shunt CURRENT source (no stamp, no PF load
      // entry), so it is outside SEED_REQUIRED and seeds in the second,
      // ungated loop. TWO things to seed, and only one is a window:
      //  * the one-cycle boxcar (bufR/bufI) is the easy half, identical to
      //    wt4's: the free-running clock th = ws*t projects the steady-state
      //    branch voltage onto a constant phasor, so slot j <- the value at
      //    t = -(NMA-j)*dt and the window is left full.
      //  * the genuine electromechanical state Ed/Eq/nu/s is the hard half,
      //    not a filter: it is the induction-motor steady-state torque
      //    balance, solved here for the operating slip directly from the
      //    third-order ODE makeIMs integrates (NOT the equivalent circuit:
      //    the smoke_test bisection solves the same balance and agrees to
      //    <2%, but this form is self-consistent with the ODE so the seeded
      //    Ed/Eq do not drift on the first step).
      // The third-order steady state (SPEC §2 derivation): with the transient
      //   impedance Zp = Rs + jXp and the rotor-EMF branch
      //   j*dX/(1 + j*s*ws*T0),  I = V / (Zp + j*dX/(1+j*s*ws*T0)),
      //   E' = j*dX*I/(1 + j*s*ws*T0),  Pe(s) = 3*|I|^2*Re(j*dX/(1+j*s*ws*T0)),
      //   and the balance Pe(s) = PL0*(1-s)^kexp fixes s. Bisect for the
      //   SMALL stable root (the motoring branch, below breakdown).
      //
      // icmd/i/cur stay COLD (zero), like wt4/svc/hvdc: the PF solved the
      // network as if the motor injects nothing, and the SEED_REQUIRED line
      // feeding it is seeded for that same zero current. Seeding icmd to the
      // motor's real draw would recreate the partially-seeded-series-pair
      // spike (the measured wt4 result). The seeded Ed/Eq and window bring the
      // motor to its steady-state current in a single update() step; the
      // one-step zero-to-steady ramp is a load step bounded by the source
      // impedance, not a series-pair spike.
      seed(c) {
        const Vph = [];
        for (let ph = 0; ph < 3; ph++) { const v = c.vbr(b, ph, 1); if (!v) return false; Vph.push(v); }
        const Vmag = Math.hypot(Vph[0].re, Vph[0].im);
        if (!(Vmag > 0)) return false;
        // airgap power Pe(s) for the third-order model (motor convention).
        const Pe = s => {
          const jsT = s * ws * T0, denE = 1 + jsT * jsT;   // |1 + j*s*ws*T0|^2
          const Zbr_re = dX * jsT / denE, Zbr_im = dX / denE; // j*dX/(1+j*s*ws*T0)
          const Zre = p.Rs + Zbr_re, Zim = Xp + Zbr_im;
          const Im2 = Vmag * Vmag / (Zre * Zre + Zim * Zim);
          return 3 * Im2 * Zbr_re;                          // 3*|I|^2*Re(Zbr)
        };
        const bal = s => Pe(s) - PL0 * Math.pow(Math.max(1 - s, 0), kx);
        // bracket the small stable root: scan up from s~0 (Pe~0 => bal<0 for a
        // loaded motor) to the first s where bal>0, then bisect. If the load
        // exceeds breakdown torque (bal never turns positive in the motoring
        // band) there is no steady motoring point -> decline, cold-start.
        if (bal(1e-4) >= 0) return false;
        let lo = 1e-4, hi = -1;
        const scan = [0.01,0.02,0.03,0.05,0.08,0.12,0.18,0.25,0.35,0.5,0.7,0.9,0.99];
        for (const s of scan) { if (bal(s) > 0) { hi = s; break; } lo = s; }
        if (hi < 0) return false;
        for (let it = 0; it < 80; it++) { const mid = (lo + hi) / 2; if (bal(mid) > 0) hi = mid; else lo = mid; }
        const sStar = (lo + hi) / 2;
        // stator current phasor I (motor convention) and transient EMF E' in
        // the th=ws*t frame the boxcar stores (matches the cold-start frame
        // to O(ws*dt), below the trapezoidal-vs-continuous floor in SPEC §2).
        const jsT = sStar * ws * T0, denE = 1 + jsT * jsT;
        const Zbr_re = dX * jsT / denE, Zbr_im = dX / denE;
        const Zre = p.Rs + Zbr_re, Zim = Xp + Zbr_im, Z2 = Zre * Zre + Zim * Zim;
        const Ire = (Vph[0].re * Zre + Vph[0].im * Zim) / Z2;
        const Iim = (Vph[0].im * Zre - Vph[0].re * Zim) / Z2;
        this.Ed = Zbr_re * Ire - Zbr_im * Iim;   // E' = Zbr * I
        this.Eq = Zbr_re * Iim + Zbr_im * Ire;
        this.s = sStar; this.nu = 1 - sStar;
        // one-cycle boxcar of the terminal-voltage phasor (wt4 pattern): the
        // motor's free-running clock th = ws*t projects the steady-state
        // branch voltage onto a constant phasor, so every seeded slot holds
        // (Re Vb, Im Vb); the window is left full so the first real call acts
        // on the true phasor instead of an NMA-step start-up ramp.
        let sumR = 0, sumI = 0;
        for (let j = 0; j < NMA; j++) {
          const t = -(NMA - j) * c.dt, thT = ws * t;
          let Vre = 0, Vim = 0;
          for (let ph = 0; ph < 3; ph++) {
            const vphT = c.inst(Vph[ph], t);
            Vre += vphT * Math.sin(thT + SHIFT[ph]);
            Vim += vphT * Math.cos(thT + SHIFT[ph]);
          }
          Vre *= Math.SQRT2 / 3; Vim *= Math.SQRT2 / 3;
          this.bufR[j] = Vre; this.bufI[j] = Vim;
          sumR += Vre; sumI += Vim;
        }
        this.sumR = sumR; this.sumI = sumI; this.bidx = 0; this.bcnt = NMA;
        this.th = ws * c.t0; // registers hold t = -dt, not t = 0 (SPEC §2)
        return true;
      }
    });
  });
  return arr;
}

// Vector-group three-phase transformer (SPEC section 2, 3-ph mode only).
// Three single-phase ideal-a:1-plus-leakage units (the existing xfmr
// companion, verbatim per unit) whose winding ports map onto the phase
// nodes by connection incidence rows: Y windings phase-to-neutral (solid
// neutral = phase node directly; otherwise the neutral is an INTERNAL
// unknown Kron-eliminated at build, with grounding admittance 1/Rn, or 0
// if ungrounded), D windings phase-to-phase with the pairing direction
// sigma setting the clock number. Zero-sequence circulation (delta) and
// blocking (ungrounded wye) fall out of the incidence structure; nothing
// is special-cased. Yy0 solid/solid reduces exactly to three xfmr blocks.
const XFMR3_CONNS = {
  YY0: { p: { t: 'Y' }, s: { t: 'Y' } },
  DY1: { p: { t: 'D', sig: -1 }, s: { t: 'Y' } },
  DY11: { p: { t: 'D', sig: 1 }, s: { t: 'Y' } },
  YD1: { p: { t: 'Y' }, s: { t: 'D', sig: 1 } },
  YD11: { p: { t: 'Y' }, s: { t: 'D', sig: -1 } }
};
function xfmr3Conn(params) {
  return XFMR3_CONNS[(params.conn || 'Dy11').toUpperCase().trim()] || XFMR3_CONNS.DY11;
}
function makeXfmr3s(topo, dt) {
  const arr = [];
  S.blocks.forEach(b => {
    if (b.type !== 'xfmr3') return;
    const p = b.params;
    const conn = xfmr3Conn(p);
    const a = xfmrA(p, 'xfmr3'), Lh = p.L * 1e-3;
    const g = 1 / (p.R + 2 * Lh / dt);
    const k2 = p.R - 2 * Lh / dt, kL = 2 * Lh / dt;
    // linear magnetizing shunt across the primary winding (PSS/E MAG1/MAG2
    // carries only the linear susceptance; no saturation knee). Gm = dt/(2*Lm)
    // is the standard trapezoidal inductor companion (same form makeSatXfmrs
    // uses for its linear segment). Lm = 0 skips it entirely (byte-identical).
    const Lm = +(p.Lm || 0) * 1e-3, hasMag = Lm > 0, Gm = hasMag ? dt / (2 * Lm) : 0;
    // extended unknowns: 0..2 primary phases, 3..5 secondary phases, then
    // one internal neutral per non-solidly-grounded wye side
    let NE = 6; const nIdx = { p: -1, s: -1 };
    const needN = (side, Rn) => side.t === 'Y' && +Rn !== 0;
    if (needN(conn.p, p.Rn1)) nIdx.p = NE++;
    if (needN(conn.s, p.Rn2)) nIdx.s = NE++;
    const nn = NE - 6;
    // incidence rows: port voltage u = sum(coeff * v_ext[idx])
    const rowFor = (side, base, k, nI) => {
      if (side.t === 'D') return [[base + k, 1], [base + (k + side.sig + 3) % 3, -1]];
      return nI >= 0 ? [[base + k, 1], [nI, -1]] : [[base + k, 1]];
    };
    const C1 = [0, 1, 2].map(k => rowFor(conn.p, 0, k, nIdx.p));
    const C2 = [0, 1, 2].map(k => rowFor(conn.s, 3, k, nIdx.s));
    // Y_ext = sum Ck' * Y2 * Ck (+ neutral grounding diagonals)
    const Ye = Array.from({ length: NE }, () => new Float64Array(NE));
    const addOuter = (rA, rB, y) => rA.forEach(([i, ci]) => rB.forEach(([j, cj]) => { Ye[i][j] += ci * cj * y; }));
    for (let k = 0; k < 3; k++) {
      addOuter(C1[k], C1[k], g); addOuter(C1[k], C2[k], -a * g);
      addOuter(C2[k], C1[k], -a * g); addOuter(C2[k], C2[k], a * a * g);
      if (hasMag) addOuter(C1[k], C1[k], Gm); // magnetizing shunt across primary port
    }
    if (nIdx.p >= 0 && +p.Rn1 > 0) Ye[nIdx.p][nIdx.p] += 1 / +p.Rn1;
    if (nIdx.s >= 0 && +p.Rn2 > 0) Ye[nIdx.s][nIdx.s] += 1 / +p.Rn2;
    // Kron: Yred = Ypp - Ypn Enn Ynp ; per step J_red = Jp - Ypn Enn Jn and
    // vn = Enn (Jn - Ynp vp). Enn = inv(Ynn), closed-form for nn <= 2.
    let Enn = null, Ypn = null, Ynp = null;
    const Yred = Array.from({ length: 6 }, (_, r) => Float64Array.from(Ye[r].slice(0, 6)));
    if (nn === 1) Enn = [[1 / Ye[6][6]]];
    else if (nn === 2) {
      const d = Ye[6][6] * Ye[7][7] - Ye[6][7] * Ye[7][6];
      Enn = [[Ye[7][7] / d, -Ye[6][7] / d], [-Ye[7][6] / d, Ye[6][6] / d]];
    }
    if (nn) {
      Ypn = Array.from({ length: 6 }, (_, r) => Array.from({ length: nn }, (_, c) => Ye[r][6 + c]));
      Ynp = Array.from({ length: nn }, (_, r) => Array.from({ length: 6 }, (_, c) => Ye[6 + r][c]));
      for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) {
        let acc = 0;
        for (let i = 0; i < nn; i++) for (let j = 0; j < nn; j++) acc += Ypn[r][i] * Enn[i][j] * Ynp[j][c];
        Yred[r][c] -= acc;
      }
    }
    const gi = [0, 1, 2].map(ph => topo.gIdx(b, 0, ph)).concat([0, 1, 2].map(ph => topo.gIdx(b, 1, ph)));
    arr.push({
      b, kind: 'xfmr3',
      iw: [0, 0, 0], vbw: [0, 0, 0], // per-unit winding state (primary-referred)
      i: [0, 0, 0], _vb: [0, 0, 0], cur: 0, _Jn: [0, 0], _Ih: [0, 0, 0],
      im: [0, 0, 0], lam: [0, 0, 0], vm: [0, 0, 0], // magnetizing flux/current/voltage per phase
      // SPEC §2 "Passive-history initialization". The registers here are WINDING
      // quantities, not terminal ones, so the seed has to be built through the
      // same incidence rows C1/C2 that update() uses — the vector group and the
      // clock shift live in those rows, and reading the block's two terminals
      // directly would silently drop both.
      //
      // The extended vector runs [primary A,B,C, secondary A,B,C, neutrals...].
      // The internal neutral phasors are ZERO: a neutral node carries the sum of
      // its three winding currents, and the power flow is positive-sequence, so
      // that sum vanishes and a grounding impedance drops no volts across it.
      // (That is exactly why it is safe to skip Kron-solving them here.)
      seed(c) {
        const ext = [];
        for (let k = 0; k < 3; k++) { const z = c.term(b, 0, k); if (!z) return false; ext.push(z); }
        for (let k = 0; k < 3; k++) { const z = c.term(b, 1, k); if (!z) return false; ext.push(z); }
        for (let r = 6; r < NE; r++) ext.push({ re: 0, im: 0 });
        const uOf = row => row.reduce((s, [e, cf]) => c.add(s, c.scale(ext[e], cf)), { re: 0, im: 0 });
        const Y = c.yRL(p.R, Lh), jw = { re: 0, im: -1 / c.w }; // jw = 1/(jω), the flux integrator
        for (let k = 0; k < 3; k++) {
          const u1 = uOf(C1[k]), u2 = uOf(C2[k]);
          const vb = c.sub(u1, c.scale(u2, a));
          this.vbw[k] = c.inst(vb, c.t0);
          this.iw[k] = c.inst(c.mul(Y, vb), c.t0);
          if (hasMag) { // flux is the integral of the PRIMARY PORT voltage: λ = u1/(jω)
            this.vm[k] = c.inst(u1, c.t0);
            this.lam[k] = c.inst(c.mul(u1, jw), c.t0);
            this.im[k] = this.lam[k] / Lm;
          }
        }
        return true;
      },
      stamp(M) {
        for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) {
          if (gi[r] >= 0 && gi[c] >= 0) M[gi[r]][gi[c]] += Yred[r][c];
        }
      },
      ihf(k, be) { return (be ? this.iw[k] * kL : this.vbw[k] - this.iw[k] * k2) * g; },
      inject(I, be) {
        const Je = new Float64Array(NE);
        for (let k = 0; k < 3; k++) {
          const Ih = this.ihf(k, be); this._Ih[k] = Ih;
          C1[k].forEach(([e, c]) => { Je[e] -= c * Ih; });      // primary port draws +Ih
          C2[k].forEach(([e, c]) => { Je[e] += c * a * Ih; });  // secondary port draws -a*Ih
          if (hasMag) { // magnetizing history current drawn from primary port
            const IhM = be ? this.im[k] : this.im[k] + Gm * this.vm[k];
            C1[k].forEach(([e, c]) => { Je[e] -= c * IhM; });
          }
        }
        this._Jn = nn ? [Je[6], Je[7] || 0] : [0, 0];
        for (let r = 0; r < 6; r++) {
          let v = Je[r];
          if (nn) for (let i = 0; i < nn; i++) for (let j = 0; j < nn; j++) v -= Ypn[r][i] * Enn[i][j] * this._Jn[j];
          if (gi[r] >= 0) I[gi[r]] += v;
        }
      },
      update(V, be) {
        const h = be ? dt / 2 : dt;
        const nv = n => (n < 0 ? 0 : V[n]);
        const vp = gi.map(nv);
        const vext = vp.slice();
        if (nn) for (let i = 0; i < nn; i++) {
          let acc = 0;
          for (let j = 0; j < nn; j++) {
            let s = this._Jn[j];
            for (let c = 0; c < 6; c++) s -= Ynp[j][c] * vp[c];
            acc += Enn[i][j] * s;
          }
          vext.push(acc);
        }
        const uOf = row => row.reduce((s2, [e, c]) => s2 + c * vext[e], 0);
        for (let k = 0; k < 3; k++) {
          const vb = uOf(C1[k]) - a * uOf(C2[k]);
          this.iw[k] = vb * g + this._Ih[k];
          this.vbw[k] = vb;
          this.i[k] = this.iw[k]; this._vb[k] = vb;
          if (hasMag) { // flux from primary port voltage (trapezoidal; BE uses v_n only)
            const vm1 = uOf(C1[k]);
            this.lam[k] += be ? h * vm1 : (h / 2) * (vm1 + this.vm[k]);
            this.im[k] = this.lam[k] / Lm;
            this.vm[k] = vm1;
          }
        }
        this.cur = this.i[0];
      }
    });
  });
  return arr;
}

// Overcurrent relay, IEEE C37.112 50/51 (SPEC section 2). Series sensing
// element: stamps a FIXED closed-breaker conductance per phase (never
// opens itself, so no LU refactor on its account), measures per-phase
// one-cycle sliding RMS of its own branch current, runs the standard's
// dynamic integral (trip when int dt/t(M) >= 1, disk-flyback reset below
// pickup), and on trip ARMS the target brk block's elements (sets their
// `to` to now) so the existing event loop opens each pole at its own
// current zero. link() is handed the per-phase element lists by
// simulate() to find the target breaker's elements.
const RELAY_CURVES = {
  MI: { A: 0.0515, B: 0.1140, p: 0.02, tr: 4.85 },
  VI: { A: 19.61, B: 0.491, p: 2, tr: 21.6 },
  EI: { A: 28.2, B: 0.1217, p: 2, tr: 29.1 }
};
function makeRelays(topo, dt, nph) {
  const arr = [];
  S.blocks.forEach(b => {
    if (b.type !== 'relay') return;
    const p = b.params;
    const cv = RELAY_CURVES[(p.curve || 'VI').toUpperCase().trim()] || RELAY_CURVES.VI;
    const TD = Math.max(+p.TD || 0.5, 0.01), Ipu = Math.max(+p.Ipu, 1e-6);
    // phList (SPEC §2 phase tap): [0,1,2] normally, [0] on DC / 1-ph, [k] on a
    // single-phase lateral. Sizing from nph instead would allocate three slots
    // and stamp two dead ones on a lateral.
    const pl = topo.phList(b), nEff = pl.length;
    const NW = Math.max(1, Math.round(1 / (Math.max(1, p.f) * dt))); // one-cycle RMS window
    const i1 = [], i2 = [];
    for (let k = 0; k < nEff; k++) { i1.push(topo.gIdx(b, 0, pl[k])); i2.push(topo.gIdx(b, 1, pl[k])); }
    arr.push({
      b, kind: 'relay', nEff, G: GON,
      i: new Array(nEff).fill(0), _vb: new Array(nEff).fill(0), _vt: new Array(nEff).fill(0),
      buf: Array.from({ length: nEff }, () => new Float64Array(NW)),
      sum2: new Array(nEff).fill(0), bidx: 0, bcnt: 0,
      integ: 0, tripped: false, frac: 0, brkEls: [],
      // SPEC §2 "Measurement-window pre-fill": relay's stamp() is a fixed
      // conductance with an EMPTY inject() — its current is always exactly
      // vb*GON, recomputed fresh from the current node voltages every step,
      // so there is no history term that could disagree with the rest of the
      // seeded network (why relay was never in SEED_REQUIRED). Only its OWN
      // Irms boxcar (buf/sum2, same one-cycle rule as vsw) mis-measures cold;
      // integ/tripped stay untouched, same reasoning as vsw's state/dwell.
      seed(c) {
        const Vs = [];
        for (let k = 0; k < nEff; k++) { const v = c.vbr(b, pl[k], 1); if (!v) return false; Vs.push(v); }
        for (let k = 0; k < nEff; k++) {
          let s = 0;
          for (let j = 0; j < NW; j++) {
            const cur = c.inst(Vs[k], -(NW - j) * c.dt) * GON;
            this.buf[k][j] = cur; s += cur * cur;
          }
          this.sum2[k] = s;
        }
        this.bidx = 0; this.bcnt = NW;
        return true;
      },
      link(phEls) { // collect the target breaker's per-phase elements
        const id = Math.round(+p.brkId);
        phEls.forEach(els => els.forEach(e => {
          if (e.b.id === id && e.b.type === 'brk') this.brkEls.push(e);
        }));
      },
      stamp(M) {
        for (let ph = 0; ph < nEff; ph++) {
          if (i1[ph] >= 0) M[i1[ph]][i1[ph]] += GON;
          if (i2[ph] >= 0) M[i2[ph]][i2[ph]] += GON;
          if (i1[ph] >= 0 && i2[ph] >= 0) { M[i1[ph]][i2[ph]] -= GON; M[i2[ph]][i1[ph]] -= GON; }
        }
      },
      inject() {}, // pure conductance, no history
      update(V, be, t) {
        const h = be ? dt / 2 : dt;
        const nv = n => (n < 0 ? 0 : V[n]);
        let Mmax = 0;
        for (let ph = 0; ph < nEff; ph++) {
          const vb = nv(i1[ph]) - nv(i2[ph]);
          const cur = vb * GON;
          this.i[ph] = cur; this._vb[ph] = vb; this._vt[ph] = nv(i1[ph]);
          const buf = this.buf[ph], old = buf[this.bidx];
          this.sum2[ph] += cur * cur - old * old;
          buf[this.bidx] = cur;
          const Irms = Math.sqrt(Math.max(0, this.sum2[ph]) / Math.min(this.bcnt + 1, NW));
          Mmax = Math.max(Mmax, Irms / Ipu);
        }
        this.bidx = (this.bidx + 1) % NW;
        if (this.bcnt < NW) this.bcnt++;
        this.cur = this.i[0];
        if (this.tripped) return;
        // 50 instantaneous
        const inst = +p.Iinst > 0 && Mmax * Ipu >= +p.Iinst;
        // 51 dynamic integral / reset (SPEC section 2)
        if (Mmax > 1.001) {
          const tM = TD * (cv.A / (Math.pow(Mmax, cv.p) - 1) + cv.B);
          this.integ += h / tM;
        } else if (Mmax < 1 && this.integ > 0) {
          this.integ = Math.max(0, this.integ - h * (1 - Mmax * Mmax) / (TD * cv.tr));
        }
        this.frac = Math.min(this.integ, 1);
        if (this.integ >= 1 || inst) {
          this.tripped = true; this.frac = 1;
          const ms = t * 1000;
          this.brkEls.forEach(e => { if (e.to < 0 || e.to > ms) e.to = ms; });
        }
      }
    });
  });
  return arr;
}

// Distance / line-protection relay (`zrel`): a series sensing element that
// extracts the positive-sequence voltage at terminal 0 and current through the
// element, computes apparent impedance Z = V/I, and trips a target breaker when
// Z enters one of three mho or impedance-circle zones for the set delay.
// The public-domain core is a plain impedance characteristic; modern
// microprocessor-specific features (quadrilateral, adaptive mho, traveling
// wave, communication-assisted tripping, sequence-component supervision) are out
// of scope and listed as limitations.
function makeZrels(topo, dt, nph) {
  const arr = [];
  const SHIFT = [0, -2 * Math.PI / 3, 2 * Math.PI / 3];
  S.blocks.forEach(b => {
    if (b.type !== 'zrel') return;
    const p = b.params;
    const f0 = Math.max(1, +p.f || 60);
    const w0 = 2 * Math.PI * f0;
    const NW = Math.max(1, Math.round(1 / (f0 * dt)));
    const pl = topo.phList(b), nEff = pl.length;
    const i1 = [], i2 = [];
    for (let k = 0; k < nEff; k++) { i1.push(topo.gIdx(b, 0, pl[k])); i2.push(topo.gIdx(b, 1, pl[k])); }
    const stampGON = function (M) {
      for (let ph = 0; ph < nEff; ph++) {
        if (i1[ph] >= 0) M[i1[ph]][i1[ph]] += GON;
        if (i2[ph] >= 0) M[i2[ph]][i2[ph]] += GON;
        if (i1[ph] >= 0 && i2[ph] >= 0) { M[i1[ph]][i2[ph]] -= GON; M[i2[ph]][i1[ph]] -= GON; }
      }
    };
    // The relay is a 3-ph element: a positive-sequence phasor needs three
    // phases. simulate()'s pre-check rejects a zrel on a lateral or in 1-ph
    // mode before we get here, so this is only a defensive sentinel — it still
    // stamps its closed-breaker conductance so a mis-ordered caller sees an
    // intact circuit rather than a silently severed one, and measures nothing.
    if (nEff !== 3) {
      arr.push({
        b, kind: 'zrel', nEff, G: GON, bad: true, cur: 0,
        i: new Array(nEff).fill(0), _vb: new Array(nEff).fill(0), _vt: new Array(nEff).fill(0),
        Zmag: 0, Zang: 0, Ipos: 0, tripped: false, frac: 0, brkEls: [],
        seed() { return true; }, link() {}, stamp: stampGON, inject() {},
        update(V) {
          const nv = n => (n < 0 ? 0 : V[n]);
          for (let k = 0; k < nEff; k++) {
            const vb = nv(i1[k]) - nv(i2[k]);
            this.i[k] = vb * GON; this._vb[k] = vb; this._vt[k] = nv(i1[k]);
          }
          this.cur = this.i[0];
        }
      });
      return;
    }
    // Zone reaches (ohms, engineering units — no vconv scaling) and definite-
    // time delays. Characteristic angle in radians.
    const theta = (+p.theta || 80) * Math.PI / 180;
    const mode = String(p.mode || 'mho').toLowerCase().trim();
    const zones = [
      { Zr: Math.max(1e-6, +p.Z1 || 50), Td: Math.max(0, +p.T1 || 0) * 1e-3, dw: 0, in: false },
      { Zr: Math.max(1e-6, +p.Z2 || 100), Td: Math.max(0, +p.T2 || 300) * 1e-3, dw: 0, in: false },
      { Zr: Math.max(1e-6, +p.Z3 || 200), Td: Math.max(0, +p.T3 || 600) * 1e-3, dw: 0, in: false }
    ];
    // Optional fault-detector (level) supervision: the classical practice of
    // gating an impedance element on a minimum-current detector, so Z = V/I is
    // only allowed to act while enough current flows for the ratio to mean
    // something. Default 0 = off (the Iinst precedent). The first-cycle and
    // de-energized cases are handled by the settling gate below rather than by
    // this element, so leaving it off is safe; it is here for users who want
    // the classical supervision, in positive-sequence RMS amps.
    const Imin = Math.max(0, +p.Imin || 0);
    // Arming delay, same meaning and default as gtrip's: a PF-initialized case
    // seeds measurement state but not control state, so a network full of
    // inverters rings for a while before it sits down, and that ring is not a
    // grid event. 0 keeps the relay armed from t = 0.
    const tArm = Math.max(0, +p.tarm || 0) * 1e-3;
    // Out-of-step (double-blinder) settings. oos 0 = off, so every case that
    // does not ask for it behaves exactly as a plain distance relay.
    const oosMode = Math.round(+p.oos || 0);
    const RB1 = Math.max(0, +p.RB1 || 0);
    const RB2 = Math.max(0, +p.RB2 || 0);
    const Tsw = Math.max(0, +p.Tsw || 0) * 1e-3;
    // A blinder pair only means anything as an ordered pair; solver.js rejects
    // a misordered one with a clear message, this is the defensive twin.
    const oosOn = oosMode > 0 && RB1 > 0 && RB2 > RB1;
    // PLL (same SRF-PLL family as gfl/gtrip).
    const KpPLL = 30, KiPLL = 900;
    const DLOCK = 0.02;
    // Correlator scaling: summing v_k·sin(θ+SHIFT_k) over three balanced phases
    // gives (3/2)·Vpeak·cos∠, so √2/3 turns it into an RMS phasor. The SAME
    // factor must be applied to V and to I — the ratio only lands in ohms when
    // both are the same kind of phasor.
    const KPH = Math.SQRT2 / 3;
    arr.push({
      b, kind: 'zrel', nEff, G: GON, cur: 0,
      i: new Array(nEff).fill(0), _vb: new Array(nEff).fill(0), _vt: new Array(nEff).fill(0),
      // One-cycle boxcars on the V and I correlator outputs, sharing bidx/bcnt.
      bufVR: new Float64Array(NW), bufVI: new Float64Array(NW), sumVR: 0, sumVI: 0,
      bufIR: new Float64Array(NW), bufII: new Float64Array(NW), sumIR: 0, sumII: 0,
      bidx: 0, bcnt: 0, nval: 0,
      // PLL state
      th: 0, wpll: w0, integPLL: 0, lockCnt: 0,
      Zmag: 0, Zang: 0, Ipos: 0, tripped: false, oosTripped: false, frac: 0, brkEls: [],
      // Out-of-step state machine: last blinder region (-1 = not yet known, so a
      // locus that starts INSIDE the blinders must leave and re-enter before it
      // can be called a swing), the instant and side of the outer-blinder
      // crossing, and the swing-declared latch.
      oPrev: -1, oT: -1, oSide: 0, oArm: false,
      // Seeding (SPEC section 2): like relay, the stamp is a fixed conductance
      // with an empty inject(), so the branch current is recomputed fresh from
      // the node voltages every step and there is no history term to disagree
      // with the seeded network. Only the correlator boxcars and the PLL angle
      // are seeded; the zone dwell timers and the trip latch stay cold, so a
      // PF-initialized case still has to see a real excursion to trip.
      seed(c) {
        const Vs = [], Is = [];
        for (let k = 0; k < 3; k++) {
          const v = c.term(b, 0, pl[k]); if (!v) return false;
          Vs.push(v);
          // Current through the GON short is exactly the branch voltage × GON.
          const vb = c.vbr(b, pl[k], 1); if (!vb) return false;
          Is.push(c.mul(vb, { re: GON, im: 0 }));
        }
        const ang = Math.atan2(Vs[0].im, Vs[0].re);
        let sVR = 0, sVI = 0, sIR = 0, sII = 0;
        for (let j = 0; j < NW; j++) {
          const t = -(NW - j) * c.dt, thT = ang + w0 * t;
          let Vre = 0, Vim = 0, Ire = 0, Iim = 0;
          for (let k = 0; k < 3; k++) {
            const vk = c.inst(Vs[k], t), ik = c.inst(Is[k], t);
            const sn = Math.sin(thT + SHIFT[k]), cs = Math.cos(thT + SHIFT[k]);
            Vre += vk * sn; Vim += vk * cs;
            Ire += ik * sn; Iim += ik * cs;
          }
          Vre *= KPH; Vim *= KPH; Ire *= KPH; Iim *= KPH;
          this.bufVR[j] = Vre; this.bufVI[j] = Vim;
          this.bufIR[j] = Ire; this.bufII[j] = Iim;
          sVR += Vre; sVI += Vim; sIR += Ire; sII += Iim;
        }
        this.sumVR = sVR; this.sumVI = sVI; this.sumIR = sIR; this.sumII = sII;
        // Measurement state is valid from t0 (that is what seeding buys); the
        // zone dwell timers and the trip latch stay cold.
        this.bidx = 0; this.bcnt = NW; this.nval = NW;
        // PLL state: theta at t0, integrator cold (f = f0 exactly), lock valid.
        this.th = ang + w0 * c.t0;
        this.wpll = w0; this.integPLL = 0; this.lockCnt = NW;
        return true;
      },
      link(phEls) { // collect the target breaker's per-phase elements (from relay)
        const id = Math.round(+p.brkId);
        phEls.forEach(els => els.forEach(e => {
          if (e.b.id === id && e.b.type === 'brk') this.brkEls.push(e);
        }));
      },
      stamp: stampGON,
      inject() {}, // pure conductance, no history
      update(V, be, t) {
        const h = be ? dt / 2 : dt;
        const nv = n => (n < 0 ? 0 : V[n]);
        // Branch current and terminal-0 voltage, per phase.
        let Vre = 0, Vim = 0, Ire = 0, Iim = 0;
        for (let k = 0; k < 3; k++) {
          const vt = nv(i1[k]), vb = vt - nv(i2[k]), cur = vb * GON;
          this.i[k] = cur; this._vb[k] = vb; this._vt[k] = vt;
          // Correlate V and I onto the PLL's own rotating frame, in ONE pass so
          // the two can never drift apart in scaling or reference angle.
          const sn = Math.sin(this.th + SHIFT[k]), cs = Math.cos(this.th + SHIFT[k]);
          Vre += vt * sn; Vim += vt * cs;
          Ire += cur * sn; Iim += cur * cs;
        }
        this.cur = this.i[0];
        Vre *= KPH; Vim *= KPH; Ire *= KPH; Iim *= KPH;
        this.sumVR += Vre - this.bufVR[this.bidx]; this.bufVR[this.bidx] = Vre;
        this.sumVI += Vim - this.bufVI[this.bidx]; this.bufVI[this.bidx] = Vim;
        this.sumIR += Ire - this.bufIR[this.bidx]; this.bufIR[this.bidx] = Ire;
        this.sumII += Iim - this.bufII[this.bidx]; this.bufII[this.bidx] = Iim;
        this.bidx = (this.bidx + 1) % NW;
        if (this.bcnt < NW) {
          // Window not full: measure nothing, but the frame must still TURN.
          // Correlating against a stationary frame averages a 60 Hz signal to
          // zero over the window, so the first sample after the fill would be
          // 0/0 — and a garbage Z near the origin sits deep inside every mho
          // circle, tripping the breaker on the relay's first look at a
          // perfectly healthy line. Free-run at w0 until the PLL takes over.
          this.bcnt++; this.th += w0 * h;
          return;
        }
        // === PLL ===
        const Vd = this.sumVR / this.bcnt, Vq = this.sumVI / this.bcnt;
        const delta = Math.atan2(Vq, Vd);
        if (Math.abs(delta) < Math.PI / 2) this.integPLL += delta * h;
        const CLAMP_MAX = 0.3 * w0 / KiPLL;
        if (this.integPLL > CLAMP_MAX) this.integPLL = CLAMP_MAX;
        if (this.integPLL < -CLAMP_MAX) this.integPLL = -CLAMP_MAX;
        let dwVco = KpPLL * delta + KiPLL * this.integPLL;
        const DWMAX = 0.3 * w0;
        if (dwVco > DWMAX) dwVco = DWMAX;
        if (dwVco < -DWMAX) dwVco = -DWMAX;
        this.wpll = w0 + dwVco;
        if (Math.abs(delta) < DLOCK) this.lockCnt++; else this.lockCnt = 0;
        this.th += this.wpll * h;
        // === Apparent impedance ===
        // Both phasors live in the same rotating frame, so Z = V/I is invariant
        // to the frame angle; only their RATIO matters.
        const Id = this.sumIR / this.bcnt, Iq = this.sumII / this.bcnt;
        const den2 = Id * Id + Iq * Iq;
        this.Ipos = Math.sqrt(den2);
        let Zre = 0, Zim = 0;
        if (den2 > 1e-18) {
          Zre = (Vd * Id + Vq * Iq) / den2;
          Zim = (Vq * Id - Vd * Iq) / den2;
        }
        this.Zmag = Math.hypot(Zre, Zim);
        this.Zang = Math.atan2(Zim, Zre) * 180 / Math.PI;
        if (this.tripped) { this.frac = 1; return; } // latched
        // === Zone characteristics ===
        // Mho: circle whose DIAMETER runs from the origin to Zr·e^(jθ), so the
        // center is at Zr/2·e^(jθ) and the radius is Zr/2.
        // Plain impedance: circle centered on Zr·e^(jθ) with radius Zr.
        // Two gates before any zone may pick up:
        //  - a settling window. Even with the frame turning, the first full
        //    boxcar still straddles the energization transient, and the PLL has
        //    had no cycle to pull in. One more window makes the measurement
        //    trustworthy before the element is allowed to act. This is
        //    measurement validity, NOT a protection delay: gtrip's `tarm` is
        //    the knob for deliberately blocking a start-up ring.
        //  - the fault detector (Imin), above.
        if (this.nval < NW) { this.nval++; this.frac = 0; return; }
        if (t < tArm) { this.frac = 0; return; }
        const armed = Imin <= 0 || this.Ipos >= Imin;
        // === Out-of-step: classical double-blinder scheme ===
        // Two blinders parallel to the line characteristic, at |u| = RB1
        // (inner) and |u| = RB2 (outer), where u is the component of Z
        // PERPENDICULAR to e^(jθ). At θ = 90° this is the textbook pair of
        // vertical lines on R.
        //
        // The discriminator is TIME, not position: a fault puts the impedance
        // inside the blinders in one step, while two systems pulling apart take
        // tens of milliseconds to walk the locus across. So a transit from the
        // outer blinder to the inner one SLOWER than Tsw is a power swing.
        // Distance zones cannot do this job — a separation swing is a resistive
        // excursion, and a mho circle set at the line angle has almost no
        // resistive coverage, so it never picks up however far it is reached.
        //
        // Tripping on the way OUT (mode 1, the classical preference) waits for
        // the locus to leave the outer blinder on the far side, i.e. a
        // completed pole slip: the breaker then interrupts with the systems
        // swinging back together and sees far less recovery voltage than it
        // would at the 180° point. Mode 2 trips on the way in, as soon as the
        // swing is declared.
        if (oosOn && armed) {
          const u = Zre * Math.sin(theta) - Zim * Math.cos(theta);
          const a = Math.abs(u), side = u >= 0 ? 1 : -1;
          const reg = a > RB2 ? 2 : (a > RB1 ? 1 : 0);
          if (this.oPrev === 2 && reg === 1) { this.oT = t; this.oSide = side; }
          if (reg === 0 && !this.oArm && this.oT >= 0 && (t - this.oT) >= Tsw) this.oArm = true;
          this.oPrev = reg;
          if (this.oArm && (oosMode === 2 || (reg === 2 && side !== this.oSide))) {
            this.tripped = true; this.oosTripped = true; this.frac = 1;
            const ms = t * 1000;
            this.brkEls.forEach(e => { if (e.to < 0 || e.to > ms) e.to = ms; });
            return;
          }
        }
        let worst = 0; // deepest penetration into any zone, for the aux signal
        for (let z = 0; z < zones.length; z++) {
          const zn = zones[z];
          const Zx = zn.Zr * Math.cos(theta), Zy = zn.Zr * Math.sin(theta);
          const cx = mode === 'imp' ? Zx : Zx / 2;
          const cy = mode === 'imp' ? Zy : Zy / 2;
          const radius = mode === 'imp' ? zn.Zr : zn.Zr / 2;
          const dist = Math.hypot(Zre - cx, Zim - cy);
          const inside = armed && dist < radius;
          const penetration = Math.max(0, 1 - dist / radius);
          if (inside && penetration > worst) worst = penetration;
          if (!inside) { zn.in = false; zn.dw = 0; continue; }
          if (!zn.in) { zn.in = true; zn.dw = 0; }
          zn.dw += h;
          if (zn.dw >= zn.Td) {
            this.tripped = true; this.frac = 1;
            const ms = t * 1000;
            this.brkEls.forEach(e => { if (e.to < 0 || e.to > ms) e.to = ms; });
            return;
          }
        }
        this.frac = worst;
      }
    });
  });
  return arr;
}

// Three-winding transformer (SPEC section 2, 3-ph mode only). Per phase:
// a 3-port star of primary-referred leakage companions whose internal
// star node is eliminated ANALYTICALLY (Y3[w][j] = aw*aj*(d*gw - gw*gj/G),
// history hw = aw*(Ihw - gw*sumIh/G)); the ports then map onto the phase
// nodes with the same connection-incidence + Kron-neutral machinery as
// xfmr3, generalized to three sides (up to 3 internal neutrals, inv3 for
// the 3x3 case). Delta-tertiary zero-sequence circulation falls out of
// the structure, nothing special-cased.
function xfmr3wConn(P) {
  const m = /^y(y0|d1|d11)(y0|d1|d11)$/.exec(String(P.conn || 'Yy0d1').toLowerCase().trim());
  const side = tok => (tok === 'y0' ? { t: 'Y' } : { t: 'D', sig: tok === 'd1' ? 1 : -1 });
  if (!m) return [{ t: 'Y' }, { t: 'Y' }, { t: 'D', sig: 1 }];
  return [{ t: 'Y' }, side(m[1]), side(m[2])];
}
function makeXfmr3ws(topo, dt) {
  const arr = [];
  S.blocks.forEach(b => {
    if (b.type !== 'xfmr3w') return;
    const P = b.params;
    const sides = xfmr3wConn(P);
    const aw = [1, ...xfmrA(P, 'xfmr3w')];
    const g = [0, 1, 2].map(w => 1 / (P['R' + (w + 1)] + 2 * (P['L' + (w + 1)] * 1e-3) / dt));
    const k2 = [0, 1, 2].map(w => P['R' + (w + 1)] - 2 * (P['L' + (w + 1)] * 1e-3) / dt);
    const kL = [0, 1, 2].map(w => 2 * (P['L' + (w + 1)] * 1e-3) / dt);
    const Gs = g[0] + g[1] + g[2];
    // linear magnetizing shunt across the primary winding (side 0, always wye):
    // same trapezoidal inductor companion as makeXfmr3s / makeSatXfmrs. Lm = 0
    // skips it entirely (byte-identical to today).
    const Lm = +(P.Lm || 0) * 1e-3, hasMag = Lm > 0, Gm = hasMag ? dt / (2 * Lm) : 0;
    // extended unknowns: 0..2 / 3..5 / 6..8 = side phases, then neutrals
    let NE = 9; const nI = [-1, -1, -1];
    for (let w = 0; w < 3; w++) {
      if (sides[w].t === 'Y' && +P['Rn' + (w + 1)] !== 0) nI[w] = NE++;
    }
    const nn = NE - 9;
    const rowFor = (side, base, k, ni) => {
      if (side.t === 'D') return [[base + k, 1], [base + (k + side.sig + 3) % 3, -1]];
      return ni >= 0 ? [[base + k, 1], [ni, -1]] : [[base + k, 1]];
    };
    const C = [0, 1, 2].map(w => [0, 1, 2].map(k => rowFor(sides[w], 3 * w, k, nI[w])));
    const Ye = Array.from({ length: NE }, () => new Float64Array(NE));
    const addOuter = (rA, rB, y) => rA.forEach(([i, ci]) => rB.forEach(([j, cj]) => { Ye[i][j] += ci * cj * y; }));
    for (let k = 0; k < 3; k++) {
      for (let w = 0; w < 3; w++) for (let j = 0; j < 3; j++) {
        const y3 = aw[w] * aw[j] * ((w === j ? g[w] : 0) - g[w] * g[j] / Gs);
        addOuter(C[w][k], C[j][k], y3);
      }
      if (hasMag) addOuter(C[0][k], C[0][k], Gm); // magnetizing shunt across primary
    }
    for (let w = 0; w < 3; w++) if (nI[w] >= 0 && +P['Rn' + (w + 1)] > 0) Ye[nI[w]][nI[w]] += 1 / +P['Rn' + (w + 1)];
    // Kron-eliminate neutrals (Enn = inv(Ynn): closed form nn<=2, inv3 nn=3)
    let Enn = null, Ypn = null, Ynp = null;
    const Yred = Array.from({ length: 9 }, (_, r) => Float64Array.from(Ye[r].slice(0, 9)));
    if (nn === 1) Enn = [[1 / Ye[9][9]]];
    else if (nn === 2) {
      const d = Ye[9][9] * Ye[10][10] - Ye[9][10] * Ye[10][9];
      Enn = [[Ye[10][10] / d, -Ye[9][10] / d], [-Ye[10][9] / d, Ye[9][9] / d]];
    } else if (nn === 3) {
      Enn = inv3([[Ye[9][9], Ye[9][10], Ye[9][11]], [Ye[10][9], Ye[10][10], Ye[10][11]], [Ye[11][9], Ye[11][10], Ye[11][11]]]);
    }
    if (nn) {
      Ypn = Array.from({ length: 9 }, (_, r) => Array.from({ length: nn }, (_, c) => Ye[r][9 + c]));
      Ynp = Array.from({ length: nn }, (_, r) => Array.from({ length: 9 }, (_, c) => Ye[9 + r][c]));
      for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
        let acc = 0;
        for (let i = 0; i < nn; i++) for (let j = 0; j < nn; j++) acc += Ypn[r][i] * Enn[i][j] * Ynp[j][c];
        Yred[r][c] -= acc;
      }
    }
    const gi = [];
    for (let w = 0; w < 3; w++) for (let ph = 0; ph < 3; ph++) gi.push(topo.gIdx(b, w, ph));
    arr.push({
      b, kind: 'xfmr3w',
      vbw: Array.from({ length: 3 }, () => [0, 0, 0]), // [phase][winding]
      iw: Array.from({ length: 3 }, () => [0, 0, 0]),
      i: [0, 0, 0], _vb: [0, 0, 0], cur: 0, _Jn: [0, 0, 0], _Ih: Array.from({ length: 3 }, () => [0, 0, 0]),
      im: [0, 0, 0], lam: [0, 0, 0], vm: [0, 0, 0], // magnetizing flux/current/voltage per phase
      // SPEC §2 "Passive-history initialization". Same incidence-row treatment
      // as xfmr3, but this element is a STAR (T) equivalent: three winding
      // impedances meeting at an internal star point that is not a network node.
      // Its phasor is the winding-admittance-weighted mean of the referred port
      // voltages, which is the phasor form of the `vs = (Sgu + SIh)/Gs` that
      // update() computes per step:
      //     V̄s = Σ (a_w·ū_w·Ȳ_w) / Σ Ȳ_w,  Ȳ_w = 1/(R_w + jωL_w)
      // then each winding is an ordinary branch across a_w·ū_w − V̄s.
      // Neutral phasors are zero for the same positive-sequence reason as xfmr3.
      seed(c) {
        const ext = [];
        for (let w = 0; w < 3; w++) for (let ph = 0; ph < 3; ph++) {
          const z = c.term(b, w, ph); if (!z) return false; ext.push(z);
        }
        for (let r = 9; r < NE; r++) ext.push({ re: 0, im: 0 });
        const uOf = row => row.reduce((s, [e, cf]) => c.add(s, c.scale(ext[e], cf)), { re: 0, im: 0 });
        const Yw = [0, 1, 2].map(w => c.yRL(P['R' + (w + 1)], P['L' + (w + 1)] * 1e-3));
        const Ysum = Yw.reduce((s, y) => c.add(s, y), { re: 0, im: 0 });
        const jw = { re: 0, im: -1 / c.w }; // 1/(jω), the flux integrator
        for (let k = 0; k < 3; k++) {
          const u = [0, 1, 2].map(w => uOf(C[w][k]));
          const uref = [0, 1, 2].map(w => c.scale(u[w], aw[w])); // referred to the primary
          const num = [0, 1, 2].reduce((s, w) => c.add(s, c.mul(uref[w], Yw[w])), { re: 0, im: 0 });
          const vs = c.div(num, Ysum);
          for (let w = 0; w < 3; w++) {
            const vb = c.sub(uref[w], vs);
            this.vbw[k][w] = c.inst(vb, c.t0);
            this.iw[k][w] = c.inst(c.mul(vb, Yw[w]), c.t0);
          }
          if (hasMag) { // magnetizing branch sits across the PRIMARY port (side 0)
            this.vm[k] = c.inst(u[0], c.t0);
            this.lam[k] = c.inst(c.mul(u[0], jw), c.t0);
            this.im[k] = this.lam[k] / Lm;
          }
        }
        return true;
      },
      stamp(M) {
        for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
          if (gi[r] >= 0 && gi[c] >= 0) M[gi[r]][gi[c]] += Yred[r][c];
        }
      },
      ihf(k, w, be) { return (be ? this.iw[k][w] * kL[w] : this.vbw[k][w] - this.iw[k][w] * k2[w]) * g[w]; },
      inject(I, be) {
        const Je = new Float64Array(NE);
        for (let k = 0; k < 3; k++) {
          let SIh = 0;
          for (let w = 0; w < 3; w++) { this._Ih[k][w] = this.ihf(k, w, be); SIh += this._Ih[k][w]; }
          for (let w = 0; w < 3; w++) {
            const hw = aw[w] * (this._Ih[k][w] - g[w] * SIh / Gs);
            C[w][k].forEach(([e, c]) => { Je[e] -= c * hw; });
          }
          if (hasMag) { // magnetizing history current drawn from primary port
            const IhM = be ? this.im[k] : this.im[k] + Gm * this.vm[k];
            C[0][k].forEach(([e, c]) => { Je[e] -= c * IhM; });
          }
        }
        this._Jn = nn ? [Je[9] || 0, Je[10] || 0, Je[11] || 0] : [0, 0, 0];
        for (let r = 0; r < 9; r++) {
          let v = Je[r];
          if (nn) for (let i = 0; i < nn; i++) for (let j = 0; j < nn; j++) v -= Ypn[r][i] * Enn[i][j] * this._Jn[j];
          if (gi[r] >= 0) I[gi[r]] += v;
        }
      },
      update(V, be) {
        const nv = n => (n < 0 ? 0 : V[n]);
        const vp = gi.map(nv);
        const vext = vp.slice();
        if (nn) for (let i = 0; i < nn; i++) {
          let acc = 0;
          for (let j = 0; j < nn; j++) {
            let s = this._Jn[j];
            for (let c = 0; c < 9; c++) s -= Ynp[j][c] * vp[c];
            acc += Enn[i][j] * s;
          }
          vext.push(acc);
        }
        const uOf = row => row.reduce((s2, [e, c]) => s2 + c * vext[e], 0);
        for (let k = 0; k < 3; k++) {
          const u = [0, 1, 2].map(w => uOf(C[w][k]));
          let SIh = 0, Sgu = 0;
          for (let w = 0; w < 3; w++) { SIh += this._Ih[k][w]; Sgu += g[w] * aw[w] * u[w]; }
          const vs = (Sgu + SIh) / Gs;
          for (let w = 0; w < 3; w++) {
            const vb = aw[w] * u[w] - vs;
            this.iw[k][w] = vb * g[w] + this._Ih[k][w];
            this.vbw[k][w] = vb;
          }
          this.i[k] = this.iw[k][0]; // primary winding current (a1 = 1)
          this._vb[k] = this.vbw[k][0];
          if (hasMag) { // flux from primary port voltage (trapezoidal; BE uses v_n only)
            const h = be ? dt / 2 : dt, vm1 = u[0];
            this.lam[k] += be ? h * vm1 : (h / 2) * (vm1 + this.vm[k]);
            this.im[k] = this.lam[k] / Lm;
            this.vm[k] = vm1;
          }
        }
        this.cur = this.i[0];
      }
    });
  });
  return arr;
}

// Saturable transformer (SPEC section 2): xfmr with Lm > 0 becomes a
// spanning element (the generic stamper can't add an independent shunt at
// one terminal — the pi-line constraint again): the original series
// ideal+leakage companion PLUS a piecewise-linear magnetizing inductor at
// the primary terminal. Flux integrates the terminal voltage; the
// two-slope lambda-i map switches segments through the generic segCheck
// hook (now scanned for spanning elements too). Lm = 0 keeps the original
// per-phase element, untouched.
function makeSatXfmrs(topo, dt, nph) {
  const arr = [];
  S.blocks.forEach(b => {
    if (b.type !== 'xfmr' || !(+(b.params.Lm || 0) > 0)) return;
    const P = b.params;
    const Lh = P.L * 1e-3, a = xfmrA(P, 'xfmr');
    const g = 1 / (P.R + 2 * Lh / dt);
    const k2 = P.R - 2 * Lh / dt, kL = 2 * Lh / dt;
    const Lm = P.Lm * 1e-3, Lst = Math.max(P.Lsat, 0.01) * 1e-3;
    const lk = +(P.lknee || 0); // 0 = linear (no knee)
    const Gm = [dt / (2 * Lm), dt / (2 * Lst)]; // per segment (0=linear, 1=saturated)
    const iOf = lam => { // exact piecewise map (SPEC §2)
      if (lk <= 0 || Math.abs(lam) <= lk) return lam / Lm;
      const s = Math.sign(lam);
      return s * lk / Lm + (lam - s * lk) / Lst;
    };
    const i1 = [], i2 = [];
    for (let ph = 0; ph < nph; ph++) { i1.push(topo.gIdx(b, 0, ph)); i2.push(topo.gIdx(b, 1, ph)); }
    arr.push({
      b, kind: 'xfmrsat',
      i: new Array(nph).fill(0), v: new Array(nph).fill(0), _vb: new Array(nph).fill(0),
      im: new Array(nph).fill(0), lam: new Array(nph).fill(0), vm: new Array(nph).fill(0),
      seg: new Array(nph).fill(0), cur: 0,
      // SPEC §2 "Passive-history initialization". Series leakage branch exactly
      // like `xfmr`, plus the magnetizing branch across terminal 0.
      //
      // The flux seed is EXACT even though this element is nonlinear: λ is the
      // integral of the terminal voltage, and integration is linear, so
      // λ̄ = V̄1/(jω) holds whatever the λ-i curve does. Only the CURRENT is
      // nonlinear, and iOf() is the same exact piecewise map update() uses.
      // `seg` is then set from λ by segCheck()'s own rule, which matters: the
      // element is seeded before buildLU runs, so the first factorization must
      // already carry the segment the seeded flux puts it on.
      // A core whose STEADY-STATE flux already sits past the knee cannot be
      // seeded consistently, and this is a model mismatch rather than a
      // tolerance: `buildYbus` represents the magnetizing branch by the LINEAR
      // Lm, so the power flow's bus voltages are not the ones a saturated core
      // would hold, and preloading the saturated magnetizing current against
      // them is far worse than starting cold (2485% vs 41% first-cycle
      // deviation, measured). Decline, and let the all-or-nothing rule give the
      // circuit its ordinary cold start. Flux amplitude is |λ| = √2·|V1|/ω,
      // linear in the voltage whatever the λ-i curve does.
      seedVeto(c) {
        if (lk <= 0) return false; // linear core: nothing to leave
        for (let ph = 0; ph < nph; ph++) {
          const v1 = c.term(b, 0, ph);
          if (!v1) return true;
          if (Math.SQRT2 * Math.hypot(v1.re, v1.im) / c.w > lk) return true;
        }
        return false;
      },
      seed(c) {
        const Y = c.yRL(P.R, Lh), jw = { re: 0, im: -1 / c.w };
        const vs = [], is = [], vms = [], lams = [];
        for (let ph = 0; ph < nph; ph++) {
          const v1 = c.term(b, 0, ph), v2 = c.term(b, 1, ph);
          if (!v1 || !v2) return false;
          const vb = c.sub(v1, c.scale(v2, a));
          vs.push(c.inst(vb, c.t0)); is.push(c.inst(c.mul(Y, vb), c.t0));
          vms.push(c.inst(v1, c.t0)); lams.push(c.inst(c.mul(v1, jw), c.t0));
        }
        for (let ph = 0; ph < nph; ph++) {
          this.v[ph] = vs[ph]; this.i[ph] = is[ph];
          this.vm[ph] = vms[ph]; this.lam[ph] = lams[ph];
          this.im[ph] = iOf(this.lam[ph]);
          this.seg[ph] = lk > 0 && Math.abs(this.lam[ph]) > lk ? 1 : 0;
        }
        return true;
      },
      segCheck() {
        let changed = false;
        for (let ph = 0; ph < nph; ph++) {
          const want = lk > 0 && Math.abs(this.lam[ph]) > lk ? 1 : 0;
          if (want !== this.seg[ph]) { this.seg[ph] = want; changed = true; }
        }
        return changed;
      },
      stamp(M) {
        for (let ph = 0; ph < nph; ph++) {
          if (i1[ph] >= 0) M[i1[ph]][i1[ph]] += g + Gm[this.seg[ph]];
          if (i2[ph] >= 0) M[i2[ph]][i2[ph]] += a * a * g;
          if (i1[ph] >= 0 && i2[ph] >= 0) { M[i1[ph]][i2[ph]] -= a * g; M[i2[ph]][i1[ph]] -= a * g; }
        }
      },
      ihS(ph, be) { return (be ? this.i[ph] * kL : this.v[ph] - this.i[ph] * k2) * g; },
      ihM(ph, be) { return be ? this.im[ph] : this.im[ph] + Gm[this.seg[ph]] * this.vm[ph]; },
      inject(I, be) {
        for (let ph = 0; ph < nph; ph++) {
          const IhS = this.ihS(ph, be), IhM = this.ihM(ph, be);
          if (i1[ph] >= 0) I[i1[ph]] -= IhS + IhM;
          if (i2[ph] >= 0) I[i2[ph]] += a * IhS;
        }
      },
      update(V, be) {
        const h = be ? dt / 2 : dt;
        const nv = n => (n < 0 ? 0 : V[n]);
        for (let ph = 0; ph < nph; ph++) {
          const v1 = nv(i1[ph]), v2 = nv(i2[ph]);
          const vb = v1 - a * v2;
          this.i[ph] = vb * g + this.ihS(ph, be);
          this.v[ph] = vb; this._vb[ph] = vb;
          // flux from the terminal voltage (trapezoidal; BE uses v_n only),
          // then the EXACT piecewise map for the magnetizing current
          this.lam[ph] += be ? h * v1 : (h / 2) * (v1 + this.vm[ph]);
          this.im[ph] = iOf(this.lam[ph]);
          this.vm[ph] = v1;
        }
        this.cur = this.i[0];
      }
    });
  });
  return arr;
}

// VSC-HVDC point-to-point AVM (SPEC section 2, 3-ph mode only). Two
// wt4-style QSS phasor current injections (one per AC terminal, shunt
// with ground return) tied by an INTERNAL dc-link state: side A
// PI-regulates Vdc (draws from grid A), side B dispatches Pset through a
// first-order lag; dVdc/dt = (eff*P_A - P_B)/(Cdc*Vdc). Generic two-level
// VSC AVM only (screening boundary in the business log): no MMC detail.
function makeHvdcs(topo, dt) {
  const arr = [];
  const SHIFT = [0, -2 * Math.PI / 3, 2 * Math.PI / 3];
  S.blocks.forEach(b => {
    if (b.type !== 'hvdc') return;
    const p = b.params;
    const ws = 2 * Math.PI * p.f0;
    const NMA = Math.max(1, Math.round(1 / (p.f0 * dt)));
    const gA = [0, 1, 2].map(ph => topo.gIdx(b, 0, ph));
    const gB = [0, 1, 2].map(ph => topo.gIdx(b, 1, ph));
    const Cdc = Math.max(p.Cdc, 1) * 1e-6, Tp = Math.max(p.Tp, 1) * 1e-3;
    const mkSide = gi => ({
      gi, bufR: new Float64Array(NMA), bufI: new Float64Array(NMA), bidx: 0, bcnt: 0, sumR: 0, sumI: 0,
      Irf: 0, Iif: 0, icmd: [0, 0, 0]
    });
    arr.push({
      b, kind: 'hvdc',
      th: 0, Vdc: p.VdcRef, integ: 0, Pb: 0,
      A: mkSide(gA), B: mkSide(gB),
      i: [0, 0, 0], _vb: [0, 0, 0], cur: 0,
      // SPEC §2 "Scope and fallbacks" (blocks absent from buildYbus): same
      // treatment as wt4/svc. Both sides' bufR/bufI seed by the general
      // ring-buffer rule against the SHARED `th` clock (both sides project
      // onto the same th, per side()); Irf/Iif/icmd/Vdc/integ/Pb stay cold —
      // hvdc is absent from buildYbus like wt4, so the PF's node voltage on
      // either side does not reflect the DC link actually being active, and
      // seeding the commanded current would recreate the same
      // partially-seeded-series-pair spike wt4's attempt did.
      seed(c) {
        const seedSide = (S2, ti) => {
          const Vph = [];
          for (let ph = 0; ph < 3; ph++) { const v = c.term(b, ti, ph); if (!v) return false; Vph.push(v); }
          let sumR = 0, sumI = 0;
          for (let j = 0; j < NMA; j++) {
            const t = -(NMA - j) * c.dt, thT = ws * t;
            let Vre = 0, Vim = 0;
            for (let ph = 0; ph < 3; ph++) {
              const vphT = c.inst(Vph[ph], t);
              Vre += vphT * Math.sin(thT + SHIFT[ph]);
              Vim += vphT * Math.cos(thT + SHIFT[ph]);
            }
            Vre *= Math.SQRT2 / 3; Vim *= Math.SQRT2 / 3;
            S2.bufR[j] = Vre; S2.bufI[j] = Vim;
            sumR += Vre; sumI += Vim;
          }
          S2.sumR = sumR; S2.sumI = sumI; S2.bidx = 0; S2.bcnt = NMA;
          return true;
        };
        if (!seedSide(this.A, 0) || !seedSide(this.B, 1)) return false;
        this.th = ws * c.t0;
        return true;
      },
      inject(I) {
        for (let ph = 0; ph < 3; ph++) {
          if (gA[ph] >= 0) I[gA[ph]] += this.A.icmd[ph];
          if (gB[ph] >= 0) I[gB[ph]] += this.B.icmd[ph];
        }
      },
      side(S2, V, Pinj, Qinj, h) { // extraction + phasor injection, wt4 pattern
        const nv = n => (n < 0 ? 0 : V[n]);
        const v = [0, 1, 2].map(ph => nv(S2.gi[ph]));
        let Vre = 0, Vim = 0;
        for (let ph = 0; ph < 3; ph++) {
          Vre += v[ph] * Math.sin(this.th + SHIFT[ph]);
          Vim += v[ph] * Math.cos(this.th + SHIFT[ph]);
        }
        Vre *= Math.SQRT2 / 3; Vim *= Math.SQRT2 / 3;
        S2.sumR += Vre - S2.bufR[S2.bidx]; S2.bufR[S2.bidx] = Vre;
        S2.sumI += Vim - S2.bufI[S2.bidx]; S2.bufI[S2.bidx] = Vim;
        S2.bidx = (S2.bidx + 1) % NMA;
        if (S2.bcnt < NMA) S2.bcnt++;
        const Vrf = S2.sumR / S2.bcnt, Vif = S2.sumI / S2.bcnt;
        const V2m = Vrf * Vrf + Vif * Vif;
        let Ire = 0, Iim = 0;
        if (S2.bcnt >= NMA && Math.sqrt(V2m) > vPh(p.vmin, 3)) {
          Ire = (Pinj * Vrf + Qinj * Vif) / (3 * Math.max(V2m, 1));
          Iim = (Pinj * Vif - Qinj * Vrf) / (3 * Math.max(V2m, 1));
          const Im = Math.hypot(Ire, Iim);
          if (Im > p.Imax) { const sc = p.Imax / Im; Ire *= sc; Iim *= sc; }
        }
        const kf = Math.min(1, h / 1e-3); // 1 ms LPF (wt4 Nyquist-ringing cure)
        S2.Irf += kf * (Ire - S2.Irf);
        S2.Iif += kf * (Iim - S2.Iif);
        return v;
      },
      update(V, be) {
        const h = be ? dt / 2 : dt;
        // side B dispatch through the ramp lag; side A PI on the link
        this.Pb += h * (p.Pset * 1000 - this.Pb) / Tp;
        const err = p.VdcRef - this.Vdc;
        this.integ += p.ki * 1000 * h * err;
        let Pa = p.kp * 1000 * err + this.integ;
        const cap = p.Prate * 1000;
        const PaC = Math.max(-cap, Math.min(cap, Pa));
        this.integ += PaC - Pa; Pa = PaC; // anti-windup back-calculation
        const vA = this.side(this.A, V, -Pa, p.QA * 1000, h);       // side A: draws Pa
        this.side(this.B, V, this.Pb, p.QB * 1000, h);              // side B: injects Pb
        this.Vdc = Math.max(1, this.Vdc + h * (p.eff * Pa - this.Pb) / (Cdc * this.Vdc));
        this.th += ws * h;
        for (let ph = 0; ph < 3; ph++) {
          this.A.icmd[ph] = Math.SQRT2 * (this.A.Irf * Math.sin(this.th + SHIFT[ph]) + this.A.Iif * Math.cos(this.th + SHIFT[ph]));
          this.B.icmd[ph] = Math.SQRT2 * (this.B.Irf * Math.sin(this.th + SHIFT[ph]) + this.B.Iif * Math.cos(this.th + SHIFT[ph]));
        }
        this._vb = vA; // side A node voltages; with FLOW_REVERSED the plotted P is side A absorbing-positive
        this.i = this.A.icmd.slice();
        this.cur = this.i[0];
      }
    });
  });
  return arr;
}

// Type 4 wind turbine AVM (SPEC section 2, 3-ph mode only). The induction
// motor's QSS phasor interface run as a SOURCE: one-cycle-averaged
// terminal-voltage phasor, injection phasor from the commanded complex
// power (cubic wind curve capped at rating), converter current limit,
// UVLO. Generic textbook AVM only (screening boundary in the business
// log): no vendor LVRT/synthetic-inertia/pitch schemes.
function makeWt4s(topo, dt) {
  const arr = [];
  const SHIFT = [0, -2 * Math.PI / 3, 2 * Math.PI / 3];
  S.blocks.forEach(b => {
    if (b.type !== 'wt4') return;
    const p = b.params;
    const ws = 2 * Math.PI * p.f0;
    const NMA = Math.max(1, Math.round(1 / (p.f0 * dt)));
    const a1 = [0, 1, 2].map(ph => topo.gIdx(b, 0, ph));
    const a2 = [0, 1, 2].map(ph => topo.gIdx(b, 1, ph));
    const pOf = vwv => Math.min(p.Prated, p.Prated * Math.pow(Math.max(vwv, 0) / p.vrated, 3)) * 1000;
    arr.push({
      b, kind: 'wt4',
      th: 0, Pcmd: 0, Irf: 0, Iif: 0,
      bufR: new Float64Array(NMA), bufI: new Float64Array(NMA), bidx: 0, bcnt: 0, sumR: 0, sumI: 0,
      icmd: [0, 0, 0], i: [0, 0, 0], _vb: [0, 0, 0], cur: 0,
      // SPEC §2 "Measurement-window pre-fill". `th` is wt4's own free-running
      // clock (th += ws*h every step, no PLL locking it to the network), so
      // its history value is the backward-linear extrapolation th(t) = ws·t,
      // and the window's per-sample projection basis at each past time must
      // use THAT th, not the network's true phase.
      //
      // Irf/Iif/icmd/Pcmd stay COLD, unlike pq/gfm/pline. Not a simplification
      // — seeding them was tried and made this WORSE than cold (measured:
      // 420% first-cycle deviation on a dead-end bus, 35% even behind a stiff
      // near-zero-impedance source, vs 2-18% unseeded). The reason: unlike
      // pq/zip, wt4 is entirely ABSENT from buildYbus (SPEC §2 above), so
      // solvePowerFlow() solves the network as if wt4 injects NOTHING — which
      // is exactly what `line`'s own (correctly-seeded, SEED_REQUIRED) history
      // assumes too. Seeding wt4's commanded current to its true dispatch
      // (tens of A) while the line next to it is seeded for ZERO current
      // recreates the exact partially-seeded-series-pair spike the
      // all-or-nothing rule exists to prevent — just between a REQUIRED
      // branch and an OPTIONAL one instead of two REQUIRED ones. So the
      // commanded current must start at the SAME zero the required branches
      // around it assume, and ramp up through the normal control loop exactly
      // as it does cold; only the voltage MEASUREMENT — which injects nothing
      // — is safe to seed.
      seed(c) {
        const Vph = [];
        for (let ph = 0; ph < 3; ph++) { const v = c.vbr(b, ph, 1); if (!v) return false; Vph.push(v); }
        let sumR = 0, sumI = 0;
        for (let j = 0; j < NMA; j++) {
          const t = -(NMA - j) * c.dt, thT = ws * t;
          let Vre = 0, Vim = 0;
          for (let ph = 0; ph < 3; ph++) {
            const vphT = c.inst(Vph[ph], t);
            Vre += vphT * Math.sin(thT + SHIFT[ph]);
            Vim += vphT * Math.cos(thT + SHIFT[ph]);
          }
          Vre *= Math.SQRT2 / 3; Vim *= Math.SQRT2 / 3;
          this.bufR[j] = Vre; this.bufI[j] = Vim;
          sumR += Vre; sumI += Vim;
        }
        this.sumR = sumR; this.sumI = sumI; this.bidx = 0; this.bcnt = NMA;
        this.th = ws * c.t0;
        return true;
      },
      inject(I) {
        for (let ph = 0; ph < 3; ph++) { // generator convention (FLOW_REVERSED)
          if (a1[ph] >= 0) I[a1[ph]] += this.icmd[ph];
          if (a2[ph] >= 0) I[a2[ph]] -= this.icmd[ph];
        }
      },
      update(V, be, t) {
        const nv = n => (n < 0 ? 0 : V[n]);
        const vb = [0, 1, 2].map(ph => nv(a1[ph]) - nv(a2[ph]));
        this._vb = vb;
        this._vt = [0, 1, 2].map(ph => nv(a1[ph]));
        let Vre = 0, Vim = 0;
        for (let ph = 0; ph < 3; ph++) {
          Vre += vb[ph] * Math.sin(this.th + SHIFT[ph]);
          Vim += vb[ph] * Math.cos(this.th + SHIFT[ph]);
        }
        Vre *= Math.SQRT2 / 3; Vim *= Math.SQRT2 / 3;
        this.sumR += Vre - this.bufR[this.bidx]; this.bufR[this.bidx] = Vre;
        this.sumI += Vim - this.bufI[this.bidx]; this.bufI[this.bidx] = Vim;
        this.bidx = (this.bidx + 1) % NMA;
        if (this.bcnt < NMA) this.bcnt++;
        const Vrf = this.sumR / this.bcnt, Vif = this.sumI / this.bcnt;
        const V2m = Vrf * Vrf + Vif * Vif;
        const vwNow = (p.tgust >= 0 && t * 1000 >= p.tgust && +p.vw2 > 0) ? +p.vw2 : +p.vw;
        this.Pcmd = pOf(vwNow);
        const Qc = p.Q0 * 1000;
        let Ire = 0, Iim = 0;
        if (this.bcnt >= NMA && Math.sqrt(V2m) > vPh(p.vmin, 3)) { // UVLO + natural soft start
          Ire = (this.Pcmd * Vrf + Qc * Vif) / (3 * Math.max(V2m, 1));
          Iim = (this.Pcmd * Vif - Qc * Vrf) / (3 * Math.max(V2m, 1));
          const Im = Math.hypot(Ire, Iim);
          if (Im > p.Imax) { const sc = p.Imax / Im; Ire *= sc; Iim *= sc; } // converter current limit
        }
        // 1 ms LPF on the phasor components (cpl/pv/dcdc precedent): the
        // per-step rebuild of the injected sinusoid otherwise carries step
        // discontinuities that excite the trapezoidal Nyquist ringing of an
        // adjacent undamped RL node and self-sustain (found empirically on
        // a line-only terminal node; SPEC section 2 / section 7).
        const h = be ? dt / 2 : dt, kf = Math.min(1, h / 1e-3);
        this.Irf += kf * (Ire - this.Irf);
        this.Iif += kf * (Iim - this.Iif);
        this.th += ws * h;
        for (let ph = 0; ph < 3; ph++) {
          this.icmd[ph] = Math.SQRT2 * (this.Irf * Math.sin(this.th + SHIFT[ph]) + this.Iif * Math.cos(this.th + SHIFT[ph]));
        }
        this.i = this.icmd.slice();
        this.cur = this.i[0];
      }
    });
  });
  return arr;
}

// Transmission-grade GFL solar inverter (SPEC section 2, 3-ph mode only). A
// current-source primitive: the wt4 QSS phasor current injection, but with an
// explicit SRF-PLL (so it can follow a network that is not already at f0, the
// thing wt4's free-running clock cannot do), per-plant-rated current limit and
// voltage floor in per-unit, and a transformer-leakage Xt that sets the
// converter-voltage ceiling E_int = V + I*jXt. NO series filter branch is
// stamped (a Norton injection, absent from buildYbus's EMT stamps like wt4):
// that is precisely what avoids the Lf-C resonance that destabilised `gfm` at
// transmission scale. Generic textbook AVM only (IP screening in the business
// log): SRF-PLL (Chung 2000), classical phasor current injection, the
// voltage-reduction current-limiting family already cleared for `gfm`.
function makeGfls(topo, dt) {
  const arr = [];
  const SHIFT = [0, -2 * Math.PI / 3, 2 * Math.PI / 3];
  S.blocks.forEach(b => {
    if (b.type !== 'gfl') return;
    const p = b.params;
    const ws = 2 * Math.PI * p.f0;
    const NMA = Math.max(1, Math.round(1 / (p.f0 * dt)));
    const a1 = [0, 1, 2].map(ph => topo.gIdx(b, 0, ph));
    const a2 = [0, 1, 2].map(ph => topo.gIdx(b, 1, ph));
    // Per-plant-rated scaling (SPEC section 5 item 33): Vrated is entered per the
    // circuit's vconv convention (phase RMS or LL), so route it through vPh for
    // the per-phase value the solver actually measures. Irated is the plant's
    // rated phase current; Imax/Vfloor/Emax are per-unit on it.
    const VratedPh = vPh(p.Vrated, 3);
    const Irated = p.Sbase * 1000 / (3 * VratedPh);
    const ImaxAbs = (p.Imax != null ? +p.Imax : 1.2) * Irated;
    const VfloorAbs = (p.Vfloor != null ? +p.Vfloor : 0.5) * VratedPh;
    const EmaxAbs = (p.Emax != null ? +p.Emax : 0) * VratedPh;
    // Zbase = V_LL²/S_3ph, written from the per-phase value (V_LL² = 3·Vph²) so
    // it is convention-independent: p.Vrated itself is LL only when vconv==='ll'.
    const Zbase = (3 * VratedPh * VratedPh) / (p.Sbase * 1000); // 3-ph base, Ohm
    const XtAbs = (p.Xt != null ? +p.Xt : 0.1) * Zbase;
    // Fall back to the DEFS defaults when a param is absent (manual block
    // construction does not backfill, unlike the API's loadCircuit).
    const KpPLL = +p.KpPLL || 30, KiPLL = +p.KiPLL || 900;
    const pi = b.pfInit; // power-flow init if solved (null = cold start)
    arr.push({
      b, kind: 'gfl',
      th: pi ? pi.ang : 0, wpll: ws, integPLL: 0, fpll: p.f0,
      // Scheduled P/Q setpoint: the PF dispatch when initialized (so the run
      // holds the power flow), else the user's P0/Q0 params (kW/kvar -> W/var).
      Pcmd: pi ? pi.P : p.P0 * 1000, Qcmd: pi ? pi.Q : p.Q0 * 1000,
      bufR: new Float64Array(NMA), bufI: new Float64Array(NMA), bidx: 0, bcnt: 0, sumR: 0, sumI: 0,
      Irf: 0, Iif: 0, ff: pi ? 1 : 0, // ff = voltage-floor enable (ramps 0<->1)
      icmd: [0, 0, 0], i: [0, 0, 0], _vb: [0, 0, 0], _vt: [0, 0, 0], cur: 0,
      nEff: 3,
      // SPEC section 2 "Passive-history initialization" / section 5 item 32. gfl
      // IS in buildYbus (as a PV/PQ gen bus), so the PF solved the network WITH
      // its P injection and the surrounding branches are seeded for that current
      // — unlike wt4 (absent from buildYbus, must stay cold). So seed the PLL
      // angle to the grid voltage angle and the commanded current to the PF
      // P/Q; the voltage measurement window fills from the PF bus phasor.
      seed(c) {
        if (!b.pfInit) return false;
        const Vph = [];
        for (let ph = 0; ph < 3; ph++) { const v = c.vbr(b, ph, 1); if (!v) return false; Vph.push(v); }
        // The PLL locks to the BRANCH-voltage angle arg(vbr), not the bus angle:
        // vbr = v(term0) − v(term1) is −v(bus) under the standard term0-grounded
        // wiring (like gfm/wt4), so arg(vbr) sits π off the bus angle. Seeding th
        // to the bus angle puts the PLL at its δ = π unstable point and it
        // diverges; seeding to arg(vbr) starts it at the δ = 0 lock. This is
        // wiring-agnostic — arg(vbr) tracks whichever terminal is the bus.
        const V0 = c.vbr(b, 0, 1);
        const ang = Math.atan2(V0.im, V0.re);
        let sumR = 0, sumI = 0;
        for (let j = 0; j < NMA; j++) {
          const t = -(NMA - j) * c.dt, thT = ang + ws * t;
          let Vre = 0, Vim = 0;
          for (let ph = 0; ph < 3; ph++) {
            const vphT = c.inst(Vph[ph], t);
            Vre += vphT * Math.sin(thT + SHIFT[ph]);
            Vim += vphT * Math.cos(thT + SHIFT[ph]);
          }
          Vre *= Math.SQRT2 / 3; Vim *= Math.SQRT2 / 3;
          this.bufR[j] = Vre; this.bufI[j] = Vim;
          sumR += Vre; sumI += Vim;
        }
        this.sumR = sumR; this.sumI = sumI; this.bidx = 0; this.bcnt = NMA;
        // PLL seed = branch-voltage angle at t0 (arg + ws·t0), matching the
        // projection basis of the newest window sample (wt4 seeds its
        // free-running clock the same way).
        this.th = ang + ws * c.t0; this.wpll = ws; this.integPLL = 0;
        // Commanded current seed from the seeded boxcar (the SAME formula update
        // uses), so the first injection matches the steady-state command and
        // there is no one-step sign-flip transient. The boxcar in the arg(vbr)
        // frame is +|vbr| (real), so Irf = P/(3|V|), Iif = -Q/(3|V|).
        const Vrf0 = sumR / NMA, Vif0 = sumI / NMA, V20 = Vrf0 * Vrf0 + Vif0 * Vif0;
        const P = b.pfInit.P, Q = b.pfInit.Q;
        if (V20 > 1) {
          this.Irf = (P * Vrf0 + Q * Vif0) / (3 * V20);
          this.Iif = (P * Vif0 - Q * Vrf0) / (3 * V20);
        }
        this.ff = 1;
        for (let ph = 0; ph < 3; ph++) {
          this.icmd[ph] = Math.SQRT2 * (this.Irf * Math.sin(this.th + SHIFT[ph]) + this.Iif * Math.cos(this.th + SHIFT[ph]));
        }
        this.i = this.icmd.slice();
        return true;
      },
      inject(I) {
        for (let ph = 0; ph < 3; ph++) { // generator convention (FLOW_REVERSED)
          if (a1[ph] >= 0) I[a1[ph]] += this.icmd[ph];
          if (a2[ph] >= 0) I[a2[ph]] -= this.icmd[ph];
        }
      },
      update(V, be, t) {
        const nv = n => (n < 0 ? 0 : V[n]);
        const vb = [0, 1, 2].map(ph => nv(a1[ph]) - nv(a2[ph]));
        this._vb = vb;
        this._vt = [0, 1, 2].map(ph => nv(a1[ph]));
        // One-cycle voltage phasor (wt4 pattern), in the sine-reference frame.
        let Vre = 0, Vim = 0;
        for (let ph = 0; ph < 3; ph++) {
          Vre += vb[ph] * Math.sin(this.th + SHIFT[ph]);
          Vim += vb[ph] * Math.cos(this.th + SHIFT[ph]);
        }
        Vre *= Math.SQRT2 / 3; Vim *= Math.SQRT2 / 3;
        this.sumR += Vre - this.bufR[this.bidx]; this.bufR[this.bidx] = Vre;
        this.sumI += Vim - this.bufI[this.bidx]; this.bufI[this.bidx] = Vim;
        this.bidx = (this.bidx + 1) % NMA;
        if (this.bcnt < NMA) this.bcnt++;
        const Vrf = this.sumR / this.bcnt, Vif = this.sumI / this.bcnt;
        const V2m = Vrf * Vrf + Vif * Vif;
        const Vmag = Math.sqrt(V2m);
        const h = be ? dt / 2 : dt;
        // SRF-PLL (Chung 2000): drive the q-axis voltage to zero. The one-cycle
        // projection above puts Vhat = Vrf + j*Vif in the PLL's OWN rotating frame
        // (it projected onto sin/cos of th), so the angle of Vhat in that frame IS
        // the branch-minus-PLL error: delta = atan2(Vif, Vrf). Driving delta to
        // zero locks th to the BRANCH-voltage angle arg(vbr) (which is pi off the
        // bus angle under the standard term0-grounded wiring — see seed). Using
        // the normalised angle (not Vq itself) makes the gains voltage-independent,
        // so the same KpPLL/KiPLL hold from 4 kV to 400 kV.
        const Pf = this.Pcmd, Qf = this.Qcmd; // P0/Q0 are scheduled setpoints (kW/kvar -> W/var)
        let Ire = 0, Iim = 0;
        if (this.bcnt >= NMA && Vmag > Math.max(VfloorAbs * 0.1, 1)) {
          // PLL: freeze on a depressed bus (Vmag below the floor) so the angle
          // does not run away while V is meaningless; the floor ramp below
          // simultaneously zeroes the injection.
          if (Vmag >= VfloorAbs) {
            const delta = Math.atan2(Vif, Vrf); // branch-minus-PLL angle, rad
            // Anti-windup: the one-cycle boxcar lags a fault by up to a cycle,
            // so a voltage transient shows up as a large spurious delta. Integrate
            // ONLY inside the pull-in range (|delta| < pi/2) and clamp the
            // frequency excursion to +/-30% of w0, so a transient cannot wind the
            // integrator up to a runaway frequency (measured: without this the
            // PLL ran to ~1200 Hz on a 0.87 pu fault step). Outside the pull-in
            // range the proportional term still pulls th toward the grid; the
            // integrator recovers once the window is past the transient.
            if (Math.abs(delta) < Math.PI / 2) this.integPLL += delta * h;
            let dw = KpPLL * delta + KiPLL * this.integPLL;
            const DWMAX = 0.3 * ws;
            dw = dw > DWMAX ? DWMAX : dw < -DWMAX ? -DWMAX : dw;
            this.wpll = ws + dw;
          }
          this.th += this.wpll * h;
          // Current command (wt4 algebra): I = (P - jQ)*conj(V) / (3|V|^2).
          Ire = (Pf * Vrf + Qf * Vif) / (3 * Math.max(V2m, 1));
          Iim = (Pf * Vif - Qf * Vrf) / (3 * Math.max(V2m, 1));
        } else {
          this.th += this.wpll * h; // window filling or bus dead: coast on the last PLL state
        }
        // Hard voltage floor: ramp the injection to zero below Vfloor (the dual
        // of the constant-power-load phantom-voltage trap — cures I = P/V runaway
        // on a depressed bus). 1 ms LPF on ff so the handoff to/from injection is
        // not a step that excites trapezoidal Nyquist ringing.
        const ffTgt = (this.bcnt >= NMA && Vmag >= VfloorAbs) ? 1 : 0;
        const kfF = Math.min(1, h / 1e-3);
        this.ff += kfF * (ffTgt - this.ff);
        Ire *= this.ff; Iim *= this.ff;
        // Current limit: cap |I| at ImaxAbs (scale both components). Holds the
        // current at 1.1 to 1.2x rating through a fault.
        const Im = Math.hypot(Ire, Iim);
        if (ImaxAbs > 0 && Im > ImaxAbs) { const sc = ImaxAbs / Im; Ire *= sc; Iim *= sc; }
        // Converter-voltage ceiling (optional, Emax > 0): the internal EMF behind
        // the transformer leakage E_int = V + I*jXt must stay within the
        // converter's voltage ceiling. This is where Xt actively matters: a
        // depressed grid would otherwise demand |E_int| above the ceiling to
        // push the commanded current, so back the current off. Proportional
        // backoff (closed-form along the current direction); stable, first-order.
        if (EmaxAbs > 0 && XtAbs > 0) {
          const Eri = Vrf - XtAbs * Iim, Eii = Vim + XtAbs * Ire; // V + (Ire+jIim)*jXt
          const Em2 = Eri * Eri + Eii * Eii;
          if (Em2 > EmaxAbs * EmaxAbs) {
            const sc = EmaxAbs / Math.sqrt(Em2);
            Ire *= sc; Iim *= sc;
          }
        }
        // 1 ms LPF on the phasor components (cpl/pv/dcdc/wt4 precedent): the
        // per-step rebuild of the injected sinusoid otherwise carries step
        // discontinuities that excite the trapezoidal Nyquist ringing of an
        // adjacent undamped RL node.
        const kf = Math.min(1, h / 1e-3);
        this.Irf += kf * (Ire - this.Irf);
        this.Iif += kf * (Iim - this.Iif);
        for (let ph = 0; ph < 3; ph++) {
          this.icmd[ph] = Math.SQRT2 * (this.Irf * Math.sin(this.th + SHIFT[ph]) + this.Iif * Math.cos(this.th + SHIFT[ph]));
        }
        this.i = this.icmd.slice();
        this.cur = this.i[0];
        this.fpll = this.wpll / (2 * Math.PI);
      }
    });
  });
  return arr;
}

// SVC/STATCOM shunt compensator (SPEC section 2, 3-ph mode only).
// One-terminal reactive current injection using pq's quarter-period trick
// (a true susceptance, no 1/V² division): i_drawn = -(Iq/Vrms)·v(t-T/4).
// Integral voltage control with droop slope; SVC mode clamps B (Q~V² at
// ceiling), STATCOM mode clamps I (Q~V at ceiling).
function makeSvcs(topo, dt) {
  const arr = [];
  S.blocks.forEach(b => {
    if (b.type !== 'svc') return;
    const p = b.params;
    const NQ = Math.max(1, Math.round(1 / (4 * Math.max(1, p.f)) / dt)); // quarter-period
    const NW = Math.max(1, Math.round(1 / (Math.max(1, p.f) * dt)));     // one-cycle RMS
    const gi = [0, 1, 2].map(ph => topo.gIdx(b, 0, ph));
    arr.push({
      b, kind: 'svc', Iq: 0, cur: 0,
      qbuf: Array.from({ length: 3 }, () => new Float64Array(NQ)), qidx: 0,
      wbuf: new Float64Array(NW), sum2: 0, widx: 0, wcnt: 0,
      icmd: [0, 0, 0], i: [0, 0, 0], _vb: [0, 0, 0],
      // SPEC §2 "Measurement-window pre-fill": wbuf is a genuine one-cycle
      // boxcar (general ring-buffer rule, window left FULL, same as vsw) —
      // for a balanced 3-phase set s2 = (v0²+v1²+v2²)/3 is CONSTANT = Vrms²
      // at every instant, so every slot takes the same value. qbuf is pq's
      // quarter-period trick, seeded the same way. `Iq` itself stays cold:
      // solvePowerFlow() does not model svc's own droop (it is absent from
      // buildYbus entirely), so the PF voltage at this bus is what the
      // network holds WITHOUT the SVC's support — there is no PF-consistent
      // steady-state Iq to seed, the same reason vsw's state/dwell stay cold.
      seed(c) {
        const Vs = [];
        for (let ph = 0; ph < 3; ph++) { const v = c.term(b, 0, ph); if (!v) return false; Vs.push(v); }
        const Vrms2 = Vs[0].re * Vs[0].re + Vs[0].im * Vs[0].im;
        this.wbuf.fill(Vrms2); this.sum2 = Vrms2 * NW; this.widx = 0; this.wcnt = NW;
        for (let ph = 0; ph < 3; ph++) for (let j = 0; j < NQ; j++) this.qbuf[ph][j] = c.inst(Vs[ph], -(NQ - j) * c.dt);
        this.qidx = 0;
        return true;
      },
      inject(I) {
        for (let ph = 0; ph < 3; ph++) {
          if (gi[ph] >= 0) I[gi[ph]] -= this.icmd[ph];
        }
      },
      update(V, be) {
        const h = be ? dt / 2 : dt;
        const nv = n => (n < 0 ? 0 : V[n]);
        const v = [0, 1, 2].map(ph => nv(gi[ph]));
        this._vb = v;
        let s2 = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) / 3;
        this.sum2 += s2 - this.wbuf[this.widx]; this.wbuf[this.widx] = s2;
        this.widx = (this.widx + 1) % NW;
        if (this.wcnt < NW) this.wcnt++;
        const Vrms = Math.sqrt(Math.max(0, this.sum2) / this.wcnt);
        // integral control on Iq with droop; hard clamp per mode (SPEC §2)
        if (this.wcnt >= NW) { // hold during the start-up window ramp (vsw precedent)
          this.Iq += h * p.Ki * (vPh(p.Vref, 3) - Vrms - p.Xs * this.Iq);
          if (+p.mode === 1) this.Iq = Math.max(-p.Imax, Math.min(p.Imax, this.Iq));
          else this.Iq = Math.max(p.Bmin * Vrms, Math.min(p.Bmax * Vrms, this.Iq));
        }
        // quarter-delayed injection, one-step lag into the next inject()
        const scale = -this.Iq / Math.max(Vrms, 1);
        for (let ph = 0; ph < 3; ph++) {
          const vQ = this.qbuf[ph][this.qidx];
          this.qbuf[ph][this.qidx] = v[ph];
          this.icmd[ph] = scale * vQ;
          this.i[ph] = this.icmd[ph];
        }
        this.qidx = (this.qidx + 1) % NQ;
        this.cur = this.i[0];
      }
    });
  });
  return arr;
}

// Aggregation current-scaling coupler (SPEC section 2, 3-ph mode only):
// term 0 = real network/facility bus, term 1 = reference-unit bus (a
// small-scale sub-circuit standing in for N identical parallel replicas).
//
// A first version of this block latched last step's V(term 0) as term 1's
// Thevenin reference (the one-step-lag pattern every other Norton-injection
// block here uses: pq/cpl/pfc/batt/svc). That is unconditionally unstable
// for the large N this block exists to support: the injected N·i feeds
// back into term 0's OWN voltage, which becomes next step's reference for
// term 1, which sets i for the step after — a discrete feedback loop whose
// gain scales with N. For N in the tens of thousands (needed to reach a
// hundreds-of-MW facility from a kW-scale reference unit) that gain is
// enormously above 1 and the coupling diverges within a handful of steps,
// independent of any switching event (found by direct testing while
// building the datacenter_01 study: N=100 stable, N=50000 diverges from
// step 4). Documented as a design correction, not a revision of a shipped
// decision (never merged).
//
// Fix: stamp the SAME relationship as a real (same-step) admittance block
// instead of a lagged EMF + injection, exactly the way `xfmr` stamps its
// turns ratio — just with an ASYMMETRIC ratio (N one way, 1 the other)
// instead of xfmr's reciprocal (a, a²), since this element deliberately
// does not conserve power:
//   Y = g·[[N, −N], [−1, 1]]     (g = 1/Rf)
// i.e. term 0's diagonal gets +N·g, term 1's gets +g, and the off-diagonal
// cross terms are −N·g (row 0) and −g (row 1) — NOT equal, unlike every
// other 2-terminal stamp in this file. Solved simultaneously with
// everything else in the same linear system, so there is no delay and no
// feedback loop to go unstable: N can be arbitrarily large. (Verified
// algebraically to reduce to the same steady-state solution as the
// original lagged version, and confirmed unconditionally stable in
// testing at N up to 50000+.) Purely algebraic (no reactive part), so
// there is no CDA history term needed, unlike a real inductor/capacitor.
function makeScales(topo, dt) {
  const arr = [];
  S.blocks.forEach(b => {
    if (b.type !== 'scale') return;
    const p = b.params;
    const g = 1 / Math.max(p.Rf, 1e-6);
    const N = Math.max(p.N, 0);
    const g0 = [0, 1, 2].map(ph => topo.gIdx(b, 0, ph)); // network side
    const g1 = [0, 1, 2].map(ph => topo.gIdx(b, 1, ph)); // reference-unit side
    arr.push({
      // i = reference-unit-side current (term 1, one replica); iNet = N·i,
      // the aggregate current actually delivered onto the real network
      // (term 0) — exposed via the AUX channel since it has no separate
      // node of its own to be probed from.
      b, kind: 'scale', i: [0, 0, 0], iNet: [0, 0, 0], _vb: [0, 0, 0], cur: 0,
      stamp(M) {
        for (let ph = 0; ph < 3; ph++) {
          if (g0[ph] >= 0) M[g0[ph]][g0[ph]] += N * g;
          if (g1[ph] >= 0) M[g1[ph]][g1[ph]] += g;
          if (g0[ph] >= 0 && g1[ph] >= 0) { M[g0[ph]][g1[ph]] -= N * g; M[g1[ph]][g0[ph]] -= g; }
        }
      },
      inject() {}, // purely algebraic conductance stamp: nothing to inject
      update(V) {
        const nv = n => (n < 0 ? 0 : V[n]);
        for (let ph = 0; ph < 3; ph++) {
          this.i[ph] = g * (nv(g0[ph]) - nv(g1[ph]));
          this.iNet[ph] = N * this.i[ph];
          this._vb[ph] = nv(g1[ph]);
        }
        this.cur = this.i[0];
      }
    });
  });
  return arr;
}

// Bergeron traveling-wave line (SPEC section 2). Distributed lossless LC
// (surge impedance Z, travel time tau) + total R lumped R/4-R/2-R/4.
// The two ends are DECOUPLED in the matrix (diagonal-only 1/Zm stamps);
// they talk exclusively through tau-delayed history read from circular
// buffers with linear interpolation. Per-phase loop like the pi line.
// On CDA backward-Euler half-step pairs, samples are stored only on the
// second half-step so the buffer clock stays on the dt grid (SPEC §2).
function makeTlines(topo, dt, nph) {
  const arr = [];
  S.blocks.forEach(b => {
    if (b.type !== 'tline') return;
    const p = b.params;
    const tau = Math.max(p.tau, 0) * 1e-6;
    const Zm = p.Z + p.R / 4;
    const hh = (p.Z - p.R / 4) / Zm;
    const G = 1 / Zm;
    const cA = (1 + hh) / (2 * Zm), cB = (1 + hh) * hh / 2;
    const cC = (1 - hh) / (2 * Zm), cD = (1 - hh) * hh / 2;
    const d = tau / dt - 1; // steps back from the newest stored sample
    const k0 = Math.max(0, Math.floor(d)), fr = Math.max(0, d - k0);
    const NB = k0 + 4;
    // DC node: run ONE copy, not nph clamped-index copies (see makePiLines —
    // same July 2026 review fix; the relay's nEff pattern).
    const nEff = topo.isDC(b) ? 1 : nph;
    const i1 = [], i2 = [];
    for (let ph = 0; ph < nEff; ph++) { i1.push(topo.gIdx(b, 0, ph)); i2.push(topo.gIdx(b, 1, ph)); }
    const mkBufs = () => Array.from({ length: nEff }, () => new Float64Array(NB));
    arr.push({
      b, kind: 'tline', G, nEff,
      v1b: mkBufs(), i1b: mkBufs(), v2b: mkBufs(), i2b: mkBufs(),
      ptr: 0, _beTog: false,
      i: new Array(nEff).fill(0), i2n: new Array(nEff).fill(0),
      _vb: new Array(nEff).fill(0), cur: 0,
      stamp(M) {
        for (let ph = 0; ph < nEff; ph++) {
          if (i1[ph] >= 0) M[i1[ph]][i1[ph]] += G;
          if (i2[ph] >= 0) M[i2[ph]][i2[ph]] += G;
        }
      },
      rd(buf, ph) {
        const base = this.ptr - 1 - k0;
        const a = buf[ph][((base % NB) + NB) % NB];
        const bb = buf[ph][(((base - 1) % NB) + NB) % NB];
        return a * (1 - fr) + bb * fr;
      },
      hist(end, ph) { // end 1: local = end 1, far = end 2
        const vm = this.rd(end === 1 ? this.v2b : this.v1b, ph);
        const im = this.rd(end === 1 ? this.i2b : this.i1b, ph);
        const vk = this.rd(end === 1 ? this.v1b : this.v2b, ph);
        const ik = this.rd(end === 1 ? this.i1b : this.i2b, ph);
        return -cA * vm - cB * im - cC * vk - cD * ik;
      },
      inject(I, be) {
        for (let ph = 0; ph < nEff; ph++) {
          const h1 = this.hist(1, ph), h2 = this.hist(2, ph);
          if (i1[ph] >= 0) I[i1[ph]] -= h1;
          if (i2[ph] >= 0) I[i2[ph]] -= h2;
        }
      },
      update(V, be) {
        const nv = n => (n < 0 ? 0 : V[n]);
        let store = true;
        if (be) { this._beTog = !this._beTog; store = !this._beTog; }
        for (let ph = 0; ph < nEff; ph++) {
          const v1 = nv(i1[ph]), v2 = nv(i2[ph]);
          const c1 = v1 * G + this.hist(1, ph);
          const c2 = v2 * G + this.hist(2, ph);
          this.i[ph] = c1; this.i2n[ph] = c2;
          this._vb[ph] = v1; // sending-end node voltage: P = v·i is power INTO the line (SPEC §2)
          if (store) {
            this.v1b[ph][this.ptr % NB] = v1; this.i1b[ph][this.ptr % NB] = c1;
            this.v2b[ph][this.ptr % NB] = v2; this.i2b[ph][this.ptr % NB] = c2;
          }
        }
        if (store) this.ptr++;
        this.cur = this.i[0];
      }
    });
  });
  return arr;
}

// Frequency-dependent line, JMarti class (SPEC section 2). One-pole
// rational Zc(s) = Zh + kz/(s+pz) and delayed one-pole propagation
// H(s) = e^(-s*tau)*kh/(s+ph), Semlyen recursive convolution
// (y_n = a*y_(n-1) + b*x_n + c*x_(n-1)), Marti companion with the tline
// delay-buffer/stamp structure (diagonal-only 1/(Zh+b_z) stamps).
// Zlf = Zh and att = 1 degenerates to the Bergeron line.
function makeFdlines(topo, dt, nph) {
  const arr = [];
  const rc = (k, p2) => { // recursion coefficients for kernel k*e^(-p*t)
    const a = Math.exp(-p2 * dt), r = (1 - a) / (p2 * dt);
    return { a, b: (k / p2) * (1 - r), c: (k / p2) * (r - a) };
  };
  S.blocks.forEach(b => {
    if (b.type !== 'fdline') return;
    const p = b.params;
    const tau = Math.max(p.tau, 0) * 1e-6;
    const pz = 2 * Math.PI * Math.max(p.fz, 1), ph2 = 2 * Math.PI * Math.max(p.fh, 1);
    const Z = rc((p.Zlf - p.Zh) * pz, pz);   // Zc residue kernel
    const H = rc(Math.max(0, Math.min(1, p.att)) * ph2, ph2); // propagation kernel
    const G = 1 / (p.Zh + Z.b);
    const d = tau / dt - 1;
    const k0 = Math.max(0, Math.floor(d)), fr = Math.max(0, d - k0);
    const NB = k0 + 4;
    // DC node: run ONE copy, not nph clamped-index copies (see makePiLines —
    // same July 2026 review fix; the relay's nEff pattern).
    const nEff = topo.isDC(b) ? 1 : nph;
    const i1 = [], i2 = [];
    for (let ph = 0; ph < nEff; ph++) { i1.push(topo.gIdx(b, 0, ph)); i2.push(topo.gIdx(b, 1, ph)); }
    const zs = () => Array.from({ length: nEff }, () => 0);
    const bufs = () => Array.from({ length: nEff }, () => new Float64Array(NB));
    arr.push({
      b, kind: 'fdline', G, nEff,
      w1: zs(), w2: zs(), bs1: zs(), bs2: zs(), ip1: zs(), ip2: zs(),
      F1: bufs(), F2: bufs(), pf1: zs(), pf2: zs(), // pf = previous delayed-F reads
      rhs1: zs(), rhs2: zs(), ptr: 0, _beTog: false,
      i: new Array(nEff).fill(0), _vb: new Array(nEff).fill(0), cur: 0,
      stamp(M) {
        for (let ph2b = 0; ph2b < nEff; ph2b++) {
          if (i1[ph2b] >= 0) M[i1[ph2b]][i1[ph2b]] += G;
          if (i2[ph2b] >= 0) M[i2[ph2b]][i2[ph2b]] += G;
        }
      },
      rd(buf, ph3) {
        const base = this.ptr - 1 - k0;
        const a = buf[ph3][((base % NB) + NB) % NB];
        const bb = buf[ph3][(((base - 1) % NB) + NB) % NB];
        return a * (1 - fr) + bb * fr;
      },
      inject(I, be) {
        for (let ph3 = 0; ph3 < nEff; ph3++) {
          // propagation recursion advances here (once per doStep; CDA event
          // steps double-advance — accepted slop, SPEC §2)
          const fm1 = this.rd(this.F2, ph3), fm2 = this.rd(this.F1, ph3);
          this.bs1[ph3] = H.a * this.bs1[ph3] + H.b * fm1 + H.c * this.pf1[ph3];
          this.bs2[ph3] = H.a * this.bs2[ph3] + H.b * fm2 + H.c * this.pf2[ph3];
          this.pf1[ph3] = fm1; this.pf2[ph3] = fm2;
          this.rhs1[ph3] = Z.a * this.w1[ph3] + Z.c * this.ip1[ph3] + this.bs1[ph3];
          this.rhs2[ph3] = Z.a * this.w2[ph3] + Z.c * this.ip2[ph3] + this.bs2[ph3];
          if (i1[ph3] >= 0) I[i1[ph3]] += G * this.rhs1[ph3];
          if (i2[ph3] >= 0) I[i2[ph3]] += G * this.rhs2[ph3];
        }
      },
      update(V, be) {
        const nv = n => (n < 0 ? 0 : V[n]);
        let store = true;
        if (be) { this._beTog = !this._beTog; store = !this._beTog; }
        for (let ph3 = 0; ph3 < nEff; ph3++) {
          const v1 = nv(i1[ph3]), v2 = nv(i2[ph3]);
          const c1 = G * (v1 - this.rhs1[ph3]);
          const c2 = G * (v2 - this.rhs2[ph3]);
          this.w1[ph3] = Z.a * this.w1[ph3] + Z.b * c1 + Z.c * this.ip1[ph3];
          this.w2[ph3] = Z.a * this.w2[ph3] + Z.b * c2 + Z.c * this.ip2[ph3];
          this.ip1[ph3] = c1; this.ip2[ph3] = c2;
          this.i[ph3] = c1;
          this._vb[ph3] = v1; // sending-end node voltage (tline convention)
          if (store) {
            this.F1[ph3][this.ptr % NB] = v1 + p.Zh * c1 + this.w1[ph3];
            this.F2[ph3][this.ptr % NB] = v2 + p.Zh * c2 + this.w2[ph3];
          }
        }
        if (store) this.ptr++;
        this.cur = this.i[0];
      }
    });
  });
  return arr;
}

// Switched-shunt voltage controller (SPEC section 2). Pure one-terminal
// SENSOR (no stamp, no injection): one-cycle moving-average RMS of the
// local node voltage, hysteresis thresholds with a continuous-dwell delay,
// closes/opens a target breaker by block ID via the relay's link()
// machinery. Close deliberately clears the breaker's opened/armed latches
// (reclose allowed on this controller-driven path only, SPEC section 2).
function makeVsws(topo, dt, nph) {
  const arr = [];
  S.blocks.forEach(b => {
    if (b.type !== 'vsw') return;
    const p = b.params;
    const NW = Math.max(1, Math.round(1 / (Math.max(1, p.f) * dt)));
    const Td = Math.max(0, +p.Td) * 1e-3;
    const lim = +p.mode === 1; // limit mode: close HIGH, open LOW (reactor)
    // phList: on a lateral this sensor watches ONE phase, and its thresholds
    // are phase-to-neutral quantities (no LL/√3 divide) — see the tap
    // derivation in SPEC §2.
    const pl = topo.phList(b), nEff = pl.length;
    const nphB = (nph === 3 && topo.blockPh(b) >= 0) ? 1 : nph;
    const gi = [];
    for (let k = 0; k < nEff; k++) gi.push(topo.gIdx(b, 0, pl[k]));
    arr.push({
      b, kind: 'vsw', cur: 0, state: 0, dwell: 0, brkEls: [],
      buf: new Float64Array(NW), sum2: 0, bidx: 0, bcnt: 0,
      // SPEC §2 "Measurement-window pre-fill": a genuine one-cycle BOXCAR
      // average, not a filter, so it needs no closed-form steady state — the
      // general rule applies directly (slot j <- the value at
      // t = -(NW-j)*dt). Window left FULL (bcnt = NW) so the first real call
      // acts on the true RMS immediately instead of an artificial NW-step
      // ramp; `state`/`dwell` are untouched (cold, matching every other
      // shunt interface) since the dwell timer is real control behavior, not
      // a measurement artifact this pass exists to remove.
      seed(c) {
        const Vs = [];
        for (let k = 0; k < nEff; k++) { const v = c.term(b, 0, pl[k]); if (!v) return false; Vs.push(v); }
        let sum = 0;
        for (let j = 0; j < NW; j++) {
          const t = -(NW - j) * c.dt;
          let s2 = 0;
          for (let k = 0; k < nEff; k++) { const vk = c.inst(Vs[k], t); s2 += vk * vk; }
          s2 /= nEff;
          this.buf[j] = s2; sum += s2;
        }
        this.sum2 = sum; this.bidx = 0; this.bcnt = NW;
        return true;
      },
      link(phEls) {
        const id = Math.round(+p.brkId);
        phEls.forEach(els => els.forEach(e => {
          if (e.b.id === id && e.b.type === 'brk') this.brkEls.push(e);
        }));
      },
      inject() {},
      update(V, be, t) {
        const h = be ? dt / 2 : dt;
        const nv = n => (n < 0 ? 0 : V[n]);
        let s2 = 0;
        for (let k = 0; k < nEff; k++) { const v = nv(gi[k]); s2 += v * v; }
        s2 /= nEff;
        this.sum2 += s2 - this.buf[this.bidx]; this.buf[this.bidx] = s2;
        this.bidx = (this.bidx + 1) % NW;
        if (this.bcnt < NW) { this.bcnt++; return; } // don't act on the start-up ramp of a part-filled window
        const Vrms = Math.sqrt(Math.max(0, this.sum2) / this.bcnt);
        // want-close condition per mode; dwell must hold continuously Td
        const wantClose = lim ? Vrms > vPh(p.Von, nphB) : Vrms < vPh(p.Von, nphB);
        const wantOpen = lim ? Vrms < vPh(p.Voff, nphB) : Vrms > vPh(p.Voff, nphB);
        const want = this.state === 0 ? (wantClose ? 1 : -1) : (wantOpen ? 0 : -1);
        if (want < 0) { this.dwell = 0; return; }
        this.dwell += h;
        if (this.dwell < Td) return;
        this.dwell = 0;
        const ms = t * 1000;
        if (want === 1) {
          this.state = 1;
          this.brkEls.forEach(e => { e.opened = false; e.armed = false; e.to = -1; e.tc = ms; });
        } else {
          this.state = 0;
          this.brkEls.forEach(e => { e.to = ms; });
        }
      }
    });
  });
  return arr;
}

// Latching generation-trip relay (gtrip): one-terminal sensor that watches
// Vrms and bus frequency, trips a target breaker by block ID when any of four
// definite-time elements (59/27/81O/81U) times out. The latch is never cleared.
// SPEC section 2 "Latching generation-trip relay".
function makeGtrips(topo, dt, nph) {
  const arr = [];
  const SHIFT = [0, -2 * Math.PI / 3, 2 * Math.PI / 3];
  S.blocks.forEach(b => {
    if (b.type !== 'gtrip') return;
    const p = b.params;
    const f0 = Math.max(1, +p.f0 || 60);
    const w0 = 2 * Math.PI * f0;
    const NW = Math.max(1, Math.round(1 / (f0 * dt)));
    // Element delays
    const TdvVal = Math.max(0, +p.Tdv) * 1e-3;
    const TdfVal = Math.max(0, +p.Tdf) * 1e-3;
    // Arming delay. Real generator protection is blocked while the plant
    // energizes, because a cold-started control settling is not a grid event.
    // A PF-initialized EMT case has the same problem for the same reason: the
    // measurement states are seeded but the CONTROL states are not (see seed()
    // below), so a case with many inverters rings for a second or so before it
    // sits down. On an 11-bus Iberian case that start-up ring is 10 to 16%
    // peak-to-peak, which false-tripped four plants before the study's own
    // initiating event (studies/Spain_Blackout). 0 keeps every existing case
    // armed from t = 0, exactly as before.
    const tArm = Math.max(0, +p.tarm || 0) * 1e-3;
    // PLL gains with DEFS defaults as fallback
    const KpPLL = +p.KpPLL || 30;
    const KiPLL = +p.KiPLL || 900;
    // Hysteresis bands. isFinite (not ||) so a deliberate 0 means "no
    // hysteresis" instead of silently reverting to the default. hysV is a
    // FRACTION of pickup, hysF is ABSOLUTE in Hz: one number cannot serve both
    // (2% of 60 Hz is 1.2 Hz, wider than the range an 81 pickup lives in).
    const hysVFrac = (Number.isFinite(+p.hysV) ? +p.hysV : 2) / 100;
    const hysFVal = Number.isFinite(+p.hysF) ? +p.hysF : 0.05;
    // Lock detector threshold (rad) and its window (one cycle), SPEC section 2.
    const DLOCK = 0.02;
    // Lateral awareness (same rule as vsw)
    const pl = topo.phList(b), nEff = pl.length;
    const nphB = (nph === 3 && topo.blockPh(b) >= 0) ? 1 : nph;
    // Node voltage indices
    const gi = [];
    for (let k = 0; k < nEff; k++) gi.push(topo.gIdx(b, 0, pl[k]));
    arr.push({
      // cause: the name of the element that asserted the trip ('59', '27',
      // '81O' or '81U'), null while untripped. Same convention as zrel's
      // oosTripped: a plain field next to tripped, set at the instant the
      // latch closes, never cleared. A relay that never trips reports none.
      b, kind: 'gtrip', cur: 0, f: f0, tripped: false, cause: null, brkEls: [],
      // Vrms boxcar (shared index with PLL boxcar since both advance each step)
      buf: new Float64Array(NW), sum2: 0, bidx: 0, bcnt: 0,
      // PLL correlator boxcars (3-phase AC only)
      bufR: new Float64Array(NW), bufI: new Float64Array(NW),
      sumR: 0, sumI: 0,
      // PLL state
      th: 0, wpll: w0, integPLL: 0,
      // Lock detector
      lockCnt: 0,
      // Four definite-time elements, each with its OWN pickup latch and dwell
      // timer so one element's dropout can never reset another's accumulation
      // (SPEC section 2). `pick` 0 disables the element (the Iinst precedent);
      // `drop` is the hysteresis dropout value, precomputed per element since
      // hysV is fractional and hysF absolute. `freq` marks the two elements
      // that read f instead of Vrms and are gated on the PLL lock detector.
      els: [
        { n: '59', over: 1, freq: 0, Td: TdvVal, pick: vPh(+p.Vov, nphB), drop: vPh(+p.Vov, nphB) * (1 - hysVFrac), pu: false, dw: 0 },
        { n: '27', over: 0, freq: 0, Td: TdvVal, pick: vPh(+p.Vuv, nphB), drop: vPh(+p.Vuv, nphB) * (1 + hysVFrac), pu: false, dw: 0 },
        { n: '81O', over: 1, freq: 1, Td: TdfVal, pick: +p.Fov, drop: +p.Fov - hysFVal, pu: false, dw: 0 },
        { n: '81U', over: 0, freq: 1, Td: TdfVal, pick: +p.Fuv, drop: +p.Fuv + hysFVal, pu: false, dw: 0 }
      ],
      // Seeding (SPEC section 2): Vrms boxcar from vsw, PLL from gfl pattern
      // but node voltage instead of vbr. Measurement state seeded, control cold.
      seed(c) {
        const Vs = [];
        for (let k = 0; k < nEff; k++) { const v = c.term(b, 0, pl[k]); if (!v) return false; Vs.push(v); }
        // Vrms boxcar
        let sum = 0;
        for (let j = 0; j < NW; j++) {
          const t = -(NW - j) * c.dt;
          let s2 = 0;
          for (let k = 0; k < nEff; k++) { const vk = c.inst(Vs[k], t); s2 += vk * vk; }
          s2 /= nEff;
          this.buf[j] = s2; sum += s2;
        }
        this.sum2 = sum; this.bidx = 0; this.bcnt = NW;
        // PLL seed (3-phase AC only)
        if (nEff === 3) {
          const V0 = c.term(b, 0, pl[0]);
          const ang = Math.atan2(V0.im, V0.re);
          let sumR = 0, sumI = 0;
          for (let j = 0; j < NW; j++) {
            const t = -(NW - j) * c.dt, thT = ang + w0 * t;
            let Vre = 0, Vim = 0;
            for (let ph = 0; ph < 3; ph++) {
              const vk = c.inst(Vs[ph], t);
              Vre += vk * Math.sin(thT + SHIFT[ph]);
              Vim += vk * Math.cos(thT + SHIFT[ph]);
            }
            Vre *= Math.SQRT2 / 3; Vim *= Math.SQRT2 / 3;
            this.bufR[j] = Vre; this.bufI[j] = Vim;
            sumR += Vre; sumI += Vim;
          }
          this.sumR = sumR; this.sumI = sumI;
          // PLL state: theta at t0, integrator cold (f = f0 EXACTLY), lock valid
          this.th = ang + w0 * c.t0;
          this.integPLL = 0; this.wpll = w0;
          this.lockCnt = NW; // measurement validity, not control state
        }
        // Dwell timers and tripped stay cold
        return true;
      },
      link(phEls) { // collect the target breaker's per-phase elements (from relay)
        const id = Math.round(+p.brkId);
        phEls.forEach(els => els.forEach(e => {
          if (e.b.id === id && e.b.type === 'brk') this.brkEls.push(e);
        }));
      },
      inject() {}, // sensor: no stamp, no injection
      update(V, be, t) {
        const h = be ? dt / 2 : dt;
        const nv = n => (n < 0 ? 0 : V[n]);
        // === Vrms measurement ===
        let s2 = 0;
        for (let k = 0; k < nEff; k++) { const v = nv(gi[k]); s2 += v * v; }
        s2 /= nEff;
        this.sum2 += s2 - this.buf[this.bidx]; this.buf[this.bidx] = s2;
        this.bidx = (this.bidx + 1) % NW;
        if (this.bcnt < NW) this.bcnt++;
        const Vrms = Math.sqrt(Math.max(0, this.sum2) / this.bcnt);
        // === Frequency measurement (3-phase AC only) ===
        if (nEff === 3) {
          // Correlator: project node voltages onto PLL's own rotating frame
          let Vre = 0, Vim = 0;
          for (let ph = 0; ph < 3; ph++) {
            const v = nv(gi[ph]);
            Vre += v * Math.sin(this.th + SHIFT[ph]);
            Vim += v * Math.cos(this.th + SHIFT[ph]);
          }
          Vre *= Math.SQRT2 / 3; Vim *= Math.SQRT2 / 3;
          // One-cycle boxcar on correlator outputs (shares bidx/bcnt with Vrms)
          this.sumR += Vre - this.bufR[this.bidx]; this.bufR[this.bidx] = Vre;
          this.sumI += Vim - this.bufI[this.bidx]; this.bufI[this.bidx] = Vim;
          // PLL update (only when window full)
          if (this.bcnt >= NW) {
            // Vblk supervision (the classical 27-block-81): below the block
            // voltage the correlator angle is meaningless, so NOTHING derived
            // from it may drive the loop. Freeze the integrator AND the VCO;
            // theta coasts on the last good frequency (gfl's freeze-on-low-
            // voltage). Driving theta from a garbage delta here would leave the
            // PLL somewhere arbitrary and delay re-lock once V returns.
            const VblkEff = vPh(+p.Vblk, nphB);
            if ((+p.Vblk > 0) && Vrms < VblkEff) {
              this.lockCnt = 0;
            } else {
              const Vrf = this.sumR / this.bcnt, Vif = this.sumI / this.bcnt;
              const delta = Math.atan2(Vif, Vrf);
              if (Math.abs(delta) < Math.PI / 2) this.integPLL += delta * h;
              // Clamp the integrator STATE, not just the summed correction:
              // here the state IS the reported measurement (see below), so an
              // unclamped state would leave the reported frequency unbounded.
              const CLAMP_MAX = 0.3 * w0 / KiPLL;
              if (this.integPLL > CLAMP_MAX) this.integPLL = CLAMP_MAX;
              if (this.integPLL < -CLAMP_MAX) this.integPLL = -CLAMP_MAX;
              // VCO frequency for theta tracking (proportional + integral paths)
              let dwVco = KpPLL * delta + KiPLL * this.integPLL;
              const DWMAX = 0.3 * w0;
              if (dwVco > DWMAX) dwVco = DWMAX;
              if (dwVco < -DWMAX) dwVco = -DWMAX;
              this.wpll = w0 + dwVco;
              // Lock detector: |delta| below threshold for one continuous cycle
              if (Math.abs(delta) < DLOCK) this.lockCnt++; else this.lockCnt = 0;
            }
          }
          this.th += this.wpll * h;
          // Measurement frequency from integrator state (not VCO: prop term spikes on transients)
          const omegaMeas = w0 + KiPLL * this.integPLL;
          this.f = omegaMeas / (2 * Math.PI);
        }
        // === Decision phase (measurement keeps running after trip) ===
        if (this.tripped) return;
        if (this.bcnt < NW) return;
        // Blocked until armed. Pickup latches and dwell timers are cleared
        // rather than frozen, so an excursion that is still in progress at the
        // arming instant has to re-establish itself and serve its full definite
        // time before it can trip.
        if (t < tArm) { for (const el of this.els) { el.pu = false; el.dw = 0; } return; }
        // Frequency elements are held (latch and timer both cleared) until the
        // PLL reports a lock, and on a lateral/1-ph node where there is no PLL
        // at all. Voltage elements run everywhere.
        const locked = (nEff === 3) && (this.lockCnt >= NW);
        for (const el of this.els) {
          if (!(el.pick > 0)) continue;              // 0 threshold disables (Iinst precedent)
          if (el.freq && !locked) { el.pu = false; el.dw = 0; continue; }
          const x = el.freq ? this.f : Vrms;
          // Pickup is a LATCH with hysteresis: once picked up the element stays
          // picked up until x passes the DROPOUT value, so the timer keeps
          // running everywhere between dropout and pickup. That band IS the
          // hysteresis, and running (not freezing) through it is what stops
          // measurement ripple on a quantity parked at the threshold from
          // holding a definite-time trip off forever. Since the trip latches,
          // the band affects only the timer, never the trip itself.
          el.pu = el.pu ? (el.over ? x >= el.drop : x <= el.drop)
                        : (el.over ? x >= el.pick : x <= el.pick);
          if (!el.pu) { el.dw = 0; continue; }
          el.dw += h;
          if (el.dw >= el.Td) {
            // Latch and arm the target breaker (relay's action). Each pole then
            // clears at its own next current zero. NEVER touch tc/opened/armed:
            // that is vsw's reclose path and the exact inverse of this block.
            this.tripped = true;
            this.cause = el.n;
            const ms = t * 1000;
            this.brkEls.forEach(e => { if (e.to < 0 || e.to > ms) e.to = ms; });
            return;
          }
        }
      }
    });
  });
  return arr;
}

// PFC rectifier AVM (SPEC section 2): DC side = PI/limit Norton source into
// the DC bus (return via ground); AC side = unity-pf current sink drawing the
// DC power from the AC node, balanced 3-phase on an ordinary node or genuinely
// SINGLE-PHASE on a lateral (SPEC §2 "Single-phase PFC AC side"). Pure current
// sources — no stamp. In 1-ph MODE the AC terminal is still ignored entirely
// (abstracted stiff grid), which is a different thing from a 1-ph lateral
// inside a 3-ph run: there the AC side is really modeled.
function makePFCs(topo, dt, nph) {
  const arr = [];
  S.blocks.forEach(b => {
    if (b.type !== 'pfc') return;
    const P = b.params;
    const lat = nph === 3 && topo.blockPh(b) >= 0;   // on a single-phase lateral
    const pl = topo.phList(b);
    const ac = nph === 3 ? pl.map(ph => topo.gIdx(b, 0, ph)) : null;
    const nAC = ac ? ac.length : 0;                   // 3 normally, 1 on a lateral
    const nphB = lat ? 1 : nph;                       // a lateral is phase-to-neutral
    const dc = topo.gIdx(b, 1, 0);
    // Single-phase v² carries a 2f ripple (the 3-phase sum does not), so the
    // peak-amplitude estimate needs a ONE-CYCLE moving average — integer
    // cycles, the standing rule. `f` is absent from pre-existing files; fall
    // back to 60 Hz so they load and behave exactly as before.
    const fAC = +P.f > 0 ? +P.f : 60;
    const NW = Math.max(1, Math.round(1 / (fAC * dt)));
    arr.push({
      b, kind: 'pfc', cur: 0, integ: 0, icmd: 0, kdraw: 0, vac: new Array(Math.max(1, nAC)).fill(0),
      // 1-ph only: own frame clock + one-cycle phasor extraction (see update)
      th: 0, bufS: new Float64Array(NW), bufC: new Float64Array(NW),
      sumS: 0, sumC: 0, bidx: 0, bcnt: 0, Ire: 0, Iim: 0,
      inject(I, be) {
        if (dc >= 0) I[dc] += this.icmd;
        if (!ac) return;
        if (lat) {
          // Reconstructed sinusoid from the CURRENT phasor — deliberately not
          // a function of this step's node voltage (see the stability note in
          // update), so there is no algebraic feedback path to self-excite.
          const i1 = Math.SQRT2 * (this.Ire * Math.sin(this.th) + this.Iim * Math.cos(this.th));
          if (ac[0] >= 0) I[ac[0]] -= i1;
          return;
        }
        for (let k = 0; k < nAC; k++) {
          if (ac[k] >= 0) I[ac[k]] -= this.kdraw * this.vac[k];
        }
      },
      update(V, be, t) {
        const h = be ? dt / 2 : dt;
        const vdc = dc >= 0 ? V[dc] : 0;
        this._vb = vdc; // DC-side branch voltage, exposed for P (SPEC §3); Q doesn't apply (dc:true)
        if (ac) for (let k = 0; k < nAC; k++) this.vac[k] = ac[k] >= 0 ? V[ac[k]] : 0;
        // v2 = squared voltage magnitude used by the UV test and the draw.
        //   3-ph: (2/3)·Σ v_p² is the squared PEAK amplitude, exact and
        //   ripple-free for a balanced set, so the draw can be a plain
        //   instantaneous conductance emulation (unchanged, pre-existing path).
        //   1-ph: that identity does not exist for one phase, and emulating a
        //   resistor with a one-step-lagged current source is only stable
        //   while kdraw < the node's own companion conductance — a single
        //   phase carries 3x the kdraw of a 3-phase draw at equal power, and
        //   the node conductance 1/(R+2L/dt) SHRINKS as dt is refined, so that
        //   loop self-excites at ordinary parameters (measured: a 4 kW lateral
        //   behind 0.5 mH ran away to ±53 kV). Same failure the `im` model hit
        //   and the same fix (SPEC §2): extract the voltage PHASOR over one
        //   cycle, solve the current phasor algebraically, and inject a clean
        //   reconstructed sinusoid, which removes the algebraic feedback path.
        let v2 = 0;
        if (ac && !lat) {
          v2 = (2 / 3) * (this.vac[0] ** 2 + this.vac[1] ** 2 + this.vac[2] ** 2);
        } else if (ac) {
          // phasor convention (same as im): a signal √2·(U_re·sin θ + U_im·cos θ)
          // has phasor U_re + j·U_im, so U_re = √2·<v·sin θ> over one cycle.
          const v = this.vac[0], sn = Math.sin(this.th), cs = Math.cos(this.th);
          this.sumS += v * sn - this.bufS[this.bidx];
          this.sumC += v * cs - this.bufC[this.bidx];
          this.bufS[this.bidx] = v * sn;
          this.bufC[this.bidx] = v * cs;
          this.bidx = (this.bidx + 1) % NW;
          if (this.bcnt < NW) this.bcnt++;
          this.Vre = Math.SQRT2 * this.sumS / this.bcnt;
          this.Vim = Math.SQRT2 * this.sumC / this.bcnt;
          const vm2 = this.Vre * this.Vre + this.Vim * this.Vim; // |V|² (rms²)
          v2 = 2 * vm2; // squared peak amplitude, so the UV test below is common to both paths
        }
        const gridOK = !(P.tgrid >= 0 && t * 1000 >= P.tgrid) &&
          (!ac || Math.sqrt(v2) >= 0.5 * Math.SQRT2 * vPh(P.Vac, nphB)); // UV shutdown
        if (!gridOK) {
          this.icmd = 0; this.integ = 0; this.kdraw = 0; this.cur = 0;
          this.Ire = 0; this.Iim = 0;
          // keep the frame clock advancing while shut down, so the phasor is
          // still aligned with the grid when it recovers
          if (lat) { this.th += 2 * Math.PI * fAC * h; if (this.th > 2 * Math.PI) this.th -= 2 * Math.PI; }
          return;
        }
        const err = P.Vref - vdc;
        this.integ += P.ki * h * err;
        const raw = P.kp * err + this.integ;
        // rev=1 unlocks DC→AC export: negative icmd absorbs from the DC bus
        // and the SAME AC equation injects in-phase current (P = vdc·icmd < 0
        // makes kdraw < 0 — the unity-pf sink becomes a unity-pf source).
        this.icmd = Math.max(+P.rev === 1 ? -P.Imax : 0, Math.min(P.Imax, raw));
        this.integ += this.icmd - raw; // anti-windup back-calculation
        // AC draw: unity-pf sink carrying the DC power (one-step lag on v)
        if (ac && lat) {
          // unity-pf current phasor carrying the DC power: I = (P/|V|²)·V, so
          // I is parallel to V (unity pf) and <v·i> = P exactly.
          const vm2 = Math.max(v2 / 2, 1e-6);
          const kP = (vdc * this.icmd) / vm2;
          this.Ire = kP * this.Vre; this.Iim = kP * this.Vim;
          this.kdraw = 0;
          this.th += 2 * Math.PI * fAC * h; // self-clocked frame, CDA-aware h
          if (this.th > 2 * Math.PI) this.th -= 2 * Math.PI;
        } else {
          // kdraw·Σv² = P: 3-ph gives 2P/(3·v2) (unchanged pre-existing path)
          this.kdraw = ac && v2 > 1 ? (2 * vdc * this.icmd) / (nAC * v2) : 0;
        }
        this.cur = this.icmd;
      }
    });
  });
  return arr;
}

// Dedicated bidirectional DC/DC converter AVM (SPEC section 2): the same
// architecture as PFC (two independent Norton injections tied only by a
// lossless power-balance relationship, own _vb) but DC<->DC instead of
// AC<->DC — lets a battery sit at its own native voltage while this block
// steps it to a bus at a different level, with explicit CC/CV control (the
// classic industry charge/discharge pattern, distinct from a battery's own
// built-in Vref regulation). No stamp — the regulated side needs a
// capacitor, same requirement as pfc/batt.
function makeDCDCs(topo, dt) {
  const arr = [];
  S.blocks.forEach(b => {
    if (b.type !== 'dcdc') return;
    const P = b.params;
    const nIn = topo.gIdx(b, 0, 0), nOut = topo.gIdx(b, 1, 0);
    arr.push({
      b, kind: 'dcdc', cur: 0, integ: 0, icmdOut: 0, icmdIn: 0,
      inject(I) {
        if (nOut >= 0) I[nOut] += this.icmdOut;
        if (nIn >= 0) I[nIn] -= this.icmdIn;
      },
      update(V, be) {
        const h = be ? dt / 2 : dt;
        const vOut = nOut >= 0 ? V[nOut] : 0, vIn = nIn >= 0 ? V[nIn] : 0;
        this._vb = vOut; // regulated-side branch voltage, exposed for P (SPEC §3); Q doesn't apply (dc:true)
        if (+P.mode === 1) { // CC: dispatch a fixed output current directly — no PI, it's not regulating a state
          this.icmdOut = Math.max(-P.Imax, Math.min(P.Imax, P.I0));
        } else { // CV: PI regulates OUT to Vref (identical structure to pfc/batt)
          const err = P.Vref - vOut;
          this.integ += P.ki * h * err;
          const raw = P.kp * err + this.integ;
          this.icmdOut = Math.max(-P.Imax, Math.min(P.Imax, raw));
          this.integ += this.icmdOut - raw; // anti-windup back-calculation
        }
        // lossless power balance: whatever leaves OUT must enter IN. Same
        // negative-incremental-conductance shape as CPL (P/v draw) — without
        // CPL's own 1 ms LPF this can lock into a spurious low-voltage,
        // both-sides-current-limited equilibrium during the startup
        // transient (found by testing: OUT's PI reaches Vref in a handful of
        // steps while IN's cap is still near 0 V, so the derived IN current
        // instantly clips at Imax and stays there rather than easing off as
        // vIn recovers). Reuse CPL's exact fix.
        const pOut = this.icmdOut * vOut;
        const tgt = Math.max(-P.Imax, Math.min(P.Imax, pOut / (vIn || 1e-6)));
        this.icmdIn += Math.min(1, h / 1e-3) * (tgt - this.icmdIn); // 1 ms LPF
        this.cur = this.icmdOut;
      }
    });
  });
  return arr;
}

// PI (nominal π) equivalent line AVM (SPEC section 2): the same series R+L
// companion as the plain 'line' block, PLUS two independent shunt caps
// (C/2 each, standard π split) to ground at each end. Needs its own
// stamp() — the generic per-phase stamper only supports one reciprocal
// 2-terminal conductance, with no way to add independent shunt terms at
// n1/n2 individually — so this is a spanning element (own diagonal-only
// shunt stamps alongside the series cross terms), looped per phase
// (0..nph-1, NOT hardcoded to 3 like coupled lines — this works in both
// 1-ph and 3-ph mode, since there's no mutual coupling between phases to
// model, just independent per-phase R+L+shunt-C). Exposes the SERIES
// current/voltage as its plotted signal (`.i`/`.v`), exactly matching what
// the plain 'line' block already plots — shunt charging currents aren't
// separately exposed (SPEC §7).
function makePiLines(topo, dt, nph) {
  const arr = [];
  S.blocks.forEach(b => {
    if (!isPiLine(b)) return;
    // On a DC network every phase index clamps onto the node's single unknown
    // (gIdx), so a ph=0..nph-1 loop would stamp the SAME line nph times in
    // parallel (R/3, C×3 at nph=3) — silently wrong by 3x, found in the July
    // 2026 solver review. Run ONE copy on DC instead (relay's nEff pattern).
    const nEff = topo.isDC(b) ? 1 : nph;
    const Lh = b.params.L * 1e-3;
    const Gs = 1 / (b.params.R + 2 * Lh / dt);
    const k2 = b.params.R - 2 * Lh / dt, kL = 2 * Lh / dt;
    const Chalf = (b.params.C * 1e-6) / 2;
    const Gc = 2 * Chalf / dt; // same trapezoidal-cap companion as the 'cap' block, halved C
    const i1 = [], i2 = [];
    for (let p = 0; p < nEff; p++) { i1.push(topo.gIdx(b, 0, p)); i2.push(topo.gIdx(b, 1, p)); }
    arr.push({
      b, kind: 'pline', Gs, Gc, nEff,
      v: new Array(nEff).fill(0), i: new Array(nEff).fill(0), // series (plotted signal)
      _vt: new Array(nEff).fill(0), // terminal-0 node voltage, for through-power (SPEC §3)
      vS1: new Array(nEff).fill(0), iS1: new Array(nEff).fill(0), // shunt @ n1
      vS2: new Array(nEff).fill(0), iS2: new Array(nEff).fill(0), // shunt @ n2
      // SPEC §2 "Passive-history initialization": a PI line is `line` (series
      // RL, Y = 1/(R+jωL)) plus two shunt half-caps. The series register seeds
      // exactly like `line` on the branch voltage; each shunt seeds like `cap`
      // but on its own terminal's NODE voltage (not the branch voltage), using
      // the same halved Chalf the companion stamps with.
      seed(c) {
        const V0 = [], V1 = [];
        for (let p = 0; p < nEff; p++) {
          const a = c.term(b, 0, p), d = c.term(b, 1, p);
          if (!a || !d) return false;
          V0.push(a); V1.push(d);
        }
        const Yb = c.yRL(b.params.R, Lh);
        const Yc = { re: 0, im: c.w * Chalf };
        for (let p = 0; p < nEff; p++) {
          const Vb = c.sub(V0[p], V1[p]);
          this.v[p] = c.inst(Vb, c.t0);
          this.i[p] = c.inst(c.mul(Yb, Vb), c.t0);
          this.vS1[p] = c.inst(V0[p], c.t0);
          this.iS1[p] = c.inst(c.mul(Yc, V0[p]), c.t0);
          this.vS2[p] = c.inst(V1[p], c.t0);
          this.iS2[p] = c.inst(c.mul(Yc, V1[p]), c.t0);
        }
        return true;
      },
      stamp(M) {
        for (let p = 0; p < nEff; p++) {
          if (i1[p] >= 0) M[i1[p]][i1[p]] += Gs + Gc;
          if (i2[p] >= 0) M[i2[p]][i2[p]] += Gs + Gc;
          if (i1[p] >= 0 && i2[p] >= 0) { M[i1[p]][i2[p]] -= Gs; M[i2[p]][i1[p]] -= Gs; }
        }
      },
      ihSeries(p, be) { return (be ? this.i[p] * kL : this.v[p] - this.i[p] * k2) * Gs; },
      ihShunt(v, i, be) { return be ? -v * Gc : -(v * Gc + i); }, // same form as 'cap'
      inject(I, be) {
        for (let p = 0; p < nEff; p++) {
          const IhS = this.ihSeries(p, be);
          const Ih1 = this.ihShunt(this.vS1[p], this.iS1[p], be);
          const Ih2 = this.ihShunt(this.vS2[p], this.iS2[p], be);
          if (i1[p] >= 0) I[i1[p]] -= IhS + Ih1;
          if (i2[p] >= 0) I[i2[p]] += IhS - Ih2;
        }
      },
      update(V, be) {
        const nv = n => (n < 0 ? 0 : V[n]);
        for (let p = 0; p < nEff; p++) {
          const v1 = nv(i1[p]), v2 = nv(i2[p]), vb = v1 - v2;
          const IhS = this.ihSeries(p, be);
          this.i[p] = vb * Gs + IhS; this.v[p] = vb;
          this._vt[p] = v1; // terminal-0 node voltage, for through-power (SPEC §3)
          this.iS1[p] = v1 * Gc + this.ihShunt(this.vS1[p], this.iS1[p], be); this.vS1[p] = v1;
          this.iS2[p] = v2 * Gc + this.ihShunt(this.vS2[p], this.iS2[p], be); this.vS2[p] = v2;
        }
      }
    });
  });
  return arr;
}

// One element per coupled line block; state spans all three phases.
// i_n = Geq·v_n + Ih,  Ih = Geq·(v_prev − K2·i_prev)
function makeCoupledLines(topo, dt) {
  const arr = [];
  S.blocks.forEach(b => {
    if (!isCoupled(b) || topo.isDC(b)) return; // DC lines fall back to plain RL
    const Ls = b.params.L * 1e-3, Lm = (b.params.Lm || 0) * 1e-3, Rm = b.params.Rm || 0;
    const Geq = inv3(sym3(b.params.R + 2 * Ls / dt, Rm + 2 * Lm / dt));
    const K2 = sym3(b.params.R - 2 * Ls / dt, Rm - 2 * Lm / dt);
    const L2 = sym3(2 * Ls / dt, 2 * Lm / dt);
    const i1 = [0, 1, 2].map(p => topo.gIdx(b, 0, p));
    const i2 = [0, 1, 2].map(p => topo.gIdx(b, 1, p));
    arr.push({
      b, kind: 'cline', Geq,
      v: [0, 0, 0], i: [0, 0, 0],
      // SPEC §2 "Passive-history initialization". The steady state of this
      // branch is Ī = Z⁻¹·V̄b with Z = sym3(R + jωLs, Rm + jωLm). A symmetric
      // 3x3 with equal diagonals A and equal off-diagonals B has exactly two
      // distinct eigenvalues — Z0 = A + 2B on the [1,1,1] direction and
      // Z1 = A − B on the plane orthogonal to it — so its inverse is available
      // in closed form without any complex matrix code:
      //     Z⁻¹x = (x − x̄·1)/Z1 + (x̄·1)/Z0,   x̄ = mean(x).
      // The power flow is positive-sequence, so V̄b is a balanced set, x̄ is 0,
      // and only Z1 acts (which is the same z1 = zs − zm buildYbus stamps for
      // this block). The zero-sequence term is written anyway: it costs one
      // line and keeps the hook correct rather than accidentally correct.
      seed(c) {
        const A = { re: b.params.R, im: c.w * Ls }, B = { re: Rm, im: c.w * Lm };
        const Z1 = c.sub(A, B), Z0 = c.add(A, c.scale(B, 2));
        const V = [];
        for (let p = 0; p < 3; p++) { const x = c.vbr(b, p, 1); if (!x) return false; V.push(x); }
        const avg = c.scale(V.reduce((s, x) => c.add(s, x), { re: 0, im: 0 }), 1 / 3);
        const I = V.map(x => c.add(c.div(c.sub(x, avg), Z1), c.div(avg, Z0)));
        this.v = V.map(x => c.inst(x, c.t0));
        this.i = I.map(x => c.inst(x, c.t0));
        return true;
      },
      stamp(M) {
        for (let p = 0; p < 3; p++) for (let q = 0; q < 3; q++) {
          const g = Geq[p][q];
          if (i1[p] >= 0 && i1[q] >= 0) M[i1[p]][i1[q]] += g;
          if (i2[p] >= 0 && i2[q] >= 0) M[i2[p]][i2[q]] += g;
          if (i1[p] >= 0 && i2[q] >= 0) M[i1[p]][i2[q]] -= g;
          if (i2[p] >= 0 && i1[q] >= 0) M[i2[p]][i1[q]] -= g;
        }
      },
      ih(be) {
        if (be) return mv3(Geq, mv3(L2, this.i)); // CDA half-step (SPEC section 2)
        const w = mv3(K2, this.i);
        return mv3(Geq, [this.v[0] - w[0], this.v[1] - w[1], this.v[2] - w[2]]);
      },
      inject(I, be) {
        const Ih = this.ih(be);
        for (let p = 0; p < 3; p++) {
          if (i1[p] >= 0) I[i1[p]] -= Ih[p];
          if (i2[p] >= 0) I[i2[p]] += Ih[p];
        }
      },
      update(V, be) {
        const nv = n => (n < 0 ? 0 : V[n]);
        const vb = [0, 1, 2].map(p => nv(i1[p]) - nv(i2[p]));
        const Ih = this.ih(be), gv = mv3(Geq, vb);
        this.i = [gv[0] + Ih[0], gv[1] + Ih[1], gv[2] + Ih[2]];
        this.v = vb;
        this._vt = [0, 1, 2].map(p => nv(i1[p])); // terminal-0 node voltage, for through-power (SPEC §3)
      }
    });
  });
  return arr;
}
