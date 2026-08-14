// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Hiva Nasiri. Commercial licensing: see LICENSING.md
// ui.js — schematic canvas, interaction, property panel, plots.
// Styling rule (SPEC section 1): fully self-contained. All colors come from the
// .emt scope variables resolved via css() — never from host-page variables.

const S = { blocks: [], wires: [], sel: [], wireFrom: null, nextId: 1 };
const COLORS = ['#2a78d6', '#d99114', '#7a6fdd', '#1baf7a', '#d85a30', '#d4537e'];
const cnv = document.getElementById('cnv');
const css = n => getComputedStyle(document.querySelector('.emt')).getPropertyValue(n).trim();

// ---- undo/redo: whole-state snapshots (blocks+wires+plots), same shape as
// saveCircuit's JSON — simplest correct approach given how small a circuit's
// state is; no per-action command objects to keep in sync as features grow.
// Call pushHistory() BEFORE any user-driven mutation (captures the state to
// return to); a fresh action always clears the redo stack. Drag is the one
// exception — it mutates on every pointermove, so its snapshot is taken once
// at drag-start and only committed to history at drag-end if something moved
// (see the 'block' pointerdown/pointerup handlers below), instead of calling
// pushHistory() on every intermediate frame.
let history = [], future = [];
const HISTORY_MAX = 50;
function snapshot() { return JSON.parse(JSON.stringify({ blocks: S.blocks, wires: S.wires, plots: S.plots, vconv: S.vconv })); }
function pushHistory(snap) {
  history.push(snap || snapshot());
  if (history.length > HISTORY_MAX) history.shift();
  future = [];
  updateUndoButtons();
  setProj(null, true); // any user-driven mutation marks the loaded circuit dirty
}

// ---- project-name indicator (badge above the canvas, next to the status
// line): shows which file is loaded; "•" = modified since load/save. Not part
// of undo state — undoing an edit doesn't promise the file matches again.
let projName = 'Demo';
function setProj(name, dirty) {
  if (name != null) projName = name;
  const el = document.getElementById('projname');
  if (el) el.textContent = projName + (dirty ? ' •' : '');
}
function restoreSnapshot(snap) {
  touchModel(); // undo/redo can restore any topology or parameter change
  S.blocks = snap.blocks; S.wires = snap.wires; S.plots = snap.plots;
  yZoom = {}; // plot objects are replaced wholesale — a range kept by id would land on a different plot
  S.vconv = (snap.vconv === 'll') ? 'll' : 'ph'; // absent (old snapshots) => 'ph'
  S.sel = []; S.wireFrom = null; selWire = null;
  S.nextId = S.blocks.reduce((m, b) => Math.max(m, b.id), 0) + 1;
  initPlots();
  nextPlotId = S.plots.reduce((m, p) => Math.max(m, p.id), 0) + 1;
  syncVconvUI(); render(); showProps(); renderPlots(); updateUndoButtons();
}
function undo() {
  if (!history.length) return;
  future.push(snapshot());
  restoreSnapshot(history.pop());
}
function redo() {
  if (!future.length) return;
  history.push(snapshot());
  restoreSnapshot(future.pop());
}
function updateUndoButtons() {
  const u = document.getElementById('undobtn'), r = document.getElementById('redobtn');
  if (u) u.disabled = !history.length;
  if (r) r.disabled = !future.length;
}

// ---- pan/zoom: the SVG viewBox IS the camera; block coordinates never
// change, only which rectangle of "world space" is visible. Aspect ratio
// is locked to the original 680x340 so blocks never look stretched.
const VIEW0 = { x: 0, y: 0, w: 680, h: 340 };
const view = { ...VIEW0 };
const ZMIN = 120, ZMAX = 4000; // world-units-wide clamp: max zoom-in / default max zoom-out
const ZPAD = 1000; // world-units of empty margin allowed around the circuit when fully zoomed out
// Largest allowed view width. For big meshed circuits (IEEE39) the fixed ZMAX
// wasn't enough to fit the whole thing on screen, so the zoom-out cap tracks
// the actual circuit extent plus a ZPAD margin on every side (never smaller
// than ZMAX, so small circuits behave exactly as before).
function maxViewW() {
  if (!S.blocks.length) return ZMAX;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  S.blocks.forEach(b => { const d = getDims(b);
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + d.w); y1 = Math.max(y1, b.y + d.h); });
  const asp = viewAspect();
  const bw = (x1 - x0) + 2 * ZPAD, bh = (y1 - y0) + 2 * ZPAD;
  return Math.max(ZMAX, bw, bh / asp);
}

// Where a new block lands when the caller does not say (palette click, as
// opposed to a drag that carries a drop point). It used to be a random spot in
// a FIXED world-space box, 60..440 x 50..230, which has nothing to do with
// where the camera is: pan out to IEEE39's far side and the new block appears
// thousands of units off-screen with no indication it was created at all. The
// view IS the camera (see the pan/zoom note above), so the visible centre in
// world coordinates is view.x + view.w/2, view.y + view.h/2. Place there,
// centred on the block's own footprint, and step aside if that spot is taken.
function freeSpotInView(type) {
  const d = getDims({ type, params: defaultParams(type) });
  const cx = view.x + view.w / 2 - d.w / 2, cy = view.y + view.h / 2 - d.h / 2;
  const clash = (x, y) => S.blocks.some(o => {
    const od = getDims(o);
    return Math.abs((o.x || 0) - x) < (od.w + d.w) / 2 && Math.abs((o.y || 0) - y) < (od.h + d.h) / 2;
  });
  if (!clash(cx, cy)) return { x: cx, y: cy };
  // Outward square-ish walk, stepping by a block footprint each ring, so a
  // repeated palette click lays blocks out near the centre instead of stacking.
  const sx = d.w + 24, sy = d.h + 24;
  for (let ring = 1; ring <= 6; ring++)
    for (let dy = -ring; dy <= ring; dy++)
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue; // perimeter only
        const x = cx + dx * sx, y = cy + dy * sy;
        if (!clash(x, y)) return { x, y };
      }
  return { x: cx, y: cy }; // crowded view: overlap rather than fling it far away
}
function addBlock(type, x, y) {
  const d = DEFS[type];
  const spot = (x == null || y == null) ? freeSpotInView(type) : null;
  const b = {
    id: S.nextId++, type,
    x: x ?? spot.x,
    y: y ?? spot.y,
    rot: 0,
    params: Object.fromEntries(Object.entries(d.params).map(([k, p]) => [k, p.v]))
  };
  // DEFS defaults are phase values; in LL mode a freshly placed block should
  // default to its LL equivalent (e.g. src 277 ph -> 480 LL), not a phase
  // number that would then be read as LL.
  if (S.vconv === 'll') scaleVconvParams(b, SQRT3);
  pushHistory(); touchModel(); S.blocks.push(b);
  // Select it. At a zoomed-out view the centre of the screen is still a lot of
  // pixels, so highlighting the new block (and opening its params rail) is what
  // actually answers "where did it go?".
  S.sel = [b.id]; selWire = null;
  render(); showProps(); return b;
}
// Default params for a type: the same extraction addBlock uses, factored out so
// paletteThumb and the palette-drag ghost can build a synthetic block without
// duplicating the Object.fromEntries loop a third time.
function defaultParams(type) {
  return Object.fromEntries(Object.entries(DEFS[type].params).map(([k, p]) => [k, p.v]));
}
// Palette thumbnail: the SAME IEC symbol the canvas draws (blockSymbol), fed a
// synthetic block at the origin with default params, rendered into a mini SVG.
// One art path, reused: the learner sees exactly what will land on the canvas.
// Colors are passed as CSS-var refs (var(--bds), ...) so the thumbnail follows
// the light/dark theme like the canvas, with no css() calls at palette-build
// time. blockSymbol's midline fallback (terms[0] ? ... : d.h/2) makes this safe
// for 'bus' (DEFS.bus.terms is empty); all other types have terms and render
// normally. Runs only on user interaction, never at headless load.
function paletteThumb(type) {
  const b = { id: -1, type, x: 0, y: 0, rot: 0, params: defaultParams(type) };
  const dims = getDims(b); // bus width tracks its default len param
  const v = (n) => 'var(' + n + ')';
  // Category color, same as the canvas draws it (BLOCK_CAT/CAT_COLORS below):
  // the thumbnail is a preview, so it must carry the color too.
  const body = blockSymbol(b, dims, blockColor(type, v('--bds')), 1.5, v('--sfc'), v('--tx'), v('--tx3'));
  return '<svg class="palthumb" viewBox="0 0 ' + dims.w + ' ' + dims.h + '">' + body + '</svg>';
}
// ---- palette categories. The Library drawer is the ONE place blocks are
// browsed (July 2026): the toolbar's per-category flyout was removed because
// it showed one category at a time, at the top of the page, while the drawer
// already showed all of them beside the canvas. With no flyout competing for
// toolbar width, the categories no longer have to be few — they are grouped by
// FUNCTION (what a block does in the network), which is how a power engineer
// looks for one, rather than merged to keep a button row short.
const PAL_CATS = {
  src: [['src', 'AC Src'], ['syncgen', 'Sync Gen'], ['gfm', 'GFM Inv'], ['gfl', 'GFL Solar'], ['wt4', 'Wind T4'], ['pv', 'PV'], ['batt', 'Batt']],
  load: [['pq', 'AC PQ'], ['zip', 'ZIP Load'], ['im', 'Ind Motor'], ['cpl', 'DC CPL']],
  pas: [['line', 'Line'], ['tline', 'TW Line'], ['fdline', 'FD Line'], ['cap', 'Cap'], ['rlc', 'Series RLC'], ['rlcp', 'Parallel RLC'], ['xfmr', 'Xfmr'], ['xfmr3', 'Xfmr 3ph'], ['xfmr3w', 'Xfmr 3W'], ['tap', 'Ph Tap'], ['scale', 'Scale']],
  pe: [['pfc', 'PFC'], ['dcdc', 'DC/DC'], ['hvdc', 'HVDC'], ['svc', 'SVC']],
  prot: [['brk', 'Brk'], ['relay', 'OC Relay'], ['zrel', 'Dist Relay'], ['gtrip', 'Gen Trip'], ['vsw', 'Shunt Ctl'], ['mov', 'Arrester'], ['fault', 'Fault']],
  meas: [['bus', 'Bus'], ['gnd', 'GND'], ['probe', 'V probe']]
};
// Category display labels, used as the Library group headers.
const PAL_CAT_LABELS = { src: 'Sources', load: 'Loads', pas: 'Passive', pe: 'Power Electronics', prot: 'Protection', meas: 'Measurement' };
// Build the left Library drawer once at load: every category as a collapsible
// <details> group, each item the SAME .palitem markup the flyout uses, so
// attachPalItemDrag works on both without specialization. DEFS is static, so
// the drawer is built once and shown/hidden by the .emt.lib class (toggleLibrary).
function buildLibrary() {
  const el = document.getElementById('library');
  if (!el) return;
  el.innerHTML = Object.entries(PAL_CATS).map(([cat, list]) =>
    '<details class="libgroup" open><summary>' + PAL_CAT_LABELS[cat] + '</summary><div class="libitems">'
    + list.map(([type, label]) =>
      '<button class="palitem" data-type="' + type + '">' + paletteThumb(type) + '<span>' + label + '</span></button>').join('')
    + '</div></details>').join('');
  attachPalItemDrag(el);
}
// Inverse lookup (type -> category) plus a color per category. The whole SYMBOL
// is drawn in its category's color (render(), and the Library thumbnails), so a
// dense circuit is scannable by function at a glance — replacing the small
// corner tick this started as (July 2026), which carried the same information
// in too small a mark to read. Colors are 5 of COLORS' existing 6 plot-series
// hues, skipping index 0 (it equals --acc and would be confused with the
// selection highlight). Measurement blocks map to null deliberately: bus /
// ground / probe are not apparatus, they are annotations on the circuit, and
// keeping them the default outline color is what lets the colored blocks read
// as "things that do something".
const BLOCK_CAT = {};
Object.entries(PAL_CATS).forEach(([cat, list]) => list.forEach(([type]) => { BLOCK_CAT[type] = cat; }));
const CAT_COLORS = { src: COLORS[1], load: COLORS[5], pas: COLORS[2], pe: COLORS[3], prot: COLORS[4], meas: null };
function blockColor(type, fallback) { return CAT_COLORS[BLOCK_CAT[type]] || fallback; }
// Palette drag-and-drop: press a thumbnail and drag it onto the canvas to drop
// the block at the cursor. A press that releases without moving is a plain
// click and places a block at the default spot, as before. The press starts on
// a .palitem OUTSIDE cnv, so cnv's own pointerdown never fires; the captured
// button receives move/up instead, and svgPt() (which only needs clientX/
// clientY plus cnv's rect) converts to world coords. Reuses addBlock() so
// LL-default scaling and history still apply. Click-to-place is handled here
// (not via onclick) because preventDefault on pointerdown makes the click
// event unreliable across browsers; owning both paths in pointerup is
// deterministic and avoids a double-add. Bound once, to the Library drawer
// (#library); it was shared with the toolbar flyout until that was removed.
function attachPalItemDrag(el) {
  if (!el) return;
  el.addEventListener('pointerdown', e => {
    const btn = e.target.closest('.palitem');
    if (!btn) return;
    e.preventDefault();
    drag = { type: 'palette', blockType: btn.dataset.type, sx: e.clientX, sy: e.clientY, moved: false, world: null };
    btn.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', e => {
    if (!drag || drag.type !== 'palette') return;
    if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 3) drag.moved = true;
    if (!drag.moved) return;
    const r = cnv.getBoundingClientRect();
    if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom)
      drag.world = svgPt(e); // only track while the cursor is over the canvas
    render(); // ghost follows the cursor (see the palette-drag branch in render)
  });
  el.addEventListener('pointerup', () => {
    if (!drag || drag.type !== 'palette') return;
    const t = drag.blockType;
    if (drag.moved && drag.world) {
      const d = getDims({ type: t, params: defaultParams(t) });
      addBlock(t, drag.world.x - d.w / 2, drag.world.y - d.h / 2); // center block on cursor
    } else if (!drag.moved) {
      addBlock(t); // plain click: default position, same as pre-drag behavior
    } // moved but never reached the canvas: cancel, no block, no history entry
    drag = null; render();
  });
}
// Bounding box for one block instance: static for every type except 'bus',
// whose width tracks its 'len' param (SPEC section 1 — see getTerms()).
function getDims(b) { return b.type === 'bus' ? { w: Math.max(40, b.params.len || 160), h: DEFS.bus.h } : DEFS[b.type]; }
// Rotation pivots on the block's own bounding-box center; terminal world
// position is the unrotated offset rotated by the same angle the <g> gets
// (SVG rotate() is clockwise for positive degrees — matches the R shortcut).
function blockCenter(b) { const d = getDims(b); return [b.x + d.w / 2, b.y + d.h / 2]; }
function rotPt(x, y, cx, cy, deg) {
  if (!deg) return [x, y];
  const r = deg * Math.PI / 180, cos = Math.cos(r), sin = Math.sin(r);
  return [cx + (x - cx) * cos - (y - cy) * sin, cy + (x - cx) * sin + (y - cy) * cos];
}
function termPos(b, ti) {
  const t = getTerms(b)[ti];
  const [cx, cy] = blockCenter(b);
  return rotPt(b.x + t[0], b.y + t[1], cx, cy, b.rot || 0);
}
function escAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function rotateSelected() {
  if (!S.sel.length) return;
  pushHistory();
  S.blocks.forEach(b => { if (S.sel.includes(b.id)) b.rot = ((b.rot || 0) + 90) % 360; });
  render(); showProps();
}
document.addEventListener('keydown', e => {
  const tag = (e.target.tagName || '').toLowerCase();
  // Escape closes the numerics popover BEFORE the typing guard below, because
  // the popover contains number inputs: checking after it would make Escape
  // dead exactly when the focus is inside the thing you want to dismiss.
  if (e.key === 'Escape') {
    const pop = document.getElementById('simadv');
    if (pop && pop.style.display !== 'none') { e.preventDefault(); closeSimAdv(); return; }
  }
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return; // don't hijack typing
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (e.ctrlKey || e.metaKey) {
    const k = e.key.toLowerCase();
    // Ctrl+S is the one every editor has and this one did not, on an app that
    // can lose an afternoon's work to a stray Ctrl+W.
    if (k === 's') { e.preventDefault(); saveCircuit(); return; }
    if (k === 'c') { e.preventDefault(); copySelection(false); return; }
    if (k === 'x') { e.preventDefault(); copySelection(true); return; }
    if (k === 'v') { e.preventDefault(); pasteClipboard(); return; }
    if (k === 'd') { e.preventDefault(); duplicateSelection(); return; }
    if (k === 'a') { e.preventDefault(); selectAllBlocks(); return; }
  }
  if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); focusFind(); return; }
  if (e.key.startsWith('Arrow') && S.sel.length) {
    const step = e.shiftKey ? 10 : 1;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (d) { e.preventDefault(); nudgeSelection(d[0], d[1]); return; }
  }
  if (e.key.toLowerCase() === 'r' && S.sel.length) { e.preventDefault(); rotateSelected(); return; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && S.sel.length) { e.preventDefault(); delSelected(); return; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && selWire != null) { e.preventDefault(); delSelectedWire(); return; }
  if (e.key === 'Escape' && (S.sel.length || selWire != null)) { S.sel = []; selWire = null; render(); showProps(); }
});

function render() {
  cnv.setAttribute('viewBox', view.x + ' ' + view.y + ' ' + view.w + ' ' + view.h);
  const sfc = css('--sfc'), bds = css('--bds'), tx = css('--tx'), tx3 = css('--tx3'), acc = css('--acc');
  const flowEl = document.getElementById('flowtoggle');
  const flowOn = !flowEl || flowEl.checked; // missing element (old cached page) defaults to on
  let h = '';
  const findSet = findHits.length ? new Set(findHits) : null;
  // Blocks at the ends of the selected wire, highlighted with it (see selWire).
  const wireEndHi = new Set();
  if (selWire != null && S.wires[selWire]) { wireEndHi.add(S.wires[selWire].a[0]); wireEndHi.add(S.wires[selWire].b[0]); }
  S.wires.forEach((w, i) => {
    const a = S.blocks.find(b => b.id === w.a[0]), bb = S.blocks.find(b => b.id === w.b[0]);
    if (!a || !bb) return;
    const p1 = termPos(a, w.a[1]), p2 = termPos(bb, w.b[1]);
    const mx = (p1[0] + p2[0]) / 2;
    const wsel = i === selWire;
    h += '<path d="M' + p1[0] + ' ' + p1[1] + ' L' + mx + ' ' + p1[1] + ' L' + mx + ' ' + p2[1] +
      ' L' + p2[0] + ' ' + p2[1] + '" fill="none" stroke="' + (wsel ? acc : bds) +
      '" stroke-width="' + (wsel ? 3.2 : 1.6) + '" data-wire="' + i + '" style="cursor:pointer"/>';
    if (wsel) { // end markers: which two terminals this wire actually ties together
      h += '<circle cx="' + p1[0] + '" cy="' + p1[1] + '" r="4" fill="' + acc + '"/>'
        + '<circle cx="' + p2[0] + '" cy="' + p2[1] + '" r="4" fill="' + acc + '"/>';
    }
    if (!flowOn) return;
    // power-flow arrows (SPEC §3, July 2026): 2 marching HALF-arrowheads per
    // quantity, riding the wire's own Manhattan path (no offset track needed)
    //: P's marker is only the upper half of a full arrowhead (flat edge on
    // the centerline, point forward), sitting visually "above" the wire; Q's
    // is the mirrored lower half, sitting "below" it. wireFlow[i]/wireFlowQ[i]
    // undefined = no meaningful flow (unrun circuit, near-zero power, or an
    // endpoint we can't attribute): no marker, wire renders exactly as
    // before. P and Q are independent (an AC branch carries both at once,
    // and they can point opposite ways: e.g. a capacitive branch exports Q
    // while still importing P), never a shared "one arrow, two colors."
    const flowPath = (ps, pe) => 'M' + ps[0] + ' ' + ps[1] + ' L' + mx + ' ' + ps[1] + ' L' + mx + ' ' + pe[1] + ' L' + pe[0] + ' ' + pe[1];
    const marker = (dirMap, color, points) => {
      if (dirMap[i] === undefined) return;
      const [ps, pe] = dirMap[i] ? [p2, p1] : [p1, p2];
      const fd = flowPath(ps, pe);
      h += '<g fill="' + color + '">'
        + '<polygon points="' + points + '"><animateMotion dur="1.4s" begin="0s" repeatCount="indefinite" rotate="auto" path="' + fd + '"/></polygon>'
        + '<polygon points="' + points + '"><animateMotion dur="1.4s" begin="-0.7s" repeatCount="indefinite" rotate="auto" path="' + fd + '"/></polygon>'
        + '</g>';
    };
    marker(wireFlow, acc, '-4,-3 4,0 -4,0');       // P: upper half-arrowhead
    marker(wireFlowQ, FLOW_Q_COLOR, '-4,0 4,0 -4,3'); // Q: lower half-arrowhead
  });
  S.blocks.forEach(b => {
    const d = getDims(b);
    const sel = S.sel.includes(b.id);
    // Category color for the whole symbol; selection still overrides it (plus
    // the dashed box below), and an endpoint of the selected wire is tinted so
    // clicking a wire shows what it connects.
    const selc = sel ? acc : (wireEndHi.has(b.id) ? acc : blockColor(b.type, bds));
    const selw = sel || wireEndHi.has(b.id) ? 2 : 1.5;
    const rot = b.rot || 0;
    const [cx, cy] = blockCenter(b);
    h += '<g data-blk="' + b.id + '" style="cursor:grab"' +
      (rot ? ' transform="rotate(' + rot + ' ' + cx + ' ' + cy + ')"' : '') + '>';
    // invisible hit-target: bare line-art symbols are hard to grab, so the
    // whole box area stays clickable/draggable (label has its own hit target
    // below, since it's rendered unrotated outside this group: see blockLabel)
    h += '<rect x="' + b.x + '" y="' + b.y + '" width="' + d.w + '" height="' + d.h + '" fill="transparent" stroke="none"/>';
    if (sel) h += '<rect x="' + (b.x - 4) + '" y="' + (b.y - 4) + '" width="' + (d.w + 8) + '" height="' + (d.h + 8) +
      '" rx="6" fill="none" stroke="' + acc + '" stroke-width="1" stroke-dasharray="4 3"/>';
    // Search hit (issue #2): a filled halo, deliberately a different SHAPE of
    // mark from the selection's hollow dashed box, so the two read apart when
    // a block is both. Every match is haloed, which puts the shape of the
    // result set on the canvas itself; the one just revealed is brighter and
    // fades out shortly after arrival so the eye lands on it.
    if (findSet && findSet.has(b.id)) {
      const fl = b.id === findFlash;
      h += '<rect x="' + (b.x - 7) + '" y="' + (b.y - 7) + '" width="' + (d.w + 14) + '" height="' + (d.h + 14) +
        '" rx="9" fill="' + acc + '" fill-opacity="' + (fl ? 0.2 : 0.08) + '" stroke="' + acc +
        '" stroke-width="' + (fl ? 2.2 : 1) + '" stroke-dasharray="2 2" pointer-events="none"/>';
    }
    h += blockSymbol(b, d, selc, selw, sfc, tx, tx3);
    getTerms(b).forEach((t, ti) => {
      const hot = S.wireFrom && S.wireFrom[0] === b.id && S.wireFrom[1] === ti;
      h += '<circle cx="' + (b.x + t[0]) + '" cy="' + (b.y + t[1]) + '" r="5.5" fill="' + (hot ? acc : sfc) +
        '" stroke="' + bds + '" stroke-width="1.2" data-term="' + b.id + ',' + ti + '" style="cursor:crosshair"/>';
    });
    h += '</g>';
    if (b.type !== 'gnd' && b.type !== 'probe' && b.type !== 'bus') h += blockLabel(b, d, tx, tx3);
  });
  if (drag && drag.type === 'rubber') {
    const rx = Math.min(drag.x0, drag.x1), ry = Math.min(drag.y0, drag.y1);
    const rw = Math.abs(drag.x1 - drag.x0), rh = Math.abs(drag.y1 - drag.y0);
    h += '<rect x="' + rx + '" y="' + ry + '" width="' + rw + '" height="' + rh +
      '" fill="' + acc + '" fill-opacity="0.12" stroke="' + acc + '" stroke-width="1" stroke-dasharray="4 3"/>';
  }
  // Palette drag ghost: a translucent preview of the block being dragged from
  // the palette, following the cursor in world coords. Same blockSymbol art as
  // the canvas and the palette thumbnail, so what you see is what drops.
  if (drag && drag.type === 'palette' && drag.moved && drag.world) {
    const t = drag.blockType;
    const gb = { id: -1, type: t, x: drag.world.x, y: drag.world.y, rot: 0, params: defaultParams(t) };
    const gd = getDims(gb);
    gb.x = drag.world.x - gd.w / 2; gb.y = drag.world.y - gd.h / 2; // center on cursor
    h += '<g opacity="0.55" pointer-events="none">' + blockSymbol(gb, gd, bds, 1.5, sfc, tx, tx3) + '</g>';
  }
  // Power-flow annotation overlay: solved |V| (pu) and angle above each bus,
  // green inside the bus's own Vhi/Vlo band (NVHI/NVLO from import, default
  // 0.95/1.05), red outside. Set by solvePF().
  if (window.pfShow && window.pfResult && window.pfResult.busBlocks) {
    const bm = new Map(window.pfResult.busBlocks.map(x => [x.id, x]));
    S.blocks.forEach(b => {
      if (b.type !== 'bus') return;
      const r = bm.get(b.id); if (!r) return;
      const [bx, by] = blockCenter(b);
      const col = (r.Vpu < r.Vlo || r.Vpu > r.Vhi) ? '#d64545' : '#2a9d5a';
      h += '<text x="' + bx + '" y="' + (by - 11) + '" text-anchor="middle" font-size="11" font-weight="600" fill="' + col +
        '">' + r.Vpu.toFixed(3) + ' pu ∠' + r.ang.toFixed(0) + '°</text>';
    });
  }
  cnv.innerHTML = h;
}

// ---- IEC-style block symbols (SPEC §3). The block IS the symbol: no boxes.
// Each symbol is drawn on the block's terminal midline inside its existing
// w×h box, leads meeting the exact getTerms() points, so wires/topology/
// rotation are untouched. Labels are rendered separately (blockLabel) so
// they always read horizontally, never rotated sideways with the symbol.
// Canvas sub-labels read straight off params, and an imported case carries full
// double precision: a PSS/E line lands as 0.0034567890123 Ω and the number
// runs off the symbol. nn() trims what is DISPLAYED only; the stored parameter
// is untouched, so nothing about the solve changes. Integers pass through
// whole (a 2400 V source must not read "2.40e+3"), long decimals get four
// significant digits, and only genuinely tiny or huge magnitudes go
// exponential. sciNum() is deliberately not reused here: its >=1000 rule turns
// ordinary voltages into exponentials, which is right in a science panel and
// wrong on a schematic.
function nn(x) {
  const v = +x;
  if (!isFinite(v)) return String(x);
  const a = Math.abs(v);
  if (Number.isInteger(v) && a < 1e6) return String(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e6)) return v.toExponential(3);
  return String(Number(v.toPrecision(4)));
}
function blockSub(b) {
  return b.type === 'src' ? nn(b.params.Vrms) + 'V ' + nn(b.params.f) + 'Hz'
    : b.type === 'line' ? nn(b.params.R) + 'Ω ' + nn(b.params.L) + 'mH' + (isCoupled(b) ? ' ⇄' : '') + (isPiLine(b) ? ' ' + nn(b.params.C) + 'µF π' : '')
    : b.type === 'pq' ? nn(b.params.P) + 'kW ' + nn(b.params.Q) + 'kvar'
    : b.type === 'zip' ? nn(b.params.P) + 'kW ' + nn(b.params.Q) + 'kvar @' + nn(b.params.V0) + 'V'
    : b.type === 'cap' ? nn(b.params.C) + 'µF'
    : b.type === 'rlc' ? [+b.params.R > 0 ? nn(b.params.R) + 'Ω' : null, +b.params.L > 0 ? nn(b.params.L) + 'mH' : null, +b.params.C > 0 ? nn(b.params.C) + 'µF' : null].filter(x => x).join(' ')
    : b.type === 'rlcp' ? [+b.params.R > 0 ? nn(b.params.R) + 'Ω' : null, +b.params.L > 0 ? nn(b.params.L) + 'mH' : null, +b.params.C > 0 ? nn(b.params.C) + 'µF' : null].filter(x => x).join(' ')
    : b.type === 'xfmr' ? nn(b.params.V1) + '/' + nn(b.params.V2) + 'V ' + nn(b.params.R) + 'Ω ' + nn(b.params.L) + 'mH' + (+(b.params.Lm || 0) > 0 ? (+(b.params.lknee || 0) > 0 ? ' ⚡sat' : ' Lm') : '')
    : b.type === 'xfmr3' ? b.params.conn + ' ' + nn(b.params.V1) + '/' + nn(b.params.V2) + 'V'
    : b.type === 'xfmr3w' ? b.params.conn + ' ' + nn(b.params.V1) + '/' + nn(b.params.V2) + '/' + nn(b.params.V3) + 'V'
    : b.type === 'fault' ? b.params.Rf + 'Ω t=' + b.params.ton + 'ms'
    : b.type === 'tap' ? 'phase ' + (['A', 'B', 'C'][Math.round(+b.params.ph) - 1] || 'A') + ' → 1-ph'
    : b.type === 'gfm' ? (+b.params.mode === 1 ? b.params.P0 + 'kW ' + b.params.Q0 + 'kvar GFL' : b.params.E0 + 'V ' + b.params.f0 + 'Hz droop')
    : b.type === 'syncgen' ? b.params.Pm0 + 'kW H=' + b.params.H + 's'
    : b.type === 'im' ? b.params.PL + 'kW s0=' + b.params.s0
    : b.type === 'pfc' ? b.params.Vref + 'V ≤' + b.params.Imax + 'A' + (+b.params.rev === 1 ? ' ⇄' : '')
    : b.type === 'dcdc' ? (+b.params.mode === 1 ? b.params.I0 + 'A CC' : b.params.Vref + 'V ≤' + b.params.Imax + 'A CV')
    : b.type === 'pv' ? (b.params.Vmpp * b.params.Impp).toFixed(0) + 'W @ ' + (b.params.G / 10).toFixed(0) + '%'
    : b.type === 'batt' ? b.params.Vref + 'V ' + b.params.soc0 + '%'
    : b.type === 'cpl' ? b.params.P + 'kW'
    : b.type === 'brk' ? 'cl=' + b.params.tclose + ' op=' + b.params.topen + 'ms'
    : b.type === 'relay' ? b.params.Ipu + 'A ' + b.params.curve + ' TD=' + b.params.TD + ' →#' + b.params.brkId
    : b.type === 'vsw' ? b.params.Von + '/' + b.params.Voff + 'V →#' + b.params.brkId
    : b.type === 'gtrip' ? (b.params.Vov || b.params.Fov || 'off') + ' →#' + b.params.brkId
    : b.type === 'mov' ? b.params.Vc + 'V ' + b.params.Rd + 'Ω'
    : b.type === 'tline' ? b.params.Z + 'Ω τ=' + b.params.tau + 'µs'
    : b.type === 'fdline' ? b.params.Zh + '/' + b.params.Zlf + 'Ω τ=' + b.params.tau + 'µs'
    : b.type === 'svc' ? (+b.params.mode === 1 ? 'STATCOM ' : 'SVC ') + b.params.Vref + 'V'
    : b.type === 'wt4' ? b.params.Prated + 'kW @' + b.params.vw + 'm/s'
    : b.type === 'gfl' ? (b.params.P0 / 1000).toFixed(0) + 'MW ' + (b.params.Vrated / 1000).toFixed(0) + 'kV'
    : b.type === 'hvdc' ? b.params.Pset + 'kW A→B, ' + b.params.VdcRef + 'V dc'
    : b.type === 'scale' ? '×' + b.params.N
    : '';
}
function blockSymbol(b, d, selc, selw, sfc, tx, tx3) {
  const x = b.x, y = b.y, w = d.w, cx = x + w / 2;
  const my = y + (DEFS[b.type].terms[0] ? DEFS[b.type].terms[0][1] : d.h / 2); // terminal midline
  let s = '';
  switch (b.type) {
    case 'src': { // IEC AC source: circle with one sine cycle
      const r = 16;
      s += ln(x, my, cx - r, my, selc, selw) + ln(cx + r, my, x + w, my, selc, selw)
        + '<circle cx="' + cx + '" cy="' + my + '" r="' + r + '" fill="' + sfc + '" stroke="' + selc + '" stroke-width="' + selw + '"/>'
        + '<path d="M' + (cx - 10) + ' ' + my + ' q 5 -11 10 0 q 5 11 10 0" fill="none" stroke="' + tx + '" stroke-width="1.4"/>';
      break;
    }
    case 'syncgen': { // IEC rotating-machine symbol: circle with "G": visually
      // distinct from src's circle+sine (idealized EMF) and gfm's square+sine
      // (power-electronic converter), since it's a genuinely different kind
      // of device: a spinning mass with inertia, not an idealized/converted
      // source (SPEC §2).
      const r = 16;
      s += ln(x, my, cx - r, my, selc, selw) + ln(cx + r, my, x + w, my, selc, selw)
        + '<circle cx="' + cx + '" cy="' + my + '" r="' + r + '" fill="' + sfc + '" stroke="' + selc + '" stroke-width="' + selw + '"/>'
        + txt(cx, my + 5, 'G', 16, tx, 700);
      break;
    }
    case 'im': { // IEC rotating-machine symbol: circle with "M": same family
      // as syncgen's circle+G (both are spinning masses), distinct letter for
      // the motor role (SPEC §2).
      const r = 16;
      s += ln(x, my, cx - r, my, selc, selw) + ln(cx + r, my, x + w, my, selc, selw)
        + '<circle cx="' + cx + '" cy="' + my + '" r="' + r + '" fill="' + sfc + '" stroke="' + selc + '" stroke-width="' + selw + '"/>'
        + txt(cx, my + 5, 'M', 16, tx, 700);
      break;
    }
    case 'line': { // series RL: resistor box + inductor arcs; when C>0 a
      // π-equivalent, drawn with two shunt capacitors at the leads and a π label
      const rx0 = x + 8, rx1 = x + 34, ly1 = x + w - 8;
      s += ln(x, my, rx0, my, selc, selw)
        + '<rect x="' + rx0 + '" y="' + (my - 6) + '" width="' + (rx1 - rx0) + '" height="12" fill="' + sfc + '" stroke="' + selc + '" stroke-width="' + selw + '"/>'
        + '<path d="M' + rx1 + ' ' + my + arc(rx1, ly1, my, 3) + '" fill="none" stroke="' + selc + '" stroke-width="' + selw + '"/>'
        + ln(ly1, my, x + w, my, selc, selw);
      if (isPiLine(b)) {
        // shunt capacitor at each lead: vertical drop to two horizontal plates
        // (the π shunts, SPEC §2), plus a π label above the series branch
        const shunt = (tx0) =>
          ln(tx0, my, tx0, my + 6, selc, 1.3) +
          ln(tx0 - 5, my + 6, tx0 + 5, my + 6, selc, 1.8) +
          ln(tx0 - 5, my + 10, tx0 + 5, my + 10, selc, 1.8);
        s += shunt(x + 4) + shunt(x + w - 4) + txt(x + w / 2, my - 6, 'π', 13, tx, 700);
      }
      break;
    }
    case 'tline': { // traveling-wave line: long thin box with a wave inside
      const rx0 = x + 10, rx1 = x + w - 10;
      s += ln(x, my, rx0, my, selc, selw) + ln(rx1, my, x + w, my, selc, selw)
        + '<rect x="' + rx0 + '" y="' + (my - 8) + '" width="' + (rx1 - rx0) + '" height="16" rx="8" fill="' + sfc + '" stroke="' + selc + '" stroke-width="' + selw + '"/>'
        + '<path d="M' + (rx0 + 8) + ' ' + my + ' q 7 -9 14 0 q 7 9 14 0 q 7 -9 14 0 q 7 9 14 0" fill="none" stroke="' + tx + '" stroke-width="1.3"/>';
      break;
    }
    case 'fdline': { // frequency-dependent line: TW-line pill with a
      // decaying wave inside (dispersion/attenuation is its identity)
      const rx0 = x + 10, rx1 = x + w - 10;
      s += ln(x, my, rx0, my, selc, selw) + ln(rx1, my, x + w, my, selc, selw)
        + '<rect x="' + rx0 + '" y="' + (my - 8) + '" width="' + (rx1 - rx0) + '" height="16" rx="8" fill="' + sfc + '" stroke="' + selc + '" stroke-width="' + selw + '"/>'
        + '<path d="M' + (rx0 + 8) + ' ' + my + ' q 6 -10 12 0 q 6 8 12 0 q 6 -6 12 0 q 6 4 12 0 q 6 -2 12 0" fill="none" stroke="' + tx + '" stroke-width="1.3"/>';
      break;
    }
    case 'pq': { // constant-PQ load: same "active load" arrow-in-box glyph as cpl
      const r = 17;
      s += ln(x, my, cx - r, my, selc, selw) + ln(cx + r, my, x + w, my, selc, selw)
        + '<rect x="' + (cx - r) + '" y="' + (my - r) + '" width="' + 2 * r + '" height="' + 2 * r + '" fill="' + sfc + '" stroke="' + selc + '" stroke-width="' + selw + '"/>'
        + ln(cx - 9, my - 9, cx + 5, my + 5, selc, selw)
        + '<polygon points="' + (cx + 9) + ',' + (my + 9) + ' ' + (cx - 1) + ',' + (my + 6) + ' ' + (cx + 6) + ',' + (my - 1) + '" fill="' + selc + '"/>';
      break;
    }
    case 'zip': { // composite load: box with 'ZIP': the letters ARE the
      // model (Z/I/P parts), more informative than another arrow glyph
      const r = 17;
      s += ln(x, my, cx - r, my, selc, selw) + ln(cx + r, my, x + w, my, selc, selw)
        + '<rect x="' + (cx - r) + '" y="' + (my - r) + '" width="' + 2 * r + '" height="' + 2 * r + '" fill="' + sfc + '" stroke="' + selc + '" stroke-width="' + selw + '"/>'
        + txt(cx, my + 4, 'ZIP', 11, tx, 700);
      break;
    }
    case 'cap': { // two plates
      const p0 = cx - 4, p1 = cx + 4;
      s += ln(x, my, p0, my, selc, selw) + ln(p1, my, x + w, my, selc, selw)
        + ln(p0, my - 13, p0, my + 13, selc, 2) + ln(p1, my - 13, p1, my + 13, selc, 2);
      break;
    }
    case 'rlc': { // series RLC: R, L, C left to right along the midline. A
      // component with a non-positive value (the -1 absent sentinel, or 0 which
      // is a wire / no-component in series) is dropped and its slot filled with
      // a lead so the chain stays continuous; all three absent draws as a plain
      // wire (the numerically-forced short). SPEC section 2.
      const hasR = +b.params.R > 0, hasL = +b.params.L > 0, hasC = +b.params.C > 0;
      const rx0 = x + 6, rx1 = x + 26, lx1 = x + 50, p0 = x + 58, p1 = x + 66;
      s += ln(x, my, rx0, my, selc, selw);                 // entry lead
      s += hasR                                             // R slot: box or lead
        ? '<rect x="' + rx0 + '" y="' + (my - 6) + '" width="' + (rx1 - rx0) + '" height="12" fill="' + sfc + '" stroke="' + selc + '" stroke-width="' + selw + '"/>'
        : ln(rx0, my, rx1, my, selc, selw);
      s += hasL                                             // L slot: arcs or lead
        ? '<path d="M' + rx1 + ' ' + my + arc(rx1, lx1, my, 2) + '" fill="none" stroke="' + selc + '" stroke-width="' + selw + '"/>'
        : ln(rx1, my, lx1, my, selc, selw);
      s += ln(lx1, my, p0, my, selc, selw);                // bridge lead to C
      s += hasC                                             // C plates or lead
        ? ln(p0, my - 11, p0, my + 11, selc, 2) + ln(p1, my - 11, p1, my + 11, selc, 2)
        : ln(p0, my, p1, my, selc, selw);
      s += ln(p1, my, x + w, my, selc, selw);              // exit lead
      break;
    }
    case 'rlcp': { // parallel RLC: R, L, C as parallel branches between the
      // two terminals (two vertical buses, one horizontal branch per present
      // part): INVERSE of series rlc's left-to-right chain. A component with
      // a non-positive value (-1 absent sentinel; 0 is a real short in
      // parallel but degenerate) is dropped; with one part left the symbol
      // collapses to that single midline glyph (standalone style), and with
      // none left it is an open branch (nothing drawn between the terminals).
      // SPEC section 2.
      const hasR = +b.params.R > 0, hasL = +b.params.L > 0, hasC = +b.params.C > 0;
      const xL = x + 26, xR = x + 58, yT = y + 8, yB = y + 36;
      // branch glyph between the two buses at row yy
      const rAt = yy => { const rx0 = x + 34, rx1 = x + 50;
        return ln(xL, yy, rx0, yy, selc, selw) + ln(rx1, yy, xR, yy, selc, selw)
          + '<rect x="' + rx0 + '" y="' + (yy - 6) + '" width="' + (rx1 - rx0) + '" height="12" fill="' + sfc + '" stroke="' + selc + '" stroke-width="' + selw + '"/>'; };
      const lAt = yy => { const ax0 = x + 34, ax1 = x + 50;
        return ln(xL, yy, ax0, yy, selc, selw) + ln(ax1, yy, xR, yy, selc, selw)
          + '<path d="M' + ax0 + ' ' + yy + arc(ax0, ax1, yy, 2) + '" fill="none" stroke="' + selc + '" stroke-width="' + selw + '"/>'; };
      const cAt = yy => { const px0 = x + 39, px1 = x + 45, ph = 6;
        return ln(xL, yy, px0, yy, selc, selw) + ln(px1, yy, xR, yy, selc, selw)
          + ln(px0, yy - ph, px0, yy + ph, selc, 2) + ln(px1, yy - ph, px1, yy + ph, selc, 2); };
      const rows = [];
      if (hasR) rows.push([yT, rAt]);
      if (hasL) rows.push([my, lAt]);
      if (hasC) rows.push([yB, cAt]);
      if (rows.length === 0) break;                        // all absent: open branch, nothing drawn
      if (rows.length === 1) {                             // single part: straight midline glyph
        if (hasR) {                                        // standalone resistor (load-style)
          const rx0 = x + 16, rx1 = x + w - 16;
          s += ln(x, my, rx0, my, selc, selw) + ln(rx1, my, x + w, my, selc, selw)
            + '<rect x="' + rx0 + '" y="' + (my - 7) + '" width="' + (rx1 - rx0) + '" height="14" fill="' + sfc + '" stroke="' + selc + '" stroke-width="' + selw + '"/>';
        } else if (hasL) {                                 // standalone inductor
          const ax0 = x + 30, ax1 = x + 54;
          s += ln(x, my, ax0, my, selc, selw) + ln(ax1, my, x + w, my, selc, selw)
            + '<path d="M' + ax0 + ' ' + my + arc(ax0, ax1, my, 3) + '" fill="none" stroke="' + selc + '" stroke-width="' + selw + '"/>';
        } else {                                           // standalone capacitor (cap-style)
          const p0 = cx - 4, p1 = cx + 4;
          s += ln(x, my, p0, my, selc, selw) + ln(p1, my, x + w, my, selc, selw)
            + ln(p0, my - 13, p0, my + 13, selc, 2) + ln(p1, my - 13, p1, my + 13, selc, 2);
        }
        break;
      }
      // two or three parts: vertical buses spanning the present rows; the side
      // leads tap the left bus at the midline (always on the bus, since the
      // bus spans the topmost and bottommost present rows).
      const yTop = rows[0][0], yBot = rows[rows.length - 1][0];
      s += ln(x, my, xL, my, selc, selw)                   // left terminal lead -> left bus (mid)
        + ln(xR, my, x + w, my, selc, selw)                // right bus (mid) -> right terminal lead
        + ln(xL, yTop, xL, yBot, selc, selw) + ln(xR, yTop, xR, yBot, selc, selw); // the two buses
      for (const r of rows) s += r[1](r[0]);
      break;
    }
    case 'xfmr': { // two overlapping circles: "1"/"2" tag each winding side
      // (term 0 = winding 1 lead, term 1 = winding 2 lead: SPEC §2 ratio a=N1/N2)
      const r = 13;
      s += ln(x, my, cx - r - 6, my, selc, selw) + ln(cx + r + 6, my, x + w, my, selc, selw)
        + '<circle cx="' + (cx - 7) + '" cy="' + my + '" r="' + r + '" fill="none" stroke="' + selc + '" stroke-width="' + selw + '"/>'
        + '<circle cx="' + (cx + 7) + '" cy="' + my + '" r="' + r + '" fill="none" stroke="' + selc + '" stroke-width="' + selw + '"/>'
        + txt(x + 4, my - r - 8, '1', 10, tx3, 600) + txt(x + w - 4, my - r - 8, '2', 10, tx3, 600);
      break;
    }
    case 'xfmr3': { // two overlapping circles like xfmr, plus the connection
      // string: the vector group IS the block's identity (SPEC §2). "1"/"2"
      // tag each winding side (term 0 = winding 1, term 1 = winding 2).
      const r = 12;
      s += ln(x, my, cx - 2 * r + 4, my, selc, selw) + ln(cx + 2 * r - 4, my, x + w, my, selc, selw)
        + '<circle cx="' + (cx - r + 4) + '" cy="' + my + '" r="' + r + '" fill="none" stroke="' + selc + '" stroke-width="' + selw + '"/>'
        + '<circle cx="' + (cx + r - 4) + '" cy="' + my + '" r="' + r + '" fill="none" stroke="' + selc + '" stroke-width="' + selw + '"/>'
        + txt(cx, my - r - 4, String(b.params.conn || 'Dy11'), 9, tx3, 600)
        + txt(x + 4, my - r - 8, '1', 10, tx3, 600) + txt(x + w - 4, my - r - 8, '2', 10, tx3, 600);
      break;
    }
    case 'xfmr3w': { // three overlapping circles (windings) + conn string,
      // primary lead left, secondary/tertiary leads right (SPEC §2). "1"/"2"/"3"
      // tag each winding side (term 0 = primary, term 1 = secondary, term 2 = tertiary).
      const r = 11, t1 = DEFS.xfmr3w.terms;
      const cy1 = y + t1[1][1], cy3 = y + t1[2][1], pmy = y + t1[0][1];
      s += ln(x, pmy, cx - r - 6, pmy, selc, selw)
        + ln(cx + r + 2, cy1, x + w, cy1, selc, selw)
        + ln(cx + r + 2, cy3, x + w, cy3, selc, selw)
        + '<circle cx="' + (cx - r + 2) + '" cy="' + pmy + '" r="' + r + '" fill="none" stroke="' + selc + '" stroke-width="' + selw + '"/>'
        + '<circle cx="' + (cx + r - 2) + '" cy="' + (cy1 + 3) + '" r="' + r + '" fill="none" stroke="' + selc + '" stroke-width="' + selw + '"/>'
        + '<circle cx="' + (cx + r - 2) + '" cy="' + (cy3 - 3) + '" r="' + r + '" fill="none" stroke="' + selc + '" stroke-width="' + selw + '"/>'
        + txt(cx, y + 8, String(b.params.conn || ''), 8, tx3, 600)
        + txt(x + 4, pmy - r - 4, '1', 10, tx3, 600)
        + txt(x + w - 4, cy1 + 3 - r - 4, '2', 10, tx3, 600)
        + txt(x + w - 4, cy3 - 3 + r + 10, '3', 10, tx3, 600);
      break;
    }
    case 'brk': { // switch: hinged blade, open/closed per init param
      const ci = +b.params.init === 1;
      s += ln(x, my, x + 24, my, selc, selw) + ln(x + w - 24, my, x + w, my, selc, selw)
        + ln(x + 24, my, x + w - 24, my - (ci ? 0 : 12), selc, selw)
        + '<circle cx="' + (x + 24) + '" cy="' + my + '" r="2.2" fill="' + selc + '"/>'
        + '<circle cx="' + (x + w - 24) + '" cy="' + my + '" r="2.2" fill="' + selc + '"/>';
      break;
    }
    case 'relay': { // ANSI/IEC overcurrent relay: square with I> (IEC 60617
      // overcurrent notation), series in the line like a breaker
      const r = 15;
      s += ln(x, my, cx - r, my, selc, selw) + ln(cx + r, my, x + w, my, selc, selw)
        + '<rect x="' + (cx - r) + '" y="' + (my - r) + '" width="' + 2 * r + '" height="' + 2 * r + '" fill="' + sfc + '" stroke="' + selc + '" stroke-width="' + selw + '"/>'
        + txt(cx, my + 4, 'I>', 12, tx, 700);
      break;
    }
    case 'hvdc': { // back-to-back converters: box, ~ = ~ across it
      const r = 17;
      s += ln(x, my, cx - r - 8, my, selc, selw) + ln(cx + r + 8, my, x + w, my, selc, selw)
        + '<rect x="' + (cx - r - 8) + '" y="' + (my - 14) + '" width="' + (2 * r + 16) + '" height="28" fill="' + sfc + '" stroke="' + selc + '" stroke-width="' + selw + '"/>'
        + '<path d="M' + (cx - r - 2) + ' ' + my + ' q 3.5 -7 7 0 q 3.5 7 7 0" fill="none" stroke="' + tx + '" stroke-width="1.2"/>'
        + ln(cx - 1, my - 3, cx + 1, my - 3, tx, 1.6) + ln(cx - 1, my + 3, cx + 1, my + 3, tx, 1.6)
        + '<path d="M' + (cx + 2) + ' ' + my + ' q 3.5 -7 7 0 q 3.5 7 7 0" fill="none" stroke="' + tx + '" stroke-width="1.2"/>';
      break;
    }
    case 'scale': { // aggregation current-scaling coupler: box with a
      // gain-block triangle (network side -> reference-unit side), the
      // classic amplifier/multiplier glyph: distinct from hvdc's ~=~ box
      // since this element scales CURRENT only, no AC/DC conversion (SPEC §2)
      const bx = x + 18, bw = w - 36;
      s += ln(x, my, bx, my, selc, selw) + ln(bx + bw, my, x + w, my, selc, selw)
        + '<rect x="' + bx + '" y="' + (my - 15) + '" width="' + bw + '" height="30" fill="' + sfc + '" stroke="' + selc + '" stroke-width="' + selw + '"/>'
        + '<polygon points="' + (bx + 9) + ',' + (my - 8) + ' ' + (bx + 9) + ',' + (my + 8) + ' ' + (bx + bw - 9) + ',' + my + '" fill="none" stroke="' + tx + '" stroke-width="1.4"/>';
      break;
    }
    case 'wt4': { // wind turbine: circle with a 3-blade rotor glyph
      const r = 16;
      s += ln(x, my, cx - r, my, selc, selw) + ln(cx + r, my, x + w, my, selc, selw)
        + '<circle cx="' + cx + '" cy="' + my + '" r="' + r + '" fill="' + sfc + '" stroke="' + selc + '" stroke-width="' + selw + '"/>'
        + '<path d="M' + cx + ' ' + my + ' l 0 -11 M' + cx + ' ' + my + ' l 9.5 5.5 M' + cx + ' ' + my + ' l -9.5 5.5" stroke="' + tx + '" stroke-width="1.8" fill="none"/>'
        + '<circle cx="' + cx + '" cy="' + my + '" r="2.2" fill="' + tx + '"/>';
      break;
    }
    case 'svc': { // shunt compensator: box with ±Q hung from its terminal
      const bx = x + 32;
      s += ln(bx, y, bx, y + 10, selc, selw)
        + '<rect x="' + (bx - 18) + '" y="' + (y + 10) + '" width="36" height="26" rx="3" fill="' + sfc + '" stroke="' + selc + '" stroke-width="' + selw + '"/>'
        + txt(bx, y + 27, '±Q', 12, tx, 700);
      break;
    }
    case 'mov': { // IEC arrester: box with a through-arrow, hung from its
      // top terminal to an internal ground tick (like fault's topology)
      const bx = x + 28;
      s += ln(bx, y, bx, y + 8, selc, selw)
        + '<rect x="' + (bx - 9) + '" y="' + (y + 8) + '" width="18" height="22" fill="' + sfc + '" stroke="' + selc + '" stroke-width="' + selw + '"/>'
        + ln(bx, y + 10, bx, y + 27, selc, 1.3)
        + '<polygon points="' + bx + ',' + (y + 29) + ' ' + (bx - 4) + ',' + (y + 22) + ' ' + (bx + 4) + ',' + (y + 22) + '" fill="' + selc + '"/>'
        + ln(bx, y + 30, bx, y + 36, selc, selw)
        + ln(bx - 7, y + 38, bx + 7, y + 38, selc, 1.5) + ln(bx - 4, y + 41, bx + 4, y + 41, selc, 1.2);
      break;
    }
    case 'vsw': { // shunt-bank voltage controller: probe-style stem + box
      // with V and up/down arrows (it watches V and switches a bank)
      const bx = x + 30;
      s += ln(bx, y + 40, bx, y + 25, selc, selw)
        + '<rect x="' + (bx - 14) + '" y="' + (y + 3) + '" width="28" height="22" rx="3" fill="' + sfc + '" stroke="' + selc + '" stroke-width="' + selw + '"/>'
        + txt(bx, y + 18, 'V⇅', 11, tx, 700);
      break;
    }
    case 'gtrip': { // latching generation-trip relay: probe-style stem + shield
      // with trip bolt (it watches V and f, trips a breaker and stays tripped)
      const bx = x + 30;
      s += ln(bx, y + 40, bx, y + 25, selc, selw)
        + '<polygon points="' + bx + ',' + (y + 4) + ' ' + (bx + 16) + ',' + (y + 10) + ' ' + (bx + 14) + ',' + (y + 23) + ' ' + bx + ',' + (y + 27) + ' ' + (bx - 14) + ',' + (y + 23) + ' ' + (bx - 16) + ',' + (y + 10) + '" fill="' + sfc + '" stroke="' + selc + '" stroke-width="' + selw + '"/>'
        + txt(bx, y + 18, '⚡', 12, tx, 400);
      break;
    }
    case 'zrel': { // distance / line-protection relay: series box with Z/Ω
      const r = 15;
      s += ln(x, my, cx - r, my, selc, selw) + ln(cx + r, my, x + w, my, selc, selw)
        + '<rect x="' + (cx - r) + '" y="' + (my - r) + '" width="' + 2 * r + '" height="' + 2 * r + '" fill="' + sfc + '" stroke="' + selc + '" stroke-width="' + selw + '"/>'
        + txt(cx, my + 4, 'Z', 13, tx, 700)
        + txt(cx + 9, my + 9, 'Ω', 8, tx, 500);
      break;
    }
    case 'gfm': { // AC/DC inverter: square with sine (AC leads) + a DC lead
      // dropping to the optional DC+ port below (terms[2]: SPEC §2). term 0
      // (left) is conventionally wired to the inverter's own local ground
      // reference, term 1 (right) to the grid/AC bus it ties into: every
      // shipped example wires it this way: so tag them GND / AC to match;
      // the bottom lead is the DC+ port (returns via system ground, no
      // separate DC return terminal).
      const r = 19;
      s += ln(x, my, cx - r, my, selc, selw) + ln(cx + r, my, x + w, my, selc, selw)
        + '<rect x="' + (cx - r) + '" y="' + (my - r) + '" width="' + 2 * r + '" height="' + 2 * r + '" fill="' + sfc + '" stroke="' + selc + '" stroke-width="' + selw + '"/>'
        + '<path d="M' + (cx - 11) + ' ' + my + ' q 5.5 -12 11 0 q 5.5 12 11 0" fill="none" stroke="' + tx + '" stroke-width="1.4"/>'
        + ln(cx, my + r, cx, y + d.h, selc, selw)
        + txt(x + 10, my - r - 6, 'GND', 8, tx3, 600) + txt(x + w - 10, my - r - 6, 'AC', 8, tx3, 600)
        + txt(cx + 18, y + d.h - 4, 'DC+', 9, tx3, 600);
      break;
    }
    case 'gfl': { // GFL solar inverter: square with a sine (AC, grid-following)
      // and a small sun glyph (solar), no DC port (a pure AC current source,
      // unlike gfm). term 0 (left) to local ground, term 1 (right) to the grid.
      const r = 19;
      s += ln(x, my, cx - r, my, selc, selw) + ln(cx + r, my, x + w, my, selc, selw)
        + '<rect x="' + (cx - r) + '" y="' + (my - r) + '" width="' + 2 * r + '" height="' + 2 * r + '" fill="' + sfc + '" stroke="' + selc + '" stroke-width="' + selw + '"/>'
        + '<path d="M' + (cx - 11) + ' ' + my + ' q 5.5 -12 11 0 q 5.5 12 11 0" fill="none" stroke="' + tx + '" stroke-width="1.4"/>'
        + '<circle cx="' + (cx - 10) + '" cy="' + (my - 11) + '" r="3.2" fill="' + tx + '"/>'
        + txt(x + 10, my - r - 6, 'GND', 8, tx3, 600) + txt(x + w - 10, my - r - 6, 'AC', 8, tx3, 600);
      break;
    }
    case 'pfc': { // AC/DC converter: square, diagonal, ~ / =
      const r = 19;
      s += ln(x, my, cx - r, my, selc, selw) + ln(cx + r, my, x + w, my, selc, selw)
        + '<rect x="' + (cx - r) + '" y="' + (my - r) + '" width="' + 2 * r + '" height="' + 2 * r + '" fill="' + sfc + '" stroke="' + selc + '" stroke-width="' + selw + '"/>'
        + ln(cx + r, my - r, cx - r, my + r, selc, 1)
        + txt(cx - 9, my - 4, '~', 13, tx, 600) + txt(cx + 9, my + 13, '=', 13, tx, 600);
      break;
    }
    case 'dcdc': { // DC/DC converter: square, diagonal, = / = (both sides DC,
      // unlike pfc's ~/=: same visual family, immediately reads "DC to DC")
      const r = 19;
      s += ln(x, my, cx - r, my, selc, selw) + ln(cx + r, my, x + w, my, selc, selw)
        + '<rect x="' + (cx - r) + '" y="' + (my - r) + '" width="' + 2 * r + '" height="' + 2 * r + '" fill="' + sfc + '" stroke="' + selc + '" stroke-width="' + selw + '"/>'
        + ln(cx + r, my - r, cx - r, my + r, selc, 1)
        + txt(cx - 9, my - 4, '=', 13, tx, 600) + txt(cx + 9, my + 13, '=', 13, tx, 600);
      break;
    }
    case 'pv': { // PV array: grid-hatched rectangle (solar-cell panel glyph)
      const rx0 = cx - 16, rx1 = cx + 16, ry0 = my - 10, ry1 = my + 10;
      s += ln(x, my, rx0, my, selc, selw) + ln(rx1, my, x + w, my, selc, selw)
        + '<rect x="' + rx0 + '" y="' + ry0 + '" width="32" height="20" fill="' + sfc + '" stroke="' + selc + '" stroke-width="' + selw + '"/>'
        + ln(rx0 + 32 / 3, ry0, rx0 + 32 / 3, ry1, selc, 1) + ln(rx0 + 64 / 3, ry0, rx0 + 64 / 3, ry1, selc, 1)
        + ln(rx0, my, rx1, my, selc, 1);
      break;
    }
    case 'batt': { // battery cell: long (+, DC+ is terminal 1/right) and short plates
      const p = 5;
      s += ln(x, my, cx - p, my, selc, selw) + ln(cx + p, my, x + w, my, selc, selw)
        + ln(cx - p, my - 8, cx - p, my + 8, selc, 2.5)   // short = −
        + ln(cx + p, my - 15, cx + p, my + 15, selc, 1.5) // long = +
        + txt(cx + 13, my - 12, '+', 11, tx3, 600);
      break;
    }
    case 'cpl': { // IEC load arrow in a light box
      const r = 17;
      s += ln(x, my, cx - r, my, selc, selw) + ln(cx + r, my, x + w, my, selc, selw)
        + '<rect x="' + (cx - r) + '" y="' + (my - r) + '" width="' + 2 * r + '" height="' + 2 * r + '" fill="' + sfc + '" stroke="' + selc + '" stroke-width="' + selw + '"/>'
        + ln(cx - 9, my - 9, cx + 5, my + 5, selc, selw)
        + '<polygon points="' + (cx + 9) + ',' + (my + 9) + ' ' + (cx - 1) + ',' + (my + 6) + ' ' + (cx + 6) + ',' + (my - 1) + '" fill="' + selc + '"/>';
      break;
    }
    case 'fault': { // lightning bolt from the top terminal to a ground tick
      const tx0 = x + 30; // terminal at [30, 0]
      s += ln(tx0, y, tx0, y + 8, selc, selw)
        + '<path d="M' + tx0 + ' ' + (y + 8) + ' l-8 12 l9 -3 l-8 13" fill="none" stroke="' + selc + '" stroke-width="' + selw + '"/>'
        + '<polygon points="' + (tx0 - 7) + ',' + (y + 30) + ' ' + (tx0 - 12) + ',' + (y + 25) + ' ' + (tx0 - 4) + ',' + (y + 24) + '" fill="' + selc + '"/>'
        + ln(x + 14, y + 36, x + 46, y + 36, selc, 2) + ln(x + 21, y + 41, x + 39, y + 41, selc, 1.5);
      break;
    }
    case 'tap': { // three bundled conductors on the left, one tapped out right
      const my = 22, lab = ['A', 'B', 'C'][Math.round(+b.params.ph) - 1] || 'A';
      const k = Math.round(+b.params.ph) - 1, sel = k >= 0 && k <= 2 ? k : 0;
      for (let i = 0; i < 3; i++) { // the three phases entering, selected one bold
        const yy = y + my - 8 + i * 8;
        s += ln(x, yy, x + 26, yy, selc, i === sel ? 2.2 : 1);
      }
      s += ln(x + 26, y + my - 8 + sel * 8, x + 26, y + my, selc, 2.2)
        + ln(x + 26, y + my, x + d.w, y + my, selc, 2.2)
        + '<circle cx="' + (x + 26) + '" cy="' + (y + my - 8 + sel * 8) + '" r="3" fill="' + selc + '"/>'
        + txt(x + 44, y + my - 6, lab, 11, tx, 700);
      break;
    }
    case 'gnd':
      s += ln(x + 22, y, x + 22, y + 14, selc, 1.5) + ln(x + 6, y + 14, x + 38, y + 14, selc, 2)
        + ln(x + 12, y + 21, x + 32, y + 21, selc, 2) + ln(x + 18, y + 28, x + 26, y + 28, selc, 2);
      break;
    case 'probe':
      s += '<circle cx="' + (x + 26) + '" cy="' + (y + 16) + '" r="15" fill="' + sfc + '" stroke="' + selc + '" stroke-width="' + selw + '"/>'
        + txt(x + 26, y + 20, 'V', 12, tx, 600)
        + ln(x + 26, y + 31, x + 26, y + 36, selc, 1.5);
      break;
    case 'bus': {
      const midY = d.h / 2;
      const name = escAttr(b.params.name || ('Bus #' + b.id));
      s += ln(x, y + midY, x + d.w, y + midY, selc, 6)
        + txt(x + d.w / 2, y + midY - 8, name, 10, tx3, 600);
      break;
    }
  }
  return s;
}
// On-screen vertical half-extent of a (possibly rotated) block: 90°/270°
// swap w/h, since that's what the rotated bounding box actually looks like.
// Used to place the label directly below the block on screen no matter its
// rotation, without needing to know which way it's turned.
function screenHalfHeight(d, rot) {
  const r = ((rot % 180) + 180) % 180;
  return (r === 90 ? d.w : d.h) / 2;
}
// Label (name #id + param summary) is rendered SEPARATELY from the rotated
// symbol <g>: plain unrotated text at an absolute world position, so it
// always reads horizontally instead of turning sideways with the symbol
// (auto-layout rotates line/load/src/etc. 90° in top-to-bottom mode: SPEC
// §3). Wrapped in its own data-blk group so clicking/dragging the label still
// selects/moves the block, same as clicking the symbol.
function blockLabel(b, d, tx, tx3) {
  const [cx, cy] = blockCenter(b);
  const ly = cy + screenHalfHeight(d, b.rot || 0) + 10;
  return '<g data-blk="' + b.id + '" style="cursor:grab">'
    + txt(cx, ly, DEFS[b.type].label + ' #' + b.id, 10, tx, 600)
    + txt(cx, ly + 11, blockSub(b), 9, tx3)
    + '</g>';
}
// n inductor half-loop arcs from x0 to x1 on midline y (SVG arc path segments)
function arc(x0, x1, y, n) {
  const step = (x1 - x0) / n, r = step / 2;
  let p = '';
  for (let i = 0; i < n; i++) p += ' A' + r + ' ' + r + ' 0 0 1 ' + (x0 + (i + 1) * step) + ' ' + y;
  return p;
}
function ln(x1, y1, x2, y2, c, w) { return '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" stroke="' + c + '" stroke-width="' + w + '"/>'; }
function txt(x, y, s, fs, c, fw) { return '<text x="' + x + '" y="' + y + '" text-anchor="middle" font-size="' + fs + '"' + (fw ? ' font-weight="' + fw + '"' : '') + ' fill="' + c + '">' + s + '</text>'; }

// ---- interaction ----
// Selection is multi (S.sel is an array of block ids). Shift/Ctrl is the
// "selection modifier": held while clicking a block it toggles that block's
// membership; held while dragging on empty canvas it rubber-bands a rectangle
// (any block overlapping it is added to the selection). Without the modifier,
// clicking a block replaces the selection and dragging moves the whole group
// (if the clicked block is already part of a multi-selection) or just itself;
// dragging on empty canvas pans, unchanged.
let drag = null; // {type:'block'|'pan'|'rubber', ...}
// Index into S.wires of the selected wire, or null. Clicking a wire USED TO
// delete it outright (July 2026): fine on a 5-block demo, hostile on a large
// imported case, where the useful question about a wire is "what are its two
// ends?" and an accidental click silently changed the circuit. A click now
// selects and highlights it (the wire, its two end markers, and both end
// blocks) and names both endpoints on the status line; Delete removes it, the
// same key that removes a selected block.
let selWire = null;
function wireEndLabel(end) {
  const b = S.blocks.find(x => x.id === end[0]);
  if (!b) return '?';
  return (DEFS[b.type].label || b.type) + ' #' + b.id + ' term ' + end[1];
}
function selectWire(i) {
  selWire = i;
  S.sel = []; S.wireFrom = null;
  const w = S.wires[i];
  const stat = document.getElementById('stat');
  if (stat && w) stat.textContent = 'Wire ' + i + ': ' + wireEndLabel(w.a) + ' ↔ ' + wireEndLabel(w.b)
    + '. Press Delete to remove it, Esc or click empty canvas to deselect.';
  render(); showProps();
}
function delSelectedWire() {
  if (selWire == null || !S.wires[selWire]) return;
  pushHistory(); touchModel();
  S.wires.splice(selWire, 1);
  selWire = null;
  render(); showProps();
}
function blockOverlapsRect(b, rx0, ry0, rx1, ry1) {
  const d = getDims(b);
  return b.x < rx1 && b.x + d.w > rx0 && b.y < ry1 && b.y + d.h > ry0;
}
// Coalesce drag repaints to one per animation frame. pointermove fires up to
// 120 Hz on a touch screen, and a full re-render costs ~1.3 ms at 19 blocks but
// ~8.4 ms at 147 (measured), several times that on phone silicon. Rendering
// once per event therefore guarantees the handler falls behind the finger on a
// large circuit, which is the size-dependent stutter reported in #15: smooth on
// central_ups, bad on ieee39bus. One frame is the most the display can show
// anyway, so the extra renders bought nothing.
let dragRaf = 0;
function renderDrag() {
  if (dragRaf) return;
  dragRaf = requestAnimationFrame(() => { dragRaf = 0; render(); });
}
function flushDragRender() {
  if (dragRaf) { cancelAnimationFrame(dragRaf); dragRaf = 0; }
  render();
}

// How close a pointer must come to a terminal, in CSS PIXELS, to grab it.
//
// The drawn terminal is a 5.5 user-unit circle, and user units shrink with the
// camera: at 375px wide the canvas renders at scale 0.507, so that circle is a
// 5.6 by 5.6 CSS pixel target. WCAG 2.5.8 asks for 24 by 24. Wiring on a phone
// was a coin flip.
//
// Fixing it by enlarging the drawn circle does not work, because at that zoom a
// whole block is only 23 by 13 CSS px: a circle big enough to hit reliably
// would cover its own block and its neighbours. So the hit test is separated
// from the drawing. The circles stay 5.5 units and this searches for the
// nearest terminal in screen space, which also resolves ties unambiguously.
const TERM_HIT_CSS = { touch: 22, pen: 16, mouse: 8 };
// Nearest terminal to a pointer event, or null. Two guards stop it eating the
// interactions around it:
//   1. it must be inside the pointer-type radius, converted to user units, and
//   2. INSIDE a block's own box, it must be nearer the terminal than the
//      block's centre, so the middle of a block still selects and drags it.
//
// Rule 2 is deliberately scoped to the inside of the box. Applying it
// everywhere capped the usable target at half the terminal-to-centre distance,
// which measured 14px on a phone: the rule, not the radius, was the binding
// constraint. Outside the box there is no block-body interaction to protect,
// only panning and rubber-band select, and reaching a nearby terminal is what
// someone aiming at one actually wants. The 6-unit floor covers blocks whose
// terminal sits near their own centre, where rule 2 would be a coin flip.
// setPointerCapture throws NotFoundError if the pointer is already gone by the
// time the handler runs (a fast tap, a synthetic event, a pointer the browser
// has already released). Unguarded it aborted the rest of the handler, which
// includes the render() that draws the selection the user just made, leaving
// the canvas showing stale state. The plot handlers already guarded this; the
// schematic did not.
function capture(e) {
  try { cnv.setPointerCapture(e.pointerId); } catch (err) { /* pointer already released; drag still tracked by listeners */ }
}
function nearestTerminal(e) {
  const r = cnv.getBoundingClientRect();
  if (!r.width) return null;
  const perCss = view.w / r.width; // user units per CSS pixel
  const maxUser = (TERM_HIT_CSS[e.pointerType] || TERM_HIT_CSS.mouse) * perCss;
  const pt = svgPt(e);
  let best = null, bestD = Infinity;
  S.blocks.forEach(b => {
    const [cx, cy] = blockCenter(b);
    const d0 = getDims(b);
    const inside = pt.x >= b.x && pt.x <= b.x + d0.w && pt.y >= b.y && pt.y <= b.y + d0.h;
    const dC = Math.hypot(pt.x - cx, pt.y - cy);
    getTerms(b).forEach((t, ti) => {
      const p = termPos(b, ti);
      const d = Math.hypot(pt.x - p[0], pt.y - p[1]);
      if (d > maxUser || d >= bestD) return;
      if (inside && Math.hypot(p[0] - cx, p[1] - cy) > 6 && d >= dC) return; // block body wins
      bestD = d; best = [b.id, ti];
    });
  });
  return best;
}
cnv.addEventListener('pointerdown', e => {
  if (e.button !== 0) return; // ignore right/middle-click: don't start drags or wire terminals; the browser context menu is suppressed separately
  const t = e.target; const pt = svgPt(e);
  const mod = e.shiftKey || e.ctrlKey;
  if (!t.dataset.wire) selWire = null; // any other click drops the wire selection
  // Proximity first, and it subsumes the exact-hit case: landing dead on a
  // terminal is simply distance ~0. Skipped while modifier-clicking, which is
  // multi-select and never means "start a wire".
  const near = mod ? null : nearestTerminal(e);
  if (near) {
    const parts = near;
    if (!S.wireFrom) S.wireFrom = parts;
    else {
      if (!(S.wireFrom[0] === parts[0] && S.wireFrom[1] === parts[1])) { pushHistory(); touchModel(); S.wires.push({ a: S.wireFrom, b: parts }); }
      S.wireFrom = null;
    }
    render(); return;
  }
  if (t.dataset.wire) { selectWire(+t.dataset.wire); return; }
  const g = t.closest('[data-blk]');
  if (g) {
    const id = +g.dataset.blk;
    const b = S.blocks.find(x => x.id === id);
    S.wireFrom = null;
    if (mod) {
      S.sel = S.sel.includes(id) ? S.sel.filter(x => x !== id) : S.sel.concat(id);
      render(); showProps(); return; // toggle-click doesn't start a drag
    }
    if (!S.sel.includes(id)) S.sel = [id];
    const bases = new Map(S.sel.map(sid => { const sb = S.blocks.find(x => x.id === sid); return [sid, { x: sb.x, y: sb.y }]; }));
    drag = { type: 'block', ids: S.sel.slice(), bases, sx: pt.x, sy: pt.y, preSnap: snapshot() };
    capture(e);
    render(); showProps(); return;
  }
  if (mod) {
    drag = { type: 'rubber', x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y };
    capture(e);
    render(); return;
  }
  S.sel = []; S.wireFrom = null;
  drag = { type: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
  capture(e);
  render(); showProps();
});
cnv.addEventListener('pointermove', e => {
  if (!drag) return;
  if (drag.type === 'block') {
    const pt = svgPt(e);
    const dx = pt.x - drag.sx, dy = pt.y - drag.sy;
    drag.ids.forEach(id => {
      const b = S.blocks.find(x => x.id === id), base = drag.bases.get(id);
      b.x = base.x + dx; b.y = base.y + dy;
    });
  } else if (drag.type === 'rubber') {
    const pt = svgPt(e);
    drag.x1 = pt.x; drag.y1 = pt.y;
  } else {
    const r = cnv.getBoundingClientRect();
    view.x = drag.vx - (e.clientX - drag.sx) * view.w / r.width;
    view.y = drag.vy - (e.clientY - drag.sy) * view.h / r.height;
  }
  renderDrag();
});
// A touch drag must not be allowed to turn into a page scroll halfway through.
// #cnv sets touch-action:none, but that property is not inherited and every SVG
// child computes to `auto`; iOS Safari does not reliably honour the ancestor's
// value for a touch that starts on a child, so the browser can steal the
// gesture mid-drag. Two defences: `#cnv *` gets touch-action:none in
// shell.html, and any touchmove during an active drag is cancelled here. The
// listener must be non-passive or preventDefault is ignored.
cnv.addEventListener('touchmove', e => { if (drag) e.preventDefault(); }, { passive: false });
function endCanvasDrag() {
  if (drag && drag.type === 'rubber') {
    const rx0 = Math.min(drag.x0, drag.x1), rx1 = Math.max(drag.x0, drag.x1);
    const ry0 = Math.min(drag.y0, drag.y1), ry1 = Math.max(drag.y0, drag.y1);
    const hit = S.blocks.filter(b => blockOverlapsRect(b, rx0, ry0, rx1, ry1)).map(b => b.id);
    hit.forEach(id => { if (!S.sel.includes(id)) S.sel.push(id); });
    drag = null; flushDragRender(); showProps(); return;
  }
  if (drag && drag.type === 'block') {
    // only commit a history entry if the pointerdown->pointerup actually
    // moved something — a plain click (no drag) shouldn't create a no-op
    // undo step that just re-selects the same block in the same place
    const moved = drag.ids.some(id => {
      const b = S.blocks.find(x => x.id === id), base = drag.bases.get(id);
      return b.x !== base.x || b.y !== base.y;
    });
    if (moved) pushHistory(drag.preSnap);
  }
  drag = null;
  flushDragRender(); // paint the final position; the last move's frame may still be pending
}
cnv.addEventListener('pointerup', endCanvasDrag);
// Without this the canvas was the only draggable surface in the app with no
// pointercancel handler (the plot canvases and both resize grips have one). If
// the browser claimed the gesture, `drag` was never cleared: the app stayed
// stuck mid-drag while the page scrolled under the still-pressed finger, which
// is the "moves a little, then the whole page moves" half of #15.
cnv.addEventListener('pointercancel', endCanvasDrag);
cnv.addEventListener('wheel', e => {
  e.preventDefault();
  zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, svgPt(e));
  render();
}, { passive: false });
// Suppress the browser's default context menu (Edge's "search the web / ask
// Copilot", etc.) on the canvas, so right-click and touch press-and-hold during
// a drag don't pop a menu on drop. The app owns all canvas interaction via
// pointer events; right-click isn't a meaningful action here.
cnv.addEventListener('contextmenu', e => e.preventDefault());
function svgPt(e) {
  const r = cnv.getBoundingClientRect();
  return { x: view.x + (e.clientX - r.left) * view.w / r.width, y: view.y + (e.clientY - r.top) * view.h / r.height };
}

// Camera aspect ratio = the SVG element's actual on-screen shape. Normally
// that's the fixed 680:340 box, but fullscreen changes it — and svgPt()'s
// screen→world mapping assumes the viewBox exactly fills the element, so the
// view MUST follow the element's aspect or every click/drag lands off-target.
function viewAspect() {
  const r = cnv.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? r.height / r.width : VIEW0.h / VIEW0.w;
}
// zoom keeping world point (cx,cy) fixed under the cursor/center
function zoomAt(factor, pt) {
  const w = Math.max(ZMIN, Math.min(maxViewW(), view.w / factor));
  const h = w * viewAspect(); // lock aspect ratio to the element
  const relX = (pt.x - view.x) / view.w, relY = (pt.y - view.y) / view.h;
  view.w = w; view.h = h;
  view.x = pt.x - relX * w;
  view.y = pt.y - relY * h;
}
function zoomBy(factor) { zoomAt(factor, { x: view.x + view.w / 2, y: view.y + view.h / 2 }); render(); }
function resetView() {
  Object.assign(view, VIEW0);
  view.h = view.w * viewAspect();
  render();
}
// ---- find a block on the canvas (issue #2) ----
// The browser's own Ctrl+F cannot help here: the schematic is SVG drawn from
// S.blocks at world coordinates, so a block that is off-screen is not in the
// page's text flow and find-in-page has nothing to scroll to. On a model the
// size of IEEE39 (147 blocks over roughly 4200 x 2700 world units) locating one
// component by eye means zooming out until the symbols are unreadable.
// The key is "/" rather than anything with Ctrl: Ctrl+F belongs to the browser
// and is not ours to take, while "/" is unclaimed in every browser and is the
// find key in vim, GitHub, Gmail and Slack. The document keydown handler
// already ignores events originating in an input, so "/" typed into a
// parameter field still types a slash.
const FIND_W = 520;   // world units the view zooms IN to when revealing a match
const FIND_MAX = 30;  // rows in the dropdown; the count still reports every hit
let findHits = [];    // matching block ids, best match first
let findAt = -1;      // index into findHits currently revealed
let findHome = null;  // view to return to on Esc, captured when the box opens
let findDone = false; // Enter was pressed, so the jump was deliberate: Esc keeps it
let findFlash = null; // id drawn with the brighter arrival ring
// A block is findable by its name, its type (both the palette label and the
// raw type), and its id, so "Bus 14", "xfmr", "transformer 3ph" and "#14" all
// lead somewhere. Substring, case insensitive: on a real network you remember
// a fragment of a name, not its exact spelling.
function findText(b) {
  const d = DEFS[b.type];
  return [(b.params && b.params.name) || '', d ? d.label : '', b.type, '#' + b.id].join(' ').toLowerCase();
}
// Rank by how well the NAME matches, so typing "Bus 1" puts Bus 1 above Bus 14
// and both above a block that only matched on its type.
function findScore(b, q) {
  const nm = String((b.params && b.params.name) || '').toLowerCase();
  return nm === q ? 0 : nm.startsWith(q) ? 1 : nm.includes(q) ? 2 : 3;
}
function findRefresh() {
  const el = document.getElementById('findq');
  const q = el ? el.value.trim().toLowerCase() : '';
  findHits = !q ? [] : S.blocks
    .filter(b => findText(b).includes(q))
    .sort((a, b) => findScore(a, q) - findScore(b, q) || a.id - b.id)
    .map(b => b.id);
  if (findAt >= findHits.length) findAt = findHits.length ? 0 : -1;
  renderFindList();
}
function findRowLabel(b) {
  const d = DEFS[b.type];
  const nm = (b.params && b.params.name) || '';
  const type = d ? d.label : b.type;
  return escAttr(nm || type) + ' <span class="fdim">' + (nm ? escAttr(type) + ' ' : '') + '#' + b.id + '</span>';
}
function renderFindList() {
  const list = document.getElementById('findlist'), cnt = document.getElementById('findcount');
  const el = document.getElementById('findq');
  const q = el ? el.value.trim() : '';
  if (cnt) cnt.textContent = !q ? '' : findHits.length ? (Math.max(findAt, 0) + 1) + '/' + findHits.length : 'none';
  if (!list) return;
  if (!q || !findHits.length) { list.style.display = 'none'; list.innerHTML = ''; return; }
  list.innerHTML = findHits.slice(0, FIND_MAX).map((id, i) => {
    const b = S.blocks.find(x => x.id === id);
    return b ? '<button type="button" class="' + (i === findAt ? 'on' : '') + '" onclick="findGo(' + i + ',true)">'
      + findRowLabel(b) + '</button>' : '';
  }).join('') + (findHits.length > FIND_MAX
    ? '<div class="fdim" style="padding:4px 6px;font-size:11px">+ ' + (findHits.length - FIND_MAX) + ' more, keep typing</div>' : '');
  list.style.display = 'block';
}
// Move the camera to a block. Zooms IN when the view is wider than FIND_W and
// never out: someone who framed a region deliberately keeps their scale, and a
// reveal that zoomed out would throw that away to show something already
// visible.
function revealBlock(id, select) {
  const b = S.blocks.find(x => x.id === id);
  if (!b) return;
  const d = getDims(b);
  if (view.w > FIND_W) {
    view.w = Math.max(ZMIN, Math.min(maxViewW(), FIND_W));
    view.h = view.w * viewAspect();
  }
  view.x = b.x + d.w / 2 - view.w / 2;
  view.y = b.y + d.h / 2 - view.h / 2;
  findFlash = id;
  // Browsing must not disturb the circuit: only a COMMITTED match (Enter, or a
  // click in the list) selects the block and opens its parameter rail, so a
  // search abandoned with Esc leaves the selection exactly as it was.
  if (select) { S.sel = [id]; selWire = null; }
  render();
  if (select) showProps();
  clearTimeout(revealBlock._t);
  revealBlock._t = setTimeout(() => { findFlash = null; render(); }, 1100);
}
function findGo(i, commit) {
  if (!findHits.length) return;
  findAt = ((i % findHits.length) + findHits.length) % findHits.length; // wraps both ways
  if (commit) findDone = true;
  revealBlock(findHits[findAt], !!commit);
  renderFindList();
}
function focusFind() {
  const el = document.getElementById('findq');
  if (!el) return;
  if (!el.value) { findHome = { ...view }; findDone = false; } // where Esc returns to
  el.focus(); el.select();
}
function findReset() {
  const el = document.getElementById('findq');
  if (el) el.value = '';
  findHits = []; findAt = -1; findHome = null; findDone = false; findFlash = null;
  renderFindList();
}
function findEscape() {
  const el = document.getElementById('findq');
  const home = findDone ? null : findHome; // a committed jump was asked for: keep it
  findReset();
  if (home) Object.assign(view, home);
  render();
  if (el) el.blur();
}
function findType() {
  findRefresh();
  // Live reveal as you type, the behaviour Ctrl+F trains everyone to expect.
  if (findHits.length) findGo(0, false); else { findAt = -1; renderFindList(); }
}
function findKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); findEscape(); return; }
  if (e.key === 'Enter') {
    e.preventDefault();
    // First Enter commits the row you are on; each Enter after that steps to
    // the next match, which is what "find again" means everywhere else.
    if (findHits.length) findGo(findDone ? findAt + 1 : Math.max(findAt, 0), true);
    return;
  }
  if (e.key === 'ArrowDown') { e.preventDefault(); findGo(findAt + 1, false); return; }
  if (e.key === 'ArrowUp') { e.preventDefault(); findGo(findAt - 1, false); }
}
function toggleFullscreen() {
  const wrap = document.querySelector('.cnvwrap');
  // catch: rejects when the embedding context denies fullscreen (e.g. an
  // iframe without allowfullscreen) — nothing to do about it, don't throw
  if (!document.fullscreenElement) { if (wrap.requestFullscreen) wrap.requestFullscreen().catch(() => {}); }
  else document.exitFullscreen();
}
// entering/leaving fullscreen (or resizing the window) changes the element's
// aspect — re-derive view.h around the same center so the world doesn't shift
function onCanvasResize() {
  const cyMid = view.y + view.h / 2;
  view.h = view.w * viewAspect();
  view.y = cyMid - view.h / 2;
  render();
}
document.addEventListener('fullscreenchange', onCanvasResize);
window.addEventListener('resize', () => { syncCanvasHeight(); onCanvasResize(); drawAllPlots(); });

// ---- canvas height: drag the grip on the bottom edge (SPEC §3). Wide/
// fullscreen only ever changed the WIDTH, so on a tall screen the schematic
// stayed a letterbox slot and a vertically-arranged circuit had to be panned
// through. The grip writes an inline height on #cnv and onCanvasResize() does
// the rest — the camera aspect is already derived from the element's live
// shape (viewAspect()), so a taller element simply shows more world height
// with no change to zoom or block coordinates. Persisted in localStorage like
// the other layout preferences; double-click clears it so the stylesheet's
// height (which is responsive: 460px, 380px under 760px wide) takes over again.
const CNV_H_MIN = 200, CNV_H_MAX = 2000;
// Space the plots need below the canvas before any waveform is visible: the
// plots toolbar, one plot card's header, and enough plot canvas to read a
// trace, plus the margins between them. Used to size the canvas so that
// pressing Run changes something the user can actually see.
const PLOT_RESERVE = 210;
// Auto canvas height, used only when the user has not dragged the grip.
//
// The stylesheet's flat 460px was set without reference to the window, and on a
// 1280x720 laptop it put the first plot at y=771: the whole output of the tool
// lived below the fold, so a run finished with no visible change anywhere on
// screen. Deriving the height from the viewport instead keeps the generous
// canvas on a tall monitor (it clamps back to 460) and trades some schematic
// height for a visible waveform on a short one. A persisted grip height always
// wins: an explicit choice outranks this.
function autoCanvasHeight() {
  const wrap = document.querySelector('.cnvwrap');
  if (!wrap || !window.innerHeight) return null;
  // Narrow screens opt out and keep the stylesheet's height. Reserving plot
  // space only pays when the canvas and a plot can share one screen, and on a
  // phone they cannot: with 470px of chrome above it this drove the canvas to
  // its 280px floor to win 55px of plot, and then a bottom sheet took 129px of
  // that 280. Scrolling to the plots is normal on a phone, and revealPlots()
  // does it automatically when a run finishes.
  if (window.innerWidth <= 760) return null;
  const top = wrap.getBoundingClientRect().top + window.scrollY;
  const h = Math.round(window.innerHeight - top - PLOT_RESERVE);
  // Floor at 280 rather than CNV_H_MIN: 200px is a legitimate thing to drag
  // down to by hand, but it is too cramped to hand someone on arrival.
  return Math.max(280, Math.min(460, h));
}
function syncCanvasHeight() {
  const h = +localStorage.getItem('emt_cnvh');
  if (h >= CNV_H_MIN && h <= CNV_H_MAX) { cnv.style.height = h + 'px'; return; }
  const auto = autoCanvasHeight();
  cnv.style.height = auto ? auto + 'px' : '';
}
function bindCanvasResizer() {
  const grip = document.getElementById('cnvgrip');
  if (!grip) return;
  let drag = null;
  grip.addEventListener('pointerdown', e => {
    e.preventDefault(); // don't start a text selection while dragging
    try { grip.setPointerCapture(e.pointerId); } catch (err) { /* no active pointer session */ }
    // computed height, not getBoundingClientRect(): the latter includes the
    // 1px border, so successive drags would creep upward by a pixel each time.
    drag = { y: e.clientY, h: parseFloat(getComputedStyle(cnv).height) };
  });
  grip.addEventListener('pointermove', e => {
    if (!drag) return;
    const h = Math.max(CNV_H_MIN, Math.min(CNV_H_MAX, Math.round(drag.h + e.clientY - drag.y)));
    cnv.style.height = h + 'px';
    onCanvasResize();
  });
  const end = () => {
    if (!drag) return;
    drag = null;
    if (cnv.style.height) localStorage.setItem('emt_cnvh', String(parseInt(cnv.style.height, 10)));
  };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
  // Double-click clears the persisted height and hands the canvas back to
  // autoCanvasHeight(), which is what "reset" now means. Clearing the inline
  // style instead would restore the stylesheet's flat 460px, i.e. the very
  // value that put the plots below the fold.
  grip.addEventListener('dblclick', () => {
    localStorage.removeItem('emt_cnvh');
    syncCanvasHeight();
    onCanvasResize();
  });
}

// AC source/bus voltage params that follow the circuit's vconv convention
// (SPEC §2). Used to badge the property panel so the user sees, per param,
// whether a value is read as phase RMS (PH) or line-to-line (LL), AND to
// rescale values when the convention is toggled so the physical voltage is
// preserved (PH<->LL = multiply/divide by sqrt(3)). This must stay in sync
// with the vPh() boundary sites in blocks.js / solver.js.
const SQRT3 = Math.sqrt(3);
const VCONV_PARAMS = {
  src: ['Vrms'], gfm: ['E0', 'Vset'], syncgen: ['E0', 'Vref', 'Vset'],
  svc: ['Vref'], pfc: ['Vac'], zip: ['V0', 'vmin'], pq: ['vmin'],
  hvdc: ['vmin'], wt4: ['vmin'], gfl: ['Vrated', 'Vset'], vsw: ['Von', 'Voff'], gtrip: ['Vov', 'Vuv', 'Vblk'], bus: ['Vbase'],
};
const VCONV_TAG = () => (S.vconv === 'll') ? 'LL' : 'PH';
function vconvLabel(type, key, base) {
  const list = VCONV_PARAMS[type];
  return (list && list.includes(key)) ? base + ' (' + VCONV_TAG() + ')' : base;
}
// Scale the convention-aware voltage params on `block` by `factor` in place
// (rounded to mV to avoid float noise on repeated toggles). Sentinel 0 values
// (Vset/Vref "0=auto") are invariant: 0 * factor = 0. DC voltages, mov.Vc,
// and currents are not in VCONV_PARAMS and are left alone.
function scaleVconvParams(block, factor) {
  const keys = VCONV_PARAMS[block.type];
  if (!keys) return;
  keys.forEach(k => {
    const v = block.params[k];
    if (typeof v === 'number') block.params[k] = Math.round(v * factor * 1000) / 1000;
  });
}

function showProps() {
  // The property panel is split into two rails that appear on selection: the
  // LEFT rail (#params) holds the block header and parameter inputs (action);
  // the RIGHT rail (#science) holds the physical description + the equations /
  // equivalent-circuit science panel (reference). With nothing selected both
  // rails are hidden and the canvas spans full width. A class on .emt drives
  // the grid: .sel = single block (3 columns), .msel = multi-select (params
  // rail only, canvas spans the right two columns).
  const emt = document.querySelector('.emt');
  const pe = document.getElementById('params');
  const se = document.getElementById('science');
  if (!S.sel.length) {
    emt.classList.remove('sel', 'msel', 'nosci');
    pe.innerHTML = ''; se.innerHTML = '';
    return;
  }
  if (S.sel.length > 1) {
    emt.classList.remove('sel', 'nosci'); emt.classList.add('msel');
    se.innerHTML = '';
    pe.innerHTML = '<span style="font-weight:600;margin-right:12px">' + S.sel.length + ' blocks selected</span>'
      + '<button onclick="rotateSelected()" title="Rotate each 90° clockwise (or press R)">&#8635; rotate all</button>'
      + '<button onclick="delSelected()" title="Delete all (or press Delete)">&#128465; delete all</button>'
      + '<span class="hint">Shift/Ctrl-click a block to toggle it, or shift/ctrl-drag empty canvas to rubber-band select.</span>';
    return;
  }
  const b = S.blocks.find(x => x.id === S.sel[0]);
  if (!b) { emt.classList.remove('sel', 'msel'); pe.innerHTML = ''; se.innerHTML = ''; return; }
  emt.classList.remove('msel'); emt.classList.add('sel');
  const d = DEFS[b.type];
  const hasVconv = VCONV_PARAMS[b.type] && VCONV_PARAMS[b.type].length;
  // Left rail: header + parameter inputs (the action side).
  let pH = '<span style="font-weight:600;margin-right:12px">' + d.label + ' #' + b.id + '</span>'
    + (hasVconv ? '<span class="hint" style="margin-right:12px">V: ' + VCONV_TAG() + '</span>' : '')
    + '<button onclick="rotateSelected()" title="Rotate 90° clockwise (or press R)">&#8635; ' + (b.rot || 0) + '&deg;</button>';
  Object.entries(d.params).forEach(([k, meta]) => {
    const isText = meta.t === 'text';
    // nOps drives how many tcloseN/topenN rows render below (brk only) — its
    // onchange must also re-run showProps to redraw them immediately.
    const onChange = (b.type === 'brk' && k === 'nOps')
      ? 'setParam(' + b.id + ',\'nOps\',+this.value); showProps()'
      : 'setParam(' + b.id + ',\'' + k + '\',' + (isText ? 'this.value' : '+this.value') + ')';
    pH += '<span class="pr"><label>' + vconvLabel(b.type, k, meta.l) + '</label><input type="' + (isText ? 'text' : 'number') + '"' +
      (isText ? '' : ' step="any"') + ' value="' + escAttr(b.params[k] ?? '') +
      '" onchange="' + onChange + '"></span>';
  });
  if (b.type === 'brk') {
    const nOps = Math.max(1, Math.min(5, Math.round(+b.params.nOps || 1)));
    for (let i = 2; i <= nOps; i++) {
      const tk = 'tclose' + i, ok = 'topen' + i;
      pH += '<span class="pr"><label>t close ' + i + ' (ms)</label><input type="number" step="any" value="' +
        escAttr(b.params[tk] ?? -1) + '" onchange="setParam(' + b.id + ',\'' + tk + '\',+this.value)"></span>';
      pH += '<span class="pr"><label>t open ' + i + ' (ms)</label><input type="number" step="any" value="' +
        escAttr(b.params[ok] ?? -1) + '" onchange="setParam(' + b.id + ',\'' + ok + '\',+this.value)"></span>';
    }
  }
  if (!Object.keys(d.params).length) pH += '<span class="hint">No parameters.</span>';
  pe.innerHTML = pH;
  // Right rail: the block's physical description, then the equations /
  // equivalent-circuit science panel (the reference side).
  let sH = '';
  if (b.type === 'bus') sH += '<span class="hint">Ties every wired tap to one node: a thick junction bar for decluttering multi-connection points (1 tap works too, as a named anchor). Its node voltage is plotted automatically: pick it in a plot\'s Signals list by name; AC vs DC is detected from the circuit. Extend via # taps / length. Rotate with R for a vertical bus. Set V base to the bus\'s nominal voltage (in the circuit\'s PH/LL convention) so the power-flow annotation shows correct per-unit voltage; leave it 0 to use the slack bus voltage as the base (fine for single-voltage circuits, wrong behind a transformer).</span>';
  if (b.type === 'gfm') sH += '<span class="hint">AC/DC inverter. Runs 3-phase, in 1-ph mode, or on a single-phase lateral (behind a Phase Tap), one code path. The AC current limiter (I ac max) is 3-phase only: on a single-phase inverter it is refused, since single-phase P/Q take a full cycle to measure and cannot hold current through a fault. mode=0: grid-forming droop (f falls with P via mp, E falls with Q via mq): sets its own V/f, can island. mode=1: grid-following dispatch: PI-regulates toward the P0/Q0 setpoint instead (ki P/ki Q), assumes the network already sits near f0 (no PLL: needs a stiff source or another GFM to lock to). The bottom DC+ terminal is optional: wire it to a battery/DC bus and the inverter draws/delivers exactly the power its AC side measures (lossless, current-limited by I dc max); leave it unwired and it behaves as an idealized AC-only source, as before. Its DC current is plotted automatically (Idc signal).</span>';
  if (b.type === 'syncgen') sH += '<span class="hint">Classical synchronous generator, 3-ph mode only: round rotor, constant EMF behind Ra+Xd\' (Ld). Unlike GFM, frequency is a real dynamic state (swing equation: inertia H, damping D), not a droop line: it has genuine inertial response and will oscillate/settle after a disturbance, and multiple machines sharing a load split it via governor droop (Pm = Pm0 − Kgov·Δf; Kgov=0 = fixed mechanical power, no governor). AVR holds E via Q droop (mq/Q0), same form as GFM\'s. Frequency is plotted automatically (f signal): the actual point of this block is watching it dip and recover. Classical model only: no subtransient reactances, saturation, or exciter dynamics.</span>';
  if (b.type === 'pfc') sH += '<span class="hint">AC/DC bridge: left terminal = 3-ph AC in, right = DC+ out (return via ground). PI-regulated + current limit, unity-pf AC draw, UV shutdown. Put a cap on the DC bus. reverse=1 also allows DC→AC export (set its V ref below the DC source holding the bus). In 1-ph MODE the AC side is abstracted entirely (wire it to ground). On a single-phase LATERAL behind a Phase Tap (a different thing) the AC side IS modeled: it draws unity-pf single-phase current via a one-cycle voltage-phasor extraction, so its drawn power lags by up to a cycle during a transient, and the f param sets that window.</span>';
  if (b.type === 'batt') sH += '<span class="hint">Bidirectional DC/DC with SOC (1-ph/DC side). Discharges to hold V ref when the bus sags (stops at SOC 0); charges at ≤ I charge whenever the bus sits above V ref (stops at SOC 100). Plot its SOC from the Signals picker. Capacity default is tiny on purpose: EMT runs are milliseconds, so a realistic Ah would look flat. Right terminal = DC+ out.</span>';
  if (b.type === 'dcdc') sH += '<span class="hint">Dedicated bidirectional DC/DC converter: the typical way industry controls battery charge/discharge separately from the cell itself. Left = IN, right = OUT (regulated side). mode=0 CV: PI holds OUT at V ref. mode=1 CC: dispatches a fixed I set out of OUT (+ = IN→OUT, − = OUT→IN), no PI: a direct current/power dispatch, e.g. constant-current charging. Either side needs a cap or another regulating element to hold its voltage (a bare current source can\'t stabilize a node by itself). Wire IN to a battery at its own native voltage to step it to a different bus voltage under explicit control.</span>';
  if (b.type === 'pv') sH += '<span class="hint">PV array with an embedded DC/DC + MPPT (1-ph/DC side): panel + converter + controller as one block, generation-only (never absorbs). Its internal operating voltage (Vop) hunts around the max-power point via real Perturb & Observe, decoupled from whatever voltage the DC bus is actually at: plot Vop from the Signals picker to watch it hunt. G is a static irradiance knob (W/m², 1000 = full sun) scaling Isc/Impp linearly; Voc/Vmpp don\'t shift with irradiance in this lightweight model. Needs a cap or another regulating element (e.g. a battery) on its bus to hold a voltage.</span>';
  if (b.type === 'cpl') sH += '<span class="hint">DC block (1-ph mode). Draws P/v; sheds load below UVLO.</span>';
  if (b.type === 'line' && +b.params.C > 0) sH += '<span class="hint">π-equivalent line: series R+L plus C split evenly as a shunt cap to ground at EACH end (the standard nominal-π medium-line model). Not supported together with mutual coupling (Rm/Lm), set one to 0. Its plotted signal is still the series current, same as before; shunt charging currents aren\'t separately exposed.</span>';
  if (b.type === 'line' && +b.params.C <= 0 && isCoupled(b)) sH += '<span class="hint">Series R-L line WITH 3-phase mutual coupling (Rm/Lm). The three phases share one 3×3 L/R matrix (a single coupled element spans all phases), so only balanced currents see the positive-sequence impedance Z1 = (Rs − Rm) + jω(Ls − Lm). Not supported together with the π shunt (C>0), set one to 0. Mutually-coupled parallel circuits are not modeled (one coupling per block).</span>';
  if (b.type === 'line' && +b.params.C <= 0 && !isCoupled(b)) sH += '<span class="hint">Series R-L line (lumped), the default when C=0 and no mutuals. Trapezoidal companion; accurate below a few kHz. For longer or sharper studies use the π option (set C>0; the glyph then shows two shunt caps plus a π label) or the traveling-wave TW Line block. Plotted signal is the series current.</span>';
  if (b.type === 'rlc') sH += '<span class="hint">Series R-L-C branch (all three carry the same current, no internal node). Set any of R, L, C to -1 to drop it from the chain (a wire in its place): e.g. L=-1,C=-1 is a plain resistor; R=-1,L=-1 is a plain capacitor. R also accepts 0 for "no resistor" (same effect); L and C must use -1 specifically, since 0 already means something else for them (0 H is a harmless wire, but 0 µF is an open circuit: the opposite of absent). Setting all three to -1 collapses the branch to a near-zero-impedance short rather than erroring.</span>';
  if (b.type === 'rlcp') sH += '<span class="hint">Parallel R||L||C branch (all three share one voltage, independent currents). Sentinel convention is INVERSE of Series RLC: use -1 to drop R or L (absent, no contribution). R=0 and L=0 are REAL SHORTS in parallel: they do NOT mean absent. C accepts -1 or 0 (both give zero admittance). Setting all three absent gives a genuine open branch, not an error.</span>';
  if (b.type === 'pq') sH += '<span class="hint">Constant P+Q load (AC): the standard power-flow load model, unlike Load R\'s fixed impedance. Both P and Q stay constant as the bus voltage moves, via an RMS-tracked estimate (meas filter) rather than the instantaneous voltage (which would blow up at AC zero-crossings). Q>0 = lagging/inductive, Q<0 = leading/capacitive. f should match the circuit\'s actual frequency: it sizes the internal quarter-cycle delay used to derive Q, so it\'s only exact for a steady sinusoid at that frequency. Sheds below UVLO (vmin).</span>';
  if (b.type === 'fault') sH += '<span class="hint">Applies R fault to ground at t on; clears at first current zero after t off (-1 = never clears).</span>';
  if (b.type === 'tap') sH += '<span class="hint">Single-phase lateral tap: terminal 0 is the 3-phase side, terminal 1 the single-phase side, carrying ONLY the selected phase. Everything downstream of terminal 1 (line, load, transformer, breaker, fault) becomes single-phase automatically and returns through ground as its neutral, so a lateral is a phase-to-neutral connection: its voltage parameters are read as phase values even in LL convention. Supported on a lateral: AC source, line (no shunt C or mutuals), series/parallel RLC, cap, breaker, fault, PQ/ZIP load, arrester, a non-saturable 1-ph transformer, plus overcurrent relay, shunt controller and PFC rectifier. Traveling-wave and FD lines are not (they model long transmission circuits, not laterals), nor is a π-line or a saturable transformer. Only a Phase Tap may join a 3-phase node to a lateral: any other block bridging the two is an error. 3-phase mode only (in 1-ph mode it is a plain connector). Power flow is positive-sequence and cannot represent an unbalanced lateral, so it refuses to run on a circuit containing one; run the EMT solve directly. Connector R is a small series resistance, not a feeder impedance: leave it small and put the real impedance in a line block.</span>';
  if (b.type === 'brk') sH += '<span class="hint">t open = -1 disables opening. Opening arms at t open; each pole clears at its first current zero. init 1 = starts closed. # operations > 1 adds a reclosing sequence: after operation N clears, operation N+1\'s t close/t open take over (each op\'s own t open = -1 means "stay closed from here on"). Don\'t also target this breaker with a relay/vsw brkId while # operations > 1: both would drive the same close/open state.</span>';
  if (b.type === 'src') sH += '<span class="hint">AC voltage source: ideal sinusoidal EMF behind series Rs (Thevenin, Norton-injected), the default slack/grid source. V rms is the phase magnitude (or line, per the V: PH/LL convention); Rs is the internal impedance. No dynamics, so it is a stiff source: use it as a slack or pair it with a machine or GFM for frequency. Left terminal is the return (ground), right is the live conductor. Works in 1-ph and 3-ph.</span>';
  if (b.type === 'tline') sH += '<span class="hint">Traveling-wave line (TW = traveling-wave), the Bergeron method (Dommel 1969, the EMTP founding technique): lossless distributed LC where a wave entering one end arrives at the other exactly one travel time τ later, reflects off mismatches, and doubles at an open end. Z is the surge impedance; R is total series resistance lumped the standard way (R/4 at each end, R/2 in the middle). The two ends decouple in the matrix (diagonal-only stamps; they talk only through delayed history). Use for switching-surge and traveling-wave studies where the lumped line or π blocks smear wavefronts. τ must be ≥ dt; R=0 gives the classic lossless form.</span>';
  if (b.type === 'fdline') sH += '<span class="hint">Frequency-dependent line (FD = frequency-dependent), JMarti class (1982): characteristic impedance and attenuation are rational functions of frequency, so high-frequency wavefronts attenuate and disperse while the fundamental passes nearly unscathed (the real behavior of lines with ground return). First-order fitting only (one pole each for Zc and H); set Zlf=Zh and att=1 with a fast pole to degenerate to the Bergeron TW line. Ships canned typical parameters, no fitting from geometry. Use when the Bergeron assumption of constant Zc and attenuation is too crude.</span>';
  if (b.type === 'zip') sH += '<span class="hint">ZIP composite load (ZIP = constant-Impedance, constant-Current, constant-Power), the IEEE composite load model: real feeders are a mix, not pure-R or pure-PQ. P(V) and Q(V) are quadratics in V/V0 with weights az/ai/ap and bz/bi/bp (each triple is normalized to sum 1, so enter relative weights; an all-zero triple falls back to pure Z). UVLO sheds the I and P parts only: the Z part (heating) stays connected through a sag, the physical picture of drives tripping while resistive load persists. V0 is the nominal voltage the polynomial is scaled to (convention-aware, like a source).</span>';
  if (b.type === 'cap') sH += '<span class="hint">Shunt capacitor to ground (one-terminal, fault-block topology). Standard trapezoidal companion (G = 2C/dt). For a series capacitor in a branch use Series RLC with R=L=-1; for a switched bank put it behind a Brk and drive that Brk with the Shunt Ctl (vsw) block.</span>';
  if (b.type === 'relay') sH += '<span class="hint">Overcurrent relay (OC = overcurrent), IEEE C37.112: the protection DECISION element. A series sensing block (fixed closed conductance; the ~0.1 mV/A drop is the sensing shunt) that trips a separate Brk block by ID (brkId). Inverse-time element 51: pick a curve (MI/VI/EI) and time dial TD; it integrates the dynamic disk-travel form and trips when ∫ dt/t(M) ≥ 1, with disk flyback below pickup. Instantaneous element 50 (Iinst, 0=off) trips with no intentional delay. Plot the trip integral (0 to 1) to watch it wind up. One target breaker per relay; no directional element or reclose.</span>';
  if (b.type === 'xfmr') sH += '<span class="hint">Single-phase transformer (Xfmr = transformer): ideal ratio a=N1/N2 with primary-referred leakage R, L. Grounded two-port (both windings share ground; fine for radial PoC circuits, isolated secondaries need MNA). Saturable core is opt-in: set Lm>0 to add a magnetizing branch, then lknee/Lsat give a two-slope piecewise-linear flux-current curve (the classical inrush mechanism, since energization flux offset decays only through the external source resistance). Lm=0 (default) is the original linear model. Reports primary current (secondary = a×primary).</span>';
  if (b.type === 'xfmr3') sH += '<span class="hint">Three-phase vector-group transformer: three single-phase units with winding CONNECTIONS (Yy0, Dy1, Dy11, Yd1, Yd11). The connection is most of the zero-sequence physics: delta windings circulate zero-sequence current so it never reaches the line, ungrounded wyes block it. a = N1/N2 is the WINDING ratio (the line-line ratio carries a √3 factor per connection). Rn=-1 leaves a wye neutral ungrounded; Rn>0 grounds it through 1/Rn. 3-ph only. Yy0 with both neutrals solid reduces exactly to three independent xfmr blocks.</span>';
  if (b.type === 'xfmr3w') sH += '<span class="hint">Three-winding transformer (3W = three-winding): primary, secondary, and tertiary, all referred to the primary (a2=N1/N2, a3=N1/N3), meeting at an internal star node eliminated analytically. Terminals: 0=primary (left), 1=secondary (right top), 2=tertiary (right bottom). The delta tertiary is the classic reason these exist: with an ungrounded primary, a secondary SLG fault has no zero-sequence path except tertiary delta circulation. Connections Yy0y0, Yy0d1, Yy0d11, Yd1d1 (primary wye only). 3-ph only; no saturation on this unit.</span>';
  if (b.type === 'im') sH += '<span class="hint">Induction motor (Ind = induction), classical single-cage third-order model (Brereton, Lewis and Young 1957): the dominant dynamic load. It draws inrush at start, reaccelerates after voltage dips, and can stall; none of that is representable by a static load. Rotor transient EMF phasor plus slip are the dynamic states (stator transients neglected, same lightweight-AVM tier as gfm/syncgen). Norton current-source interface (passive, like pq/cpl): it responds to bus voltage, it does not set it. PL is the MECHANICAL load at synchronous speed (a torque spec, TL = PL/ωs·ν^kexp), NOT constant electrical power; the electrical draw varies with voltage and slip. s0=1 is a full-voltage (DOL) start. 3-ph only; no rated-voltage param (voltage comes from the bus).</span>';
  if (b.type === 'hvdc') sH += '<span class="hint">VSC-HVDC point-to-point link (HVDC = high-voltage DC): moves scheduled power between two AC systems that need not be synchronous. Two 3-ph AC terminals (shunt injections, ground return); the DC link is an INTERNAL state, not a network node. Side A regulates the DC voltage (PI on VdcRef); side B dispatches Pset through a ramp lag. Link balance: dVdc/dt = (η·P_A − P_B)/(Cdc·Vdc). Positive Pset sends power A to B; negative reverses. Classical two-level VSC AVM (no MMC internals). Vdc is plotted automatically. Not in solvePowerFlow().</span>';
  if (b.type === 'wt4') sH += '<span class="hint">Type-4 wind turbine (T4 = Type 4, full-converter): the dominant new-build generation, a current-injecting converter whose available power follows the wind. P_cmd = min(Prated, Prated·(vw/vrated)³) (cubic curve, capped at rating); vw steps to vw2 at tgust for a gust. Q0 is a fixed reactive dispatch (unity default). Converter current limit Imax scales both parts of the injection. UVLO (vmin) zeroes injection (also the soft start while the measurement window fills). No inertia, pitch, or turbine dynamics: P follows wind through the one-cycle window. 3-ph only; generator-convention (plotted P is positive-injecting).</span>';
  if (b.type === 'svc') sH += '<span class="hint">SVC / STATCOM shunt compensator (SVC = static var compensator): dynamic reactive support for weak-bus voltage. One-terminal 3-ph shunt (ground return). mode 0 SVC: thyristor-switched susceptance, clamps Iq to [Bmin·Vrms, Bmax·Vrms] (Q ∝ V² at the ceiling). mode 1 STATCOM: converter current source, clamps Iq to ±Imax (Q ∝ V at the ceiling). PI on Vref with droop slope Xs (steady state: Vref − V = Xs·Iq). Uses the pq quarter-period trick for a real susceptance with no 1/V² division. Iq is plotted automatically. Balanced positive-sequence only; not in solvePowerFlow().</span>';
  if (b.type === 'scale') sH += '<span class="hint">Aggregation scaling coupler: represents N identical parallel copies of one reference unit (a hyperscale datacenter is N copies of one 1 to 2 MW UPS chain). Build ONE reference unit at a well-conditioned native scale; term 0 (network side) carries N× term 1 current, so the shared network sees the aggregate while the reference unit senses the real unscaled voltage. Deliberately does NOT conserve power at the coupling (it stands in for the N−1 replicas never simulated). Asymmetric same-step stamp, not a real conductor. 3-ph AC only; Rf is the small coupling resistance.</span>';
  if (b.type === 'mov') sH += '<span class="hint">Surge arrester (MOV = metal-oxide varistor): the classical clamp for switching and fault-clearing overvoltages. One-terminal shunt to ground, piecewise-linear two-segment per polarity: leakage below the knee (Vc, entered as a peak voltage), affine 1/Rd slope above it (continuous at the knee, so no numerical shock). Conducts only near voltage peaks, so expect a handful of LU refactors per cycle while clamping (bounded). No α exponent, energy accumulator, or failure model: two-segment piecewise-linear only.</span>';
  if (b.type === 'vsw') sH += '<span class="hint">Switched-shunt voltage controller (Shunt Ctl = shunt controller): a SENSOR (no stamp, no injection) that closes or opens a breaker by ID (brkId) to switch a capacitor or reactor bank (the bank itself is a cap/rlc behind that Brk). mode 0 support (cap bank): close when Vrms < Von, open when Vrms > Voff (dead band holds it in). mode 1 limit (reactor bank): mirrored (close high, open low). Either condition must hold continuously for Td ms before acting (utility delay plus anti-chatter). Allows reclose (a standalone Brk forbids it): a switched shunt is built to repeat. Commanded bank state (0/1) is the aux signal.</span>';
  if (b.type === 'gtrip') sH += '<span class="hint">Latching generation-trip relay: a SENSOR (no stamp, no injection) that watches Vrms and bus frequency at its node and trips a target breaker by block ID. Four definite-time elements with pickup/dropout hysteresis: 59 (overvoltage), 27 (undervoltage), 81O (overfrequency), 81U (underfrequency). Each element has its own dwell timer; the first to time out latches the trip permanently (no reclose within a run). The 81 elements require 3-phase AC (the SRF-PLL measures frequency from three phases) and are held at zero while the PLL is not locked or Vrms is below Vblk. Measured frequency comes from the integrator state, not the VCO output, so transients do not false-trip. Aux signal reports bus frequency.</span>';
  if (b.type === 'gnd') sH += '<span class="hint">Ground reference: pins its node to 0 V (the solver\'s datum). Every circuit needs at least one; star-ground all returns here. One terminal, no params.</span>';
  if (b.type === 'probe') sH += '<span class="hint">Voltage probe: measures its node\'s voltage without loading it (no current draw, ideal). Add one per node you want to plot; pick the signal by block ID. No params.</span>';
  sH += validationNote(b.type);
  sH += sciencePanel(b);
  if (hasVconv) sH += '<span class="hint">Voltage convention: <b>' + VCONV_TAG() + '</b> (' + (S.vconv === 'll' ? 'line-to-line RMS; the solver divides by &#8730;3 in 3-ph to recover per-phase. In 1-ph LL = phase' : 'phase RMS (legacy); LL entry is available via the V: PH/LL selector in the top bar') + '). Tagged params in the left rail read in this convention. Toggle it in the top bar (V: PH/LL); switching CONVERTS already-entered tagged values by &#8730;3 so the physical voltage is preserved (undoable).</span>';
  emt.classList.toggle('nosci', !sH);
  se.innerHTML = sH;
}

// What this block's numbers have actually been checked against, shown where the
// decision to trust them gets made rather than only in VALIDATION.md. The tier
// comes from VALIDATION_TIERS, parsed from that file's scoreboard at build time,
// so the two cannot drift.
//
// Wording follows the CONTRIBUTING.md accuracy rule: never "validated" as a
// yes/no, always what it was checked against. The line about no commercial
// cross-check is shown for every block because it is true for every block; if
// that ever stops being true, this is one of the places that must change.
function validationNote(type) {
  const tier = VALIDATION_TIERS[type];
  if (!tier) return '';
  const what = {
    High: 'checked against analytical or structural references. Its dynamics have no closed form, '
      + 'so the existing checks pin the steady state or a structural property rather than the trajectory',
    Medium: 'steady state pinned against a closed-form result; the transient path to it, the control-loop '
      + 'damping and the switching instants are not independently checked',
    Low: 'checked against an exact phasor or a node identity, several to within 1e-9',
  }[tier];
  return '<span class="hint"><b>Verification:</b> ' + tier + ' cross-check priority, ' + what
    + '. No block in OpenEMT has been cross-checked against a commercial EMT program yet, which is why '
    + 'results are not certified for engineering decisions. See VALIDATION.md for this block\'s checks '
    + 'and tolerances.</span>';
}

// ---- Science / formula panel (educational layer, SPEC §5). One block at a
// time; sciencePanel dispatches by type. The induction motor (im) is the
// prototype: a collapsible "Physics & equations" section with the governing
// equations, live values substituted from the selected block's params, and a
// small equivalent-circuit SVG. Rendered inline (no KaTeX / no dependency) so it
// stays offline and build-clean; a real math renderer is the production path if
// this lands. Add a new block by writing its XSciencePanel and adding a case.
function sciNum(x, prec) {
  if (!isFinite(x)) return '∞';
  const a = Math.abs(x);
  if (a !== 0 && (a >= 1000 || a < 0.001)) return x.toExponential(2);
  return Number(x.toPrecision(prec || 3)).toString();
}
function sciencePanel(b) {
  if (b.type === 'im') return imSciencePanel(b);
  if (b.type === 'syncgen') return syncgenSciencePanel(b);
  if (b.type === 'gfm') return gfmSciencePanel(b);
  if (b.type === 'hvdc') return hvdcSciencePanel(b);
  if (b.type === 'wt4') return wt4SciencePanel(b);
  if (b.type === 'gfl') return gflSciencePanel(b);
  if (b.type === 'svc') return svcSciencePanel(b);
  if (b.type === 'line') return lineSciencePanel(b);
  if (b.type === 'tline') return tlineSciencePanel(b);
  if (b.type === 'fdline') return fdlineSciencePanel(b);
  if (b.type === 'xfmr') return xfmrSciencePanel(b);
  if (b.type === 'xfmr3') return xfmr3SciencePanel(b);
  if (b.type === 'xfmr3w') return xfmr3wSciencePanel(b);
  if (b.type === 'rlc') return rlcSciencePanel(b);
  if (b.type === 'rlcp') return rlcpSciencePanel(b);
  if (b.type === 'cap') return capSciencePanel(b);
  if (b.type === 'gnd') return gndSciencePanel(b);
  if (b.type === 'probe') return probeSciencePanel(b);
  if (b.type === 'bus') return busSciencePanel(b);
  if (b.type === 'src') return srcSciencePanel(b);
  if (b.type === 'pfc') return pfcSciencePanel(b);
  if (b.type === 'batt') return battSciencePanel(b);
  if (b.type === 'dcdc') return dcdcSciencePanel(b);
  if (b.type === 'pv') return pvSciencePanel(b);
  if (b.type === 'cpl') return cplSciencePanel(b);
  if (b.type === 'fault') return faultSciencePanel(b);
  if (b.type === 'brk') return brkSciencePanel(b);
  if (b.type === 'relay') return relaySciencePanel(b);
  if (b.type === 'mov') return movSciencePanel(b);
  if (b.type === 'vsw') return vswSciencePanel(b);
  if (b.type === 'gtrip') return gtripSciencePanel(b);
  if (b.type === 'scale') return scaleSciencePanel(b);
  if (b.type === 'zrel') return zrelSciencePanel(b);
  return '';
}
function imSciencePanel(b) {
  const p = b.params;
  const f = +p.f0, w = 2 * Math.PI * f;             // sync electrical speed
  const s = +p.s0, nu = 1 - s;                       // slip, per-unit speed
  const Xls = w * (+p.Lls) / 1000, Xm = w * (+p.Lm) / 1000, Xlr = w * (+p.Llr) / 1000;
  const Rrs = s > 0 ? (+p.Rr) / s : Infinity;        // rotor branch Rr/s
  const TL = (+p.PL) * 1000 / w * Math.pow(nu, +p.kexp); // load torque (N·m)
  const eq = (s) => '<span class="eq">' + s + '</span>';
  let h = '<details class="sci" open><summary>Physics &amp; equations</summary><div class="scibody">';
  h += '<p>An induction motor converts AC electrical power into mechanical torque through electromagnetic induction between the stator and a short-circuited rotor. It draws inrush at start, reaccelerates after voltage dips, and can stall; none of that is captured by a static load. This block is the classical third-order model (Brereton, Lewis and Young 1957): the rotor transient EMF <i>E\'</i> and slip <i>s</i> are the dynamic states, and stator transients are neglected. It interfaces to the network as a Norton current source, so it responds to bus voltage but does not set it.</p>';
  h += eq('<i>s</i> = <span class="frac"><span class="num">ω<sub>s</sub> − ω<sub>r</sub></span><span class="den">ω<sub>s</sub></span></span> ,&nbsp; ω<sub>s</sub> = 2π·<i>f</i><sub>0</sub>');
  h += '<div class="scisub">Live: <i>f</i><sub>0</sub> = <b>' + sciNum(f) + '</b> Hz, ω<sub>s</sub> = <b>' + sciNum(w) + '</b> rad/s, slip <i>s</i><sub>0</sub> = <b>' + sciNum(s) + '</b>, per-unit speed ν = <b>' + sciNum(nu) + '</b>.</div>';
  h += eq('<i>T<sub>L</sub></i> = <span class="frac"><span class="num">P<sub>L</sub></span><span class="den">ω<sub>s</sub></span></span> · (1 − <i>s</i>)<sup>k</sup>');
  h += '<div class="scisub">Live: <i>T<sub>L</sub></i> = (' + sciNum(+p.PL * 1000) + ' / ' + sciNum(w) + ') · ' + sciNum(nu) + '<sup>' + (+p.kexp) + '</sup> = <b>' + sciNum(TL) + '</b> N·m. P<sub>L</sub> is the mechanical load at synchronous speed; the (1 − <i>s</i>)<sup>k</sup> term makes fan and centrifugal loads (k = 2) drop with speed.</div>';
  h += eq('2<i>H</i>·<span class="frac"><span class="num">dν</span><span class="den">dt</span></span> = <i>T<sub>e</sub></i> − <i>T<sub>L</sub></i> &nbsp;(per unit on S<sub>base</sub>)');
  h += '<div class="scisub">Live: <i>H</i> = <b>' + sciNum(+p.H) + '</b> s, S<sub>base</sub> = <b>' + sciNum(+p.Sbase) + '</b> kVA. The swing equation: electrical torque <i>T<sub>e</sub></i> minus load torque <i>T<sub>L</sub></i> accelerates the rotor.</div>';
  h += eq('<i>T<sub>e</sub></i> = <span class="frac"><span class="num">3 · I\'<sub>r</sub><sup>2</sup> · (R<sub>r</sub>/s)</span><span class="den">ω<sub>s</sub></span></span> ,&nbsp; P<sub>ag</sub> = 3 · I\'<sub>r</sub><sup>2</sup> · <span class="frac"><span class="num">R<sub>r</sub></span><span class="den">s</span></span>');
  h += '<div class="scisub">Live: R<sub>r</sub>/s = <b>' + sciNum(Rrs) + '</b> Ω. Air-gap power P<sub>ag</sub> drives both torque (<i>T<sub>e</sub></i> = P<sub>ag</sub>/ω<sub>s</sub>) and rotor copper loss (<i>s</i>·P<sub>ag</sub>).</div>';
  h += imCircuitSvg(+p.Rs, Xls, Xm, Xlr, Rrs);
  h += '<div class="scisub">Steady-state equivalent circuit referred to the stator, at <i>f</i><sub>0</sub>. The magnetizing branch (jX<sub>m</sub>) shunts the air-gap node; the rotor branch (jX<sub>lr</sub> + R<sub>r</sub>/s) carries the referred rotor current. R<sub>r</sub>/s grows without bound as <i>s</i> → 0, which is why a lightly loaded motor draws little current.</div>';
  h += '<details class="sci sci2" open><summary>Dynamic model &amp; Norton interface</summary><div class="scibody">';
  h += '<p>Beyond the steady-state circuit, the dynamic states are the rotor transient EMF phasor <i>E\'</i> (one complex state, two real states) and slip <i>s</i>. The stator is algebraic (transients neglected), the same lightweight averaged-value-model tier used by gfm and syncgen. The network sees a Norton current injection derived from <i>E\'</i> and the terminal voltage, so the motor never sets a node voltage: it only draws.</p>';
  h += '<p>3-phase only. There is no rated-voltage parameter: the motor takes its voltage from the bus it is wired to.</p>';
  h += '</div></details></div></details>';
  return h;
}
// Inline equivalent-circuit SVG for the induction motor. IEC rectangles for
// resistors, arc-coil paths for inductors; labels carry the live reactances.
function imCircuitSvg(Rs, Xls, Xm, Xlr, Rrs) {
  const st = 'stroke="var(--tx2)" stroke-width="1.2" fill="none"';
  const tx = 'fill="var(--tx)" font-size="9" font-family="system-ui,sans-serif" text-anchor="middle"';
  const tx2 = 'fill="var(--tx2)" font-size="8.5" font-family="system-ui,sans-serif" text-anchor="middle"';
  const L = (x, y, t, c) => '<text x="' + x + '" y="' + y + '" ' + (c || tx2) + '>' + t + '</text>';
  return '<svg class="cct" viewBox="0 0 340 96" xmlns="http://www.w3.org/2000/svg" style="color:var(--tx2)">' +
    '<line x1="12" y1="24" x2="24" y2="24" ' + st + '/>' +
    '<rect x="24" y="18" width="30" height="12" ' + st + '/>' +
    '<line x1="54" y1="24" x2="64" y2="24" ' + st + '/>' +
    '<path d="M64 24 a6 6 0 0 1 12 0 a6 6 0 0 1 12 0 a6 6 0 0 1 12 0" ' + st + '/>' +
    '<line x1="100" y1="24" x2="120" y2="24" ' + st + '/>' +
    '<circle cx="110" cy="24" r="2.5" fill="var(--tx2)"/>' +
    '<path d="M120 24 a6 6 0 0 1 12 0 a6 6 0 0 1 12 0 a6 6 0 0 1 12 0" ' + st + '/>' +
    '<line x1="156" y1="24" x2="166" y2="24" ' + st + '/>' +
    '<rect x="166" y="18" width="40" height="12" ' + st + '/>' +
    '<line x1="206" y1="24" x2="226" y2="24" ' + st + '/>' +
    '<circle cx="226" cy="24" r="3.5" ' + st + '/>' +
    '<line x1="110" y1="24" x2="110" y2="28" ' + st + '/>' +
    '<path d="M110 28 a6 6 0 0 1 0 12 a6 6 0 0 1 0 12 a6 6 0 0 1 0 12" ' + st + '/>' +
    '<line x1="110" y1="64" x2="110" y2="72" ' + st + '/>' +
    '<line x1="12" y1="72" x2="226" y2="72" ' + st + '/>' +
    '<line x1="12" y1="24" x2="12" y2="72" ' + st + '/>' +
    '<circle cx="12" cy="24" r="2.5" fill="var(--tx2)"/>' +
    L(39, 12, 'Rs ' + sciNum(Rs) + 'Ω') +
    L(82, 12, 'jXls ' + sciNum(Xls) + 'Ω') +
    L(138, 12, 'jXlr ' + sciNum(Xlr) + 'Ω') +
    L(186, 12, 'Rr/s ' + sciNum(Rrs) + 'Ω') +
    L(134, 46, 'jXm ' + sciNum(Xm) + 'Ω') +
    L(22, 16, 'Stator', tx) +
    L(226, 16, 'Rotor', tx) +
    '</svg>';
}
// Shared equivalent circuit for the EMF-behind-impedance machines
// (syncgen: E ang delta behind Ra + jX'd; gfm: e_p behind Rf + jXf). Same
// drawing idiom as imCircuitSvg: IEC resistor rectangle, arc-coil inductors,
// top rail with the source on the left and the terminal node on the right,
// bottom return wire. Labels carry the live reactances.
function emfBehindZSvg(Elabel, Rname, Rval, Xname, Xval, termLabel) {
  const st = 'stroke="var(--tx2)" stroke-width="1.2" fill="none"';
  const tx = 'fill="var(--tx)" font-size="9" font-family="system-ui,sans-serif" text-anchor="middle"';
  const tx2 = 'fill="var(--tx2)" font-size="8.5" font-family="system-ui,sans-serif" text-anchor="middle"';
  const L = (x, y, t, c) => '<text x="' + x + '" y="' + y + '" ' + (c || tx2) + '>' + t + '</text>';
  return '<svg class="cct" viewBox="0 0 340 96" xmlns="http://www.w3.org/2000/svg" style="color:var(--tx2)">' +
    '<circle cx="20" cy="24" r="8" ' + st + '/>' +
    '<path d="M14 24 a3 3 0 0 1 6 0 a3 3 0 0 1 6 0" ' + st + '/>' +
    '<line x1="28" y1="24" x2="40" y2="24" ' + st + '/>' +
    '<rect x="40" y="18" width="30" height="12" ' + st + '/>' +
    '<line x1="70" y1="24" x2="80" y2="24" ' + st + '/>' +
    '<path d="M80 24 a6 6 0 0 1 12 0 a6 6 0 0 1 12 0 a6 6 0 0 1 12 0" ' + st + '/>' +
    '<line x1="116" y1="24" x2="226" y2="24" ' + st + '/>' +
    '<circle cx="226" cy="24" r="3.5" ' + st + '/>' +
    '<line x1="20" y1="24" x2="20" y2="72" ' + st + '/>' +
    '<line x1="20" y1="72" x2="226" y2="72" ' + st + '/>' +
    '<line x1="226" y1="24" x2="226" y2="72" ' + st + '/>' +
    L(20, 12, Elabel, tx) +
    L(55, 12, Rname + ' ' + sciNum(Rval) + 'Ω') +
    L(98, 12, Xname + ' ' + sciNum(Xval) + 'Ω') +
    L(226, 16, termLabel || 'V', tx) +
    '</svg>';
}
// Synchronous generator, classical model. SPEC section 2 (July 2026): the
// rotor is a spinning mass, so frequency is a real swing-equation state with
// inertia, oscillation, and governor-droop load sharing, unlike gfm's
// algebraic droop line. Classical tier: constant-magnitude transient EMF
// behind Ra + jX'd, stator transients neglected.
function syncgenSciencePanel(b) {
  const p = b.params;
  const f = +p.f0, w0 = 2 * Math.PI * f;
  const H = +p.H, Sbase = +p.Sbase, KE = H * Sbase;       // kJ (kVA*s)
  const Ra = +p.Ra, Ld = +p.Ld, Xd = w0 * Ld / 1000;        // X'd in ohms
  const Pm0 = +p.Pm0, Kgov = +p.Kgov, D = +p.D;
  const droopHz = Sbase / (Kgov || 1e-9);                   // Hz drop 0 -> rated
  const droopPct = droopHz / f * 100;
  const E0 = +p.E0, mq = +p.mq, Q0 = +p.Q0;
  const eq = (s) => '<span class="eq">' + s + '</span>';
  let h = '<details class="sci" open><summary>Physics &amp; equations</summary><div class="scibody">';
  h += '<p>A synchronous generator is a spinning rotor whose kinetic energy <i>H</i>·<i>S<sub>base</sub></i> buffers the grid: frequency is a real dynamic state, not an algebraic droop line like a GFM. After a disturbance the rotor swings against the network, oscillates, and settles, and multiple machines share load through governor droop. This block is the classical model (round rotor, constant-magnitude transient EMF <i>E</i> behind <i>R<sub>a</sub></i> + j<i>X\'<sub>d</sub></i>); stator electrical transients are neglected, the same lightweight-AVM tier as gfm and the induction motor.</p>';
  h += eq('KE = <i>H</i>·<i>S<sub>base</sub></i> ,&nbsp; ṁ = <span class="frac"><span class="num"><i>f</i><sub>0</sub>(<i>P<sub>m</sub></i> − <i>P<sub>e</sub></i> − <i>D</i>·Δ<i>f</i>)</span><span class="den">2<i>H</i>·<i>S<sub>base</sub></i></span></span> ,&nbsp; Δ<i>f</i> = <i>f</i> − <i>f</i><sub>0</sub>');
  h += '<div class="scisub">Live: <i>H</i> = <b>' + sciNum(H) + '</b> s, <i>S<sub>base</sub></i> = <b>' + sciNum(Sbase) + '</b> kVA, stored KE = <b>' + sciNum(KE) + '</b> kJ. The swing equation: mechanical power in minus electrical power out minus damping accelerates the rotor.</div>';
  h += eq('<i>P<sub>m</sub></i> = <i>P<sub>m0</sub></i> − <i>K<sub>gov</sub></i>·Δ<i>f</i> &nbsp;(governor droop, kW/Hz)');
  h += '<div class="scisub">Live: <i>P<sub>m0</sub></i> = <b>' + sciNum(Pm0) + '</b> kW, <i>K<sub>gov</sub></i> = <b>' + sciNum(Kgov) + '</b> kW/Hz. A drop of <b>' + sciNum(droopHz) + '</b> Hz (' + sciNum(droopPct) + '% of <i>f</i><sub>0</sub>) takes mechanical power from 0 to rated <i>S<sub>base</sub></i>. Damping <i>D</i> = <b>' + sciNum(D) + '</b> kW/Hz adds to droop at steady state: <i>P<sub>e</sub></i> = <i>P<sub>m0</sub></i> − (' + sciNum(Kgov) + '+' + sciNum(D) + ')·Δ<i>f</i>.</div>';
  h += eq('<i>E</i> = <i>E<sub>0</sub></i> − <i>m<sub>q</sub></i>·(<i>Q<sub>f</sub></i>/1000 − <i>Q<sub>0</sub></i>) &nbsp;(AVR Q-droop)');
  h += '<div class="scisub">Live: <i>E<sub>0</sub></i> = <b>' + sciNum(E0) + '</b> V, <i>m<sub>q</sub></i> = <b>' + sciNum(mq) + '</b> V/kvar, <i>Q<sub>0</sub></i> = <b>' + sciNum(Q0) + '</b> kvar. The field EMF backs off as the machine exports inductive Q, reusing the GFM AVR verbatim.</div>';
  h += eq('ω<sub>n</sub> = √(π<i>f<sub>0</sub>K<sub>s</sub></i> / (<i>H</i>·<i>S<sub>base</sub></i>)) ,&nbsp; ζ = <span class="frac"><span class="num"><i>f<sub>0</sub></i>·<i>D</i></span><span class="den">4<i>H</i>·<i>S<sub>base</sub></i>·ω<sub>n</sub></span></span>');
  h += '<div class="scisub">Live: <i>K<sub>s</sub></i> = ∂<i>P<sub>e</sub></i>/∂δ (the synchronizing-power coefficient) is set by the interconnection, not the block, so ω<sub>n</sub> is a property of the whole circuit; on a typical tie it lands near 1 to 2 Hz, the textbook electromechanical oscillation. ζ is the damping ratio of that swing.</div>';
  h += emfBehindZSvg('E∠δ', 'Ra', Ra, "jX'd", Xd, 'V');
  h += '<div class="scisub">Classical equivalent circuit: a constant-magnitude transient EMF <i>E</i>∠δ behind the armature resistance and transient reactance. δ is the rotor angle relative to the network; it is what swings in the equation above.</div>';
  h += '<details class="sci sci2" open><summary>Opt-in dynamics &amp; limits</summary><div class="scibody">';
  h += '<p>Two first-order control lags, both off by default (<i>T<sub>g</sub></i>=0, <i>T<sub>e</sub></i>=0) so older circuits are bit-for-bit unchanged. Governor lag <i>T<sub>g</sub></i> &gt; 0 makes <i>P<sub>m</sub></i> a state (<i>dP<sub>m</sub></i>/dt = (<i>P<sub>m0</sub></i> − <i>K<sub>gov</sub></i>·Δ<i>f</i> − <i>P<sub>m</sub></i>)/<i>T<sub>g</sub></i>, clamped to [0, <i>P<sub>max</sub></i>]) rather than the algebraic droop line. Exciter lag <i>T<sub>e</sub></i> &gt; 0 replaces the Q-droop AVR with a proportional AVR with lag (<i>E</i> = <i>E<sub>0</sub></i> + <i>K<sub>a</sub></i>·(<i>V<sub>ref</sub></i> − <i>V<sub>t</sub></i>), clamped to <i>E<sub>max</sub></i>). Classical model only: no subtransient reactances, no saturation, no PSS. Frequency is the aux signal (plot it to watch the rotor dip and recover). 3-phase only.</p>';
  h += '</div></details></div></details>';
  return h;
}
// GFM inverter AVM. SPEC section 2: controlled voltage source behind an RL
// filter; E and theta are algebraic functions of filtered measured P/Q
// (droop) or a PI setpoint (GFL). No inertia. Two modes share the branch and
// states; only the control-law tail differs.
function gfmSciencePanel(b) {
  const p = b.params;
  const mode = +p.mode;
  const f = +p.f0, w0 = 2 * Math.PI * f;
  const E0 = +p.E0, mp = +p.mp, mq = +p.mq, P0 = +p.P0, Q0 = +p.Q0;
  const Rf = +p.Rf, Lf = +p.Lf, Xf = w0 * Lf / 1000, Zf = Math.hypot(Rf, Xf);
  const Tf = +p.Tf, Iacmax = +p.Iacmax, Idcmax = +p.Idcmax, XR = Xf / (Rf || 1e-9);
  const eq = (s) => '<span class="eq">' + s + '</span>';
  let h = '<details class="sci" open><summary>Physics &amp; equations</summary><div class="scibody">';
  h += '<p>A grid-forming inverter is a controlled voltage source behind an RL filter: its EMF magnitude <i>E</i> and angle θ are driven by measured <i>P</i> and <i>Q</i>, so it sets its own voltage and frequency and can island. Unlike a synchronous generator there is no spinning mass: frequency is an algebraic function of filtered power, not a swing state, so the response is instant with no inertia. Two modes share the same branch and states; only the control-law tail differs.</p>';
  if (mode === 1) {
    h += eq('err<i>_P</i> = <i>P<sub>0</sub></i>·1000 − <i>P<sub>f</sub></i> ,&nbsp; integ<i>_P</i> += <i>k<sub>iP</sub></i>·h·err<i>_P</i>/1000');
    h += eq('ω = 2π(<i>f<sub>0</sub></i> + <i>m<sub>p</sub></i>·err<i>_P</i>/1000 + integ<i>_P</i>) ,&nbsp; <i>E</i> = <i>E<sub>0</sub></i> + <i>m<sub>q</sub></i>·err<i>_Q</i>/1000 + integ<i>_Q</i>');
    h += '<div class="scisub">Live (GFL): grid-following. Closed-loop PI drives toward the <i>P<sub>0</sub></i>/<i>Q<sub>0</sub></i> setpoint instead of drooping away from nominal. <i>m<sub>p</sub></i>/<i>m<sub>q</sub></i> are the proportional gains, <i>k<sub>iP</sub></i>/<i>k<sub>iQ</sub></i> the integral gains. No PLL: assumes the network already sits near <i>f<sub>0</sub></i> (tie it to a stiff source or another GFM).</div>';
  } else {
    h += eq('ω = 2π[<i>f<sub>0</sub></i> − <i>m<sub>p</sub></i>·(<i>P<sub>f</sub></i>/1000 − <i>P<sub>0</sub></i>)] ,&nbsp; <i>E</i> = <i>E<sub>0</sub></i> − <i>m<sub>q</sub></i>·(<i>Q<sub>f</sub></i>/1000 − <i>Q<sub>0</sub></i>)');
    h += '<div class="scisub">Live (droop): <i>f<sub>0</sub></i> = <b>' + sciNum(f) + '</b> Hz, <i>E<sub>0</sub></i> = <b>' + sciNum(E0) + '</b> V, <i>m<sub>p</sub></i> = <b>' + sciNum(mp) + '</b> Hz/kW, <i>m<sub>q</sub></i> = <b>' + sciNum(mq) + '</b> V/kvar. Each 1 kW of delivered <i>P</i> droops frequency by ' + sciNum(mp) + ' Hz; each 1 kvar of inductive <i>Q</i> droops <i>E</i> by ' + sciNum(mq) + ' V. That fixed droop is what lets two GFMs in parallel share load.</div>';
  }
  h += eq('ṗ<sub>f</sub> = (<i>p<sub>inst</sub></i> − <i>P<sub>f</sub></i>)/<i>T<sub>f</sub></i> ,&nbsp; θ̇ = ω');
  h += '<div class="scisub">Live: <i>T<sub>f</sub></i> = <b>' + sciNum(Tf) + '</b> ms measurement filter. θ is a self-clocking state (injections never read wall-clock time), which is what makes paralleling work.</div>';
  h += emfBehindZSvg('e_p', 'Rf', Rf, 'jXf', Xf, 'V');
  h += '<div class="scisub">Live: <i>R<sub>f</sub></i> = <b>' + sciNum(Rf) + '</b> Ω, <i>X<sub>f</sub></i> = <b>' + sciNum(Xf) + '</b> Ω, |Z<sub>f</sub>| = <b>' + sciNum(Zf) + '</b> Ω, X/R = <b>' + sciNum(XR) + '</b>. The filter is the only fault-current limit unless <i>I<sub>acmax</sub></i> is set.</div>';
  h += '<details class="sci sci2" open><summary>Current limit, DC port &amp; limits</summary><div class="scibody">';
  if (Iacmax > 0) {
    h += '<p>AC current limit (on, <i>I<sub>acmax</sub></i> = ' + sciNum(Iacmax) + ' A rms/ph): indirect EMF-magnitude backoff. A scale μ ∈ [0.02, 1] multiplies <i>E</i>; the largest μ that holds the branch current at the limit solves μ²<i>A</i> − 2μ<i>B</i> + <i>C</i> = <i>W</i>² with <i>W</i>² = 3·(<i>I<sub>acmax</sub></i>·|Z<sub>f</sub>|)². The affine solve (not a proportional fixed point) stays correct grid-tied after a fault clears.</p>';
  } else {
    h += '<p>AC current limit: off (<i>I<sub>acmax</sub></i> = 0). The only fault-current constraint is the coupling impedance |Z<sub>f</sub>| = ' + sciNum(Zf) + ' Ω, so a terminal fault draws roughly <i>E</i>/|Z<sub>f</sub>|.</p>';
  }
  h += '<p>Optional DC port (term 2, bottom): lossless. The DC side supplies exactly the AC power the branch measures itself delivering: <i>i<sub>cmd</sub></i> = clamp(<i>P<sub>f</sub></i>/<i>v<sub>dc</sub></i>, ±<i>I<sub>dcmax</sub></i>) (' + sciNum(Idcmax) + ' A). Wire it to a battery or DC bus and the inverter draws or delivers real energy; leave it unwired and it is an idealized AC-only source as before.</p>';
  h += '<p>The decoupled P→f / Q→V control assumes a predominantly inductive tie (X ≫ R). What matters is the TOTAL tie from the inverter to whatever sets the voltage: the filter alone is X/R = ' + sciNum(XR) + ' (inductive, the easy case), but a stiff source with nontrivial <i>R<sub>s</sub></i> behind a short cable can push the total X/R below 1, and there Q tracking is slow or poorly damped while P still converges. A taller <i>L<sub>f</sub></i> (3 mH, total X/R around 3) settles cleanly. 3-phase only.</p>';
  h += '</div></details></div></details>';
  return h;
}
// VSC-HVDC point-to-point link. SPEC section 2: two AC systems tied through
// an internal DC-link energy store. Side A regulates Vdc (PI), side B
// dispatches Pset through a lag, the capacitor absorbs the mismatch.
// Classical two-level VSC AVM, no MMC internals.
function hvdcSciencePanel(b) {
  const p = b.params;
  const Pset = +p.Pset, VdcRef = +p.VdcRef, Cdc = +p.Cdc, eff = +p.eff;
  const kp = +p.kp, ki = +p.ki, Prate = +p.Prate, Tp = +p.Tp;
  const PA = eff > 0 ? Pset / eff : Pset;                  // steady link balance: eta*P_A = P_B
  const loss = PA - Pset;
  const Edc = 0.5 * (Cdc / 1e6) * VdcRef * VdcRef;          // J
  const eq = (s) => '<span class="eq">' + s + '</span>';
  let h = '<details class="sci" open><summary>Physics &amp; equations</summary><div class="scibody">';
  h += '<p>An HVDC link moves scheduled power between two AC systems that need not be synchronous. The essential physics is the DC-link energy balance between two converter buses: side A regulates the DC voltage, side B dispatches the power schedule, and the capacitor between them stores the difference. This block is a classical two-level VSC averaged model (no MMC internals): each AC side is a quasi-steady phasor current injection.</p>';
  h += eq('<i>P<sub>A</sub></i> = clamp(<i>k<sub>p</sub></i>·(<i>V<sub>dcRef</sub></i> − <i>V<sub>dc</sub></i>) + ∫<i>k<sub>i</sub></i>·err, ±<i>P<sub>rate</sub></i>) ,&nbsp; <i>P<sub>B</sub></i> → <i>P<sub>set</sub></i> via lag <i>T<sub>p</sub></i>');
  h += '<div class="scisub">Live: side A is the DC-link voltage regulator (PI), side B follows the schedule through a first-order ramp. <i>k<sub>p</sub></i> = <b>' + sciNum(kp) + '</b> kW/V, <i>k<sub>i</sub></i> = <b>' + sciNum(ki) + '</b> kW/(V·s), <i>T<sub>p</sub></i> = <b>' + sciNum(Tp) + '</b> ms, rating <b>' + sciNum(Prate) + '</b> kW.</div>';
  h += eq('d<i>V<sub>dc</sub></i>/dt = <span class="frac"><span class="num">η·<i>P<sub>A</sub></i> − <i>P<sub>B</sub></i></span><span class="den"><i>C<sub>dc</sub></i>·<i>V<sub>dc</sub></i></span></span>');
  h += '<div class="scisub">Live: at steady state <i>V<sub>dc</sub></i> = <b>' + sciNum(VdcRef) + '</b> V and the link balances: η·<i>P<sub>A</sub></i> = <i>P<sub>B</sub></i>, so <i>P<sub>A</sub></i> = ' + sciNum(Pset) + '/' + sciNum(eff) + ' = <b>' + sciNum(PA) + '</b> kW, <i>P<sub>B</sub></i> = <b>' + sciNum(Pset) + '</b> kW. The ' + sciNum(eff) + ' efficiency deficit is converter loss: <b>' + sciNum(loss) + '</b> kW. The link stores <b>' + sciNum(Edc) + '</b> J in <i>C<sub>dc</sub></i> = ' + sciNum(Cdc) + ' µF at the reference voltage.</div>';
  h += eq('Î = (<i>P<sub>inj</sub></i> − j<i>Q</i>)·V̂ / (3|V̂|²) ,&nbsp; side A: <i>P<sub>inj</sub></i> = −<i>P<sub>A</sub></i> ,&nbsp; side B: <i>P<sub>inj</sub></i> = +<i>P<sub>B</sub></i>');
  h += '<div class="scisub">Each side injects a clean balanced sinusoid (Norton, G = 0) from its commanded complex power; a one-cycle moving average extracts the terminal-voltage phasor, with a 1 ms LPF on the injected components. Positive <i>P<sub>set</sub></i> sends power A to B; negative reverses everything (the PI pulls <i>P<sub>A</sub></i> negative on its own).</div>';
  h += hvdcDiagramSvg();
  h += '<div class="scisub">Block diagram: two AC grids tied through a DC link. Side A holds the DC voltage, side B sets the power flow, and the DC capacitor absorbs the instantaneous mismatch between them.</div>';
  h += '<details class="sci sci2" open><summary>Scope &amp; limits</summary><div class="scibody">';
  h += '<p>Lossless apart from the single lumped efficiency η; no DC-side cable model (the link is one lumped energy store), no MMC or converter switching detail, no frequency-support controls. Not represented in solvePowerFlow(); initialize it from a solved AC case or let it settle. 3-phase only. Aux signal: <i>V<sub>dc</sub></i>.</p>';
  h += '</div></details></div></details>';
  return h;
}
// HVDC block diagram: grid A, converter A, DC capacitor (Cdc, Vdc) to ground,
// converter B, grid B, with a Pset: A to B arrow on top.
function hvdcDiagramSvg() {
  const st = 'stroke="var(--tx2)" stroke-width="1.2" fill="none"';
  const fl = 'fill="var(--sfc1)" stroke="var(--tx2)" stroke-width="1.2"';
  const tx = 'fill="var(--tx)" font-size="9" font-family="system-ui,sans-serif" text-anchor="middle"';
  const tx2 = 'fill="var(--tx2)" font-size="8.5" font-family="system-ui,sans-serif" text-anchor="middle"';
  const L = (x, y, t, c) => '<text x="' + x + '" y="' + y + '" ' + (c || tx2) + '>' + t + '</text>';
  return '<svg class="cct" viewBox="0 0 340 110" xmlns="http://www.w3.org/2000/svg" style="color:var(--tx2)">' +
    '<defs><marker id="harr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6" ' + st + '/></marker></defs>' +
    '<circle cx="30" cy="60" r="14" ' + st + '/>' + '<path d="M22 60 a4 4 0 0 1 8 0 a4 4 0 0 1 8 0" ' + st + '/>' +
    '<line x1="44" y1="60" x2="70" y2="60" ' + st + '/>' +
    '<rect x="70" y="47" width="44" height="26" rx="3" ' + fl + '/>' +
    '<line x1="114" y1="60" x2="150" y2="60" ' + st + '/>' +
    '<circle cx="150" cy="60" r="2.5" fill="var(--tx2)"/>' +
    '<line x1="150" y1="60" x2="150" y2="68" ' + st + '/>' +
    '<line x1="142" y1="68" x2="158" y2="68" ' + st + '/>' +
    '<line x1="142" y1="74" x2="158" y2="74" ' + st + '/>' +
    '<line x1="150" y1="74" x2="150" y2="86" ' + st + '/>' +
    '<line x1="138" y1="86" x2="162" y2="86" ' + st + '/>' +
    '<line x1="150" y1="60" x2="186" y2="60" ' + st + '/>' +
    '<rect x="186" y="47" width="44" height="26" rx="3" ' + fl + '/>' +
    '<line x1="230" y1="60" x2="256" y2="60" ' + st + '/>' +
    '<circle cx="270" cy="60" r="14" ' + st + '/>' + '<path d="M262 60 a4 4 0 0 1 8 0 a4 4 0 0 1 8 0" ' + st + '/>' +
    '<line x1="80" y1="30" x2="226" y2="30" ' + st + ' marker-end="url(#harr)"/>' +
    L(30, 40, 'Grid A', tx) + L(92, 63, 'Conv A', tx) + L(130, 72, 'Cdc', tx2) +
    L(175, 72, 'Vdc', tx2) + L(208, 63, 'Conv B', tx) + L(270, 40, 'Grid B', tx) +
    L(153, 22, 'Pset: A to B', tx) +
    '</svg>';
}
// Type 4 (full-converter) wind turbine. SPEC section 2: a current-injecting
// converter whose available power follows the wind via the cubic curve,
// capped at rating and at the converter current limit. No inertia, no pitch.
function wt4SciencePanel(b) {
  const p = b.params;
  const Prated = +p.Prated, vrated = +p.vrated, vw = +p.vw, vw2 = +p.vw2, tg = +p.tgust;
  const Q0 = +p.Q0, Imax = +p.Imax, vmin = +p.vmin;
  const Pc = (v) => Math.min(Prated, Prated * Math.pow(v / vrated, 3));
  const Pnow = Pc(vw);
  const eq = (s) => '<span class="eq">' + s + '</span>';
  let h = '<details class="sci" open><summary>Physics &amp; equations</summary><div class="scibody">';
  h += '<p>A Type 4 (full-converter) wind turbine is, at the grid, a current-injecting converter whose available power follows the wind. The turbine and generator sit behind a full-power converter, so the grid sees only a commanded current, not a spinning mass: no inertia, no pitch dynamics, and <i>P</i> tracks the wind through a one-cycle measurement window. This block is the generic classical model: cubic power curve, rating cap, current limit.</p>';
  h += eq('<i>P<sub>cmd</sub></i> = min(<i>P<sub>rated</sub></i>, <i>P<sub>rated</sub></i>·(<i>v<sub>w</sub></i>/<i>v<sub>rated</sub></i>)³)');
  h += '<div class="scisub">Live: <i>v<sub>w</sub></i> = <b>' + sciNum(vw) + '</b> m/s, <i>v<sub>rated</sub></i> = <b>' + sciNum(vrated) + '</b> m/s, <i>P<sub>rated</sub></i> = <b>' + sciNum(Prated) + '</b> kW. The cube law <i>P</i> ∝ <i>v</i>³ gives <i>P<sub>cmd</sub></i> = ' + sciNum(Prated) + '·(' + sciNum(vw) + '/' + sciNum(vrated) + ')³ = <b>' + sciNum(Pnow) + '</b> kW' + (Pnow >= Prated ? ' (capped at rating)' : ' (below rating)') + '.</div>';
  if (vw2 > 0 && tg >= 0) {
    h += '<div class="scisub">Gust: at <i>t<sub>gust</sub></i> = ' + sciNum(tg) + ' ms the wind steps to <b>' + sciNum(vw2) + '</b> m/s and <i>P<sub>cmd</sub></i> moves to <b>' + sciNum(Pc(vw2)) + '</b> kW.</div>';
  }
  h += eq('Î = (<i>P<sub>cmd</sub></i> − j<i>Q<sub>0</sub></i>)·V̂ / (3|V̂|²) ,&nbsp; |Î| clamped to <i>I<sub>max</sub></i>');
  h += '<div class="scisub">Live: <i>Q<sub>0</sub></i> = <b>' + sciNum(Q0) + '</b> kvar (fixed reactive dispatch, unity default), <i>I<sub>max</sub></i> = <b>' + sciNum(Imax) + '</b> A rms/ph (converter current limit, scales both parts). UVLO zeroes injection below <b>' + sciNum(vmin) + '</b> V rms (also the soft start while the measurement window fills).</div>';
  h += wt4DiagramSvg(vw, vrated);
  h += '<div class="scisub">Left: the cubic power curve <i>P</i>(<i>v</i>) capped at rating, with the operating point at <i>v<sub>w</sub></i>. Right: a controlled current source injecting Î at the grid bus (generator convention, G = 0 Norton).</div>';
  h += '<details class="sci sci2" open><summary>Scope &amp; limits</summary><div class="scibody">';
  h += '<p>No wind-speed time series (a single gust step), no inertia, pitch, or turbine dynamics (<i>P</i> follows the wind instantly through the one-cycle window), no LVRT profile beyond UVLO plus the current limit. Not represented in solvePowerFlow(). Generator convention: plotted P is positive-injecting. 3-phase only. Aux signal: commanded P (kW).</p>';
  h += '</div></details></div></details>';
  return h;
}
// WT4 figure: cubic P(v) curve (capped at rating) on the left, current-source
// shunt injection at the bus on the right.
function wt4DiagramSvg(vw, vrated) {
  const st = 'stroke="var(--tx2)" stroke-width="1.2" fill="none"';
  const tx = 'fill="var(--tx)" font-size="9" font-family="system-ui,sans-serif" text-anchor="middle"';
  const tx2 = 'fill="var(--tx2)" font-size="8.5" font-family="system-ui,sans-serif" text-anchor="middle"';
  const L = (x, y, t, c) => '<text x="' + x + '" y="' + y + '" ' + (c || tx2) + '>' + t + '</text>';
  const bx = 24, by = 84, bw = 116, bh = 60;
  const xmap = (vpu) => bx + (Math.min(vpu, 1.3) / 1.3) * bw;
  const ymap = (ppu) => by - Math.min(ppu, 1.0) * bh;
  let d = 'M' + xmap(0) + ' ' + ymap(0);
  for (let i = 1; i <= 20; i++) { const vpu = i / 20; const ppu = Math.min(1, Math.pow(vpu, 3)); d += ' L' + xmap(vpu) + ' ' + ymap(ppu); }
  d += ' L' + xmap(1.3) + ' ' + ymap(1);
  const vwu = vw / vrated, pnowu = Math.min(1, Math.pow(vwu, 3));
  return '<svg class="cct" viewBox="0 0 340 96" xmlns="http://www.w3.org/2000/svg" style="color:var(--tx2)">' +
    '<line x1="' + bx + '" y1="' + by + '" x2="' + (bx + bw) + '" y2="' + by + '" ' + st + '/>' +
    '<line x1="' + bx + '" y1="' + by + '" x2="' + bx + '" y2="' + (by - bh) + '" ' + st + '/>' +
    '<path d="' + d + '" ' + st + '/>' +
    '<circle cx="' + xmap(vwu) + '" cy="' + ymap(pnowu) + '" r="2.5" fill="var(--tx2)"/>' +
    L(bx + bw / 2, by + 12, 'v / v_rated', tx) +
    L(bx - 4, by - bh / 2, 'P', tx) +
    '<line x1="200" y1="24" x2="300" y2="24" ' + st + '/>' +
    '<circle cx="250" cy="24" r="2.5" fill="var(--tx2)"/>' +
    '<line x1="250" y1="24" x2="250" y2="40" ' + st + '/>' +
    '<circle cx="250" cy="52" r="10" ' + st + '/>' +
    '<path d="M244 52 a3 3 0 0 1 6 0 a3 3 0 0 1 6 0" ' + st + '/>' +
    '<line x1="250" y1="62" x2="250" y2="78" ' + st + '/>' +
    '<line x1="240" y1="78" x2="260" y2="78" ' + st + '/>' +
    L(250, 16, 'bus', tx) + L(266, 52, 'Î', tx) +
    '</svg>';
}
// Transmission-grade GFL solar inverter (SPEC section 5 item 33). A current-
// source primitive: a controlled current injection at the grid bus with an
// explicit SRF-PLL, a per-plant current limit, a hard voltage floor, and a
// transformer-leakage Xt reflected into the converter-voltage ceiling. NO series
// filter branch is stamped (a Norton injection), which is what avoids the Lf-C
// resonance that destabilised `gfm` at transmission scale.
function gflSciencePanel(b) {
  const p = b.params;
  const Sbase = +p.Sbase, Vrated = +p.Vrated, P0 = +p.P0, Q0 = +p.Q0;
  const Imax = +p.Imax, Vfloor = +p.Vfloor, Xt = +p.Xt, Emax = +p.Emax;
  // Vrated follows the circuit's vconv (it is in VCONV_PARAMS), so the √3 only
  // applies in LL mode — mirror vPh() in blocks.js rather than assuming LL.
  const Vph = (S.vconv === 'll') ? Vrated / SQRT3 : Vrated;
  const Irated = Sbase * 1000 / (3 * Vph);
  const ImaxAbs = Imax * Irated;
  const Zbase = 3 * Vph * Vph / (Sbase * 1000); // V_LL²/S_3ph, written per-phase
  const XtAbs = Xt * Zbase;
  const eq = (s) => '<span class="eq">' + s + '</span>';
  let h = '<details class="sci" open><summary>Physics &amp; equations</summary><div class="scibody">';
  h += '<p>A grid-following solar plant is, at the grid, a controlled current source: it pushes a commanded current in phase with the terminal voltage and lets the network set the voltage. Built for transmission (40 to 400 kV) with line charging C, it carries an explicit SRF-PLL (so it follows a network not already at f0), a per-plant current limit, and a hard voltage floor. No series filter branch is stamped: the block is a Norton injection, which is exactly what avoids the Lf-C resonance that destabilised the GFM AVM at this scale.</p>';
  h += eq('SRF-PLL: δ = arg(V̂) − θ , ω = ω₀ + K<sub>p</sub>δ + K<sub>i</sub>∫δ , θ̇ = ω');
  h += '<div class="scisub">Live: the PLL drives its q-axis voltage to zero and so locks θ to the grid angle; it FREEZES below the voltage floor so it does not run away on a collapsed bus. K<sub>p</sub> = <b>' + sciNum(+p.KpPLL) + '</b> 1/s, K<sub>i</sub> = <b>' + sciNum(+p.KiPLL) + '</b> 1/s². This is the feature a free-running-clock current source (wt4) lacks.</div>';
  h += eq('Î = (<i>P<sub>0</sub></i> − j<i>Q<sub>0</sub></i>)·V̂ / (3|V̂|²) ,&nbsp; then |Î| clamped to <i>I<sub>max</sub></i>·<i>I<sub>rated</sub></i>');
  h += '<div class="scisub">Live: <i>S<sub>base</sub></i> = <b>' + sciNum(Sbase) + '</b> kVA, <i>V<sub>rated</sub></i> = <b>' + sciNum(Vrated) + '</b> V ' + VCONV_TAG() + ', so <i>I<sub>rated</sub></i> = S/(3·V<sub>ph</sub>) = <b>' + sciNum(Irated) + '</b> A rms/ph and the current limit is <b>' + sciNum(ImaxAbs) + '</b> A (<i>I<sub>max</sub></i> = ' + sciNum(Imax) + ' pu). P<sub>0</sub> = <b>' + sciNum(P0) + '</b> kW, Q<sub>0</sub> = <b>' + sciNum(Q0) + '</b> kvar.</div>';
  h += eq('voltage floor: |V̂| &lt; <i>V<sub>floor</sub></i>·V<sub>ph</sub> ⇒ Î → 0 (ramped) ,&nbsp; cures I = P/V runaway');
  h += '<div class="scisub">Live: the floor is <b>' + sciNum(Vfloor * Vph) + '</b> V (' + sciNum(Vfloor) + ' pu). Below it the injection ramps to zero rather than chasing P/V, the dual of the constant-power-load phantom-voltage trap; the PLL holds its last angle so it re-locks when V returns.</div>';
  if (Emax > 0 && Xt > 0) {
    h += eq('converter ceiling: E<sub>int</sub> = V̂ + Î·j<i>X<sub>t</sub></i> ,&nbsp; |E<sub>int</sub>| clamped to <i>E<sub>max</sub></i>·V<sub>ph</sub>');
    h += '<div class="scisub">Live: the transformer leakage <i>X<sub>t</sub></i> = ' + sciNum(Xt) + ' pu = ' + sciNum(XtAbs) + ' Ω sets the internal EMF behind it. With E<sub>max</sub> = ' + sciNum(Emax) + ' pu the current backs off when the converter would otherwise need |E<sub>int</sub>| above its ceiling to push the commanded current into a depressed bus.</div>';
  } else {
    h += '<div class="scisub">The transformer leakage <i>X<sub>t</sub></i> = ' + sciNum(Xt) + ' pu = ' + sciNum(XtAbs) + ' Ω is reflected into the current-limiting algebra and the power-flow internal-EMF back-computation, not a real branch: a series L behind an ideal current source is redundant (the current source dominates), and not stamping it is what removes the Lf-C resonance.</div>';
  }
  h += '<details class="sci sci2" open><summary>Scope &amp; limits</summary><div class="scibody">';
  h += '<p>Generic textbook AVM only (SRF-PLL, phasor current injection, voltage-reduction current limiting): no vendor LVRT or synthetic-inertia scheme, no switching dynamics. The current limit is an outer ~10 ms loop, not sub-cycle hardware current control, so the first cycles of a fault still pass the unlimited transient. Represented in solvePowerFlow() as a PV/PQ bus (with reactive limits) so multi-bus cases converge with distributed reactive support. Generator convention: plotted P is positive-injecting. 3-phase only. Aux signal: PLL frequency (Hz).</p>';
  h += '</div></details></div></details>';
  return h;
}
// SVC / STATCOM shunt compensator. SPEC section 2: one-terminal shunt that
// injects/absorbs vars to hold local voltage. Integral V loop with droop Xs;
// the two devices differ only in the ceiling (SVC: susceptance, Q ~ V^2;
// STATCOM: current, Q ~ V). Quarter-period trick gives a real susceptance.
function svcSciencePanel(b) {
  const p = b.params;
  const mode = +p.mode, Vref = +p.Vref, Xs = +p.Xs, Ki = +p.Ki, f = +p.f;
  const Bmax = +p.Bmax, Bmin = +p.Bmin, Imax = +p.Imax;
  const T = 1 / (f || 60), T4 = T / 4;
  const Qmax = mode === 1 ? 3 * Imax * Vref : 3 * Bmax * Vref * Vref;
  const Qmin = mode === 1 ? -3 * Imax * Vref : 3 * Bmin * Vref * Vref;
  const eq = (s) => '<span class="eq">' + s + '</span>';
  let h = '<details class="sci" open><summary>Physics &amp; equations</summary><div class="scibody">';
  h += '<p>An SVC or STATCOM is dynamic reactive support for a weak bus: a one-terminal shunt that injects or absorbs vars to hold the local voltage. The two classical devices share one current-source model and differ only in their ceiling: an SVC is a thyristor-switched susceptance (Q ∝ V² at the limit), a STATCOM is a converter current source (Q ∝ V at the limit). Both close an integral voltage loop with a droop slope.</p>';
  h += eq('<i>i</i><sub>drawn</sub>(ph) = −(<i>I<sub>q</sub></i>/<i>V<sub>rms</sub></i>)·<i>v</i><sub>ph</sub>(t − T/4) ,&nbsp; <i>I<sub>q</sub></i> &gt; 0 = capacitive');
  h += '<div class="scisub">Live: a quarter-period delay turns a conductance into a real susceptance with no 1/V² division (the same trick a PQ load uses). T = 1/<i>f</i> = <b>' + sciNum(T * 1000) + '</b> ms, so the delay is <b>' + sciNum(T4 * 1000) + '</b> ms.</div>';
  h += eq('d<i>I<sub>q</sub></i>/dt = <i>K<sub>i</sub></i>·(<i>V<sub>ref</sub></i> − <i>V<sub>rms</sub></i> − <i>X<sub>s</sub></i>·<i>I<sub>q</sub></i>) ,&nbsp; steady: <i>V<sub>ref</sub></i> − <i>V</i> = <i>X<sub>s</sub></i>·<i>I<sub>q</sub></i>');
  h += '<div class="scisub">Live: <i>V<sub>ref</sub></i> = <b>' + sciNum(Vref) + '</b> V, <i>X<sub>s</sub></i> = <b>' + sciNum(Xs) + '</b> V/A droop slope, <i>K<sub>i</sub></i> = <b>' + sciNum(Ki) + '</b> A/(V·s). A pure integrator with a hard clamp needs no anti-windup. At the ceiling the device pins at its limit rather than reaching <i>V<sub>ref</sub></i>.</div>';
  if (mode === 1) {
    h += eq('STATCOM: clamp <i>I<sub>q</sub></i> ∈ [−<i>I<sub>max</sub></i>, +<i>I<sub>max</sub></i>] ,&nbsp; Q ≈ 3·<i>I<sub>q</sub></i>·<i>V<sub>rms</sub></i>');
    h += '<div class="scisub">Live (STATCOM): current-limited, so Q scales with V at the ceiling. <i>I<sub>max</sub></i> = <b>' + sciNum(Imax) + '</b> A rms, Q range at <i>V<sub>ref</sub></i>: <b>' + sciNum(Qmin / 1000) + '</b> to <b>' + sciNum(Qmax / 1000) + '</b> kvar.</div>';
  } else {
    h += eq('SVC: clamp <i>I<sub>q</sub></i> ∈ [<i>B<sub>min</sub></i>·<i>V<sub>rms</sub></i>, <i>B<sub>max</sub></i>·<i>V<sub>rms</sub></i>] ,&nbsp; Q ≈ 3·<i>I<sub>q</sub></i>·<i>V<sub>rms</sub></i>');
    h += '<div class="scisub">Live (SVC): susceptance-limited, so Q scales with V² at the ceiling. <i>B<sub>max</sub></i> = <b>' + sciNum(Bmax) + '</b> S, <i>B<sub>min</sub></i> = <b>' + sciNum(Bmin) + '</b> S, Q range at <i>V<sub>ref</sub></i>: <b>' + sciNum(Qmin / 1000) + '</b> to <b>' + sciNum(Qmax / 1000) + '</b> kvar.</div>';
  }
  h += svcDiagramSvg(mode, Vref, Xs, Imax, Bmax, Bmin);
  h += '<div class="scisub">Left: the V-to-<i>I<sub>q</sub></i> droop characteristic, <i>V<sub>ref</sub></i> − V = <i>X<sub>s</sub></i>·<i>I<sub>q</sub></i>, capped at the device ceiling. Right: the shunt current source at the bus.</div>';
  h += '<details class="sci sci2" open><summary>Scope &amp; limits</summary><div class="scibody">';
  h += '<p>Balanced positive-sequence only; no harmonic or TCR switching detail. The quarter-period reference shares the PQ load off-nominal-frequency caveat (exact only for a steady sinusoid at <i>f</i>). Not represented in solvePowerFlow(). Aux signal: <i>I<sub>q</sub></i>.</p>';
  h += '</div></details></div></details>';
  return h;
}
// SVC figure: V-Iq droop characteristic (capped at the ceiling) on the left,
// shunt current source at the bus on the right.
function svcDiagramSvg(mode, Vref, Xs, Imax, Bmax, Bmin) {
  const st = 'stroke="var(--tx2)" stroke-width="1.2" fill="none"';
  const em = 'stroke="var(--acc)" stroke-width="1.5" fill="none"';
  const tx = 'fill="var(--tx)" font-size="9" font-family="system-ui,sans-serif" text-anchor="middle"';
  const tx2 = 'fill="var(--tx2)" font-size="8.5" font-family="system-ui,sans-serif" text-anchor="middle"';
  const L = (x, y, t, c) => '<text x="' + x + '" y="' + y + '" ' + (c || tx2) + '>' + t + '</text>';
  const bx = 28, by = 78, bw = 110, bh = 56;
  const Icap = mode === 1 ? Math.max(Imax, 1e-9)
    : Math.max(Bmax * Vref, Math.abs(Bmin * Vref), 1e-9);
  const Vhi = Vref + Xs * Icap, Vlo = Vref - Xs * Icap;
  const vmap = (V) => by - ((V - Vlo) / (Vhi - Vlo || 1e-9)) * bh;
  const imap = (I) => bx + ((I + Icap) / (2 * Icap)) * bw;
  const x0 = imap(0), yref = vmap(Vref);
  return '<svg class="cct" viewBox="0 0 340 96" xmlns="http://www.w3.org/2000/svg" style="color:var(--tx2)">' +
    '<line x1="' + bx + '" y1="' + by + '" x2="' + (bx + bw) + '" y2="' + by + '" ' + st + '/>' +
    '<line x1="' + x0 + '" y1="' + by + '" x2="' + x0 + '" y2="' + (by - bh) + '" ' + st + '/>' +
    '<line x1="' + imap(-Icap) + '" y1="' + vmap(Vhi) + '" x2="' + imap(Icap) + '" y2="' + vmap(Vlo) + '" ' + em + '/>' +
    '<line x1="' + imap(-Icap) + '" y1="' + vmap(Vhi) + '" x2="' + imap(-Icap) + '" y2="' + (by + 4) + '" ' + st + ' stroke-dasharray="2 2"/>' +
    '<line x1="' + imap(Icap) + '" y1="' + vmap(Vlo) + '" x2="' + imap(Icap) + '" y2="' + (by + 4) + '" ' + st + ' stroke-dasharray="2 2"/>' +
    L(bx + bw / 2, by + 12, 'Iq (cap to ind)', tx) +
    L(x0 - 4, by - bh / 2, 'V', tx) +
    L(x0 + 4, yref + 3, 'Vref', tx2) +
    '<line x1="200" y1="24" x2="300" y2="24" ' + st + '/>' +
    '<circle cx="250" cy="24" r="2.5" fill="var(--tx2)"/>' +
    '<line x1="250" y1="24" x2="250" y2="40" ' + st + '/>' +
    '<circle cx="250" cy="52" r="10" ' + st + '/>' +
    '<path d="M244 52 a3 3 0 0 1 6 0 a3 3 0 0 1 6 0" ' + st + '/>' +
    '<line x1="250" y1="62" x2="250" y2="78" ' + st + '/>' +
    '<line x1="240" y1="78" x2="260" y2="78" ' + st + '/>' +
    L(250, 16, 'bus', tx) + L(266, 52, 'Iq', tx) +
    '</svg>';
}
// Series / pi / coupled line. SPEC section 2: a 2-terminal branch solved
// with the trapezoidal companion in the time domain (frequency-agnostic).
// Three models share one block: plain series RL (default), nominal-pi with
// shunt charging (C > 0), and 3-phase mutually coupled (Rm/Lm). The panel
// uses 60 Hz as a labeled reference for the phasor illustrations since the
// block itself carries no frequency parameter.
function lineSciencePanel(b) {
  const p = b.params;
  const R = +p.R, L = +p.L, Lh = L / 1000;
  const C = +p.C, Rm = +p.Rm, Lm = +p.Lm, Lmh = Lm / 1000;
  const fref = 60, w = 2 * Math.PI * fref;
  const XL = w * Lh, Zmag = Math.hypot(R, XL);
  const pi = C > 0, coupled = (Rm !== 0 || Lm !== 0);
  const eq = (s) => '<span class="eq">' + s + '</span>';
  let h = '<details class="sci" open><summary>Physics &amp; equations</summary><div class="scibody">';
  h += '<p>A line is a 2-terminal branch solved in the time domain by the trapezoidal companion, so it is frequency-agnostic: it responds correctly at whatever frequency the circuit runs at, not a fixed one. The same block covers three models selected by its parameters: a plain series R-L (the default), a nominal-π with shunt charging capacitance (C &gt; 0), and a 3-phase mutually coupled line (Rm/Lm). The phasor values below use 60 Hz as a labeled reference for intuition; the block itself carries no frequency.</p>';
  h += eq('<i>v</i> = <i>R</i>·<i>i</i> + <i>L</i>·d<i>i</i>/d<i>t</i> ,&nbsp; R<i>eq</i> = <i>R</i> + 2<i>L</i>/d<i>t</i> ,&nbsp; <i>i<sub>n</sub></i> = <span class="frac"><span class="num"><i>v<sub>n</sub></i> + <i>v<sub>n−1</sub></i> − <i>i<sub>n−1</sub></i>·(<i>R</i> − 2<i>L</i>/d<i>t</i>)</span><span class="den">R<i>eq</i></span></span>');
  h += '<div class="scisub">Live: <i>R</i> = <b>' + sciNum(R) + '</b> Ω, <i>L</i> = <b>' + sciNum(L) + '</b> mH. The trapezoidal companion turns the differential branch into a conductance G = 1/R<i>eq</i> plus a history source updated each step; this is the form the solver actually stamps.</div>';
  if (pi) {
    const Cf = C / 1e6, Ys = w * Cf;
    const Zc = Math.sqrt(Zmag / (Ys || 1e-9));
    h += eq('π: series <i>R</i>+j<i>ωL</i> in the middle, <i>C</i>/2 to ground at EACH end ,&nbsp; Z<sub>c</sub> = √(Z/Y)');
    h += '<div class="scisub">Live (π): <i>C</i> = <b>' + sciNum(C) + '</b> µF total, split as C/2 at each end. At 60 Hz the series impedance is <b>' + sciNum(R) + '</b> + j<b>' + sciNum(XL) + '</b> Ω (|Z| = ' + sciNum(Zmag) + '), the total shunt admittance is jωC = <b>' + sciNum(Ys) + '</b> S, and the characteristic impedance is |Z<sub>c</sub>| = √(|Z|/ωC) = <b>' + sciNum(Zc) + '</b> Ω. The nominal-π is accurate for medium-length lines where charging current matters but full wave propagation does not.</div>';
  } else if (coupled) {
    const X1 = w * (Lh - Lmh), Z1mag = Math.hypot(R - Rm, X1);
    const X0 = w * (Lh + 2 * Lmh), Z0mag = Math.hypot(R + 2 * Rm, X0);
    h += eq('R = [[R<sub>s</sub>,R<sub>m</sub>,R<sub>m</sub>],...], L likewise ,&nbsp; Z<sub>1</sub> = (R<sub>s</sub>−R<sub>m</sub>) + jω(L<sub>s</sub>−L<sub>m</sub>)');
    h += '<div class="scisub">Live (coupled): the three phases share one 3×3 R/L matrix (a single coupled element spans all phases), so balanced currents see the positive-sequence impedance Z<sub>1</sub> = ' + sciNum(R - Rm) + ' + j' + sciNum(X1) + ' Ω (|Z<sub>1</sub>| = <b>' + sciNum(Z1mag) + '</b>), while ground-return (zero-sequence) currents see Z<sub>0</sub> = ' + sciNum(R + 2 * Rm) + ' + j' + sciNum(X0) + ' Ω (|Z<sub>0</sub>| = <b>' + sciNum(Z0mag) + '</b>). Mutual L<sub>m</sub>/L<sub>s</sub> = ' + sciNum(Lmh / (Lh || 1e-9)) + '.</div>';
  } else {
    h += eq('Z = <i>R</i> + j<i>ωL</i> ,&nbsp; |Z| = √(R² + (ωL)²)');
    h += '<div class="scisub">Live (series RL): at 60 Hz, X<sub>L</sub> = ωL = <b>' + sciNum(XL) + '</b> Ω, |Z| = <b>' + sciNum(Zmag) + '</b> Ω, X/R = <b>' + sciNum(XL / (R || 1e-9)) + '</b>. Accurate below a few kHz; for longer or sharper studies switch to the π option (set C &gt; 0) or the traveling-wave TW Line block.</div>';
  }
  h += lineSvg(pi, coupled, R, XL, C);
  h += '<div class="scisub">' + (pi ? 'Nominal-π equivalent: series R-L with a shunt capacitor to ground at each end (C/2 each), the standard medium-line model.'
    : coupled ? 'Three mutually coupled phases: each phase is a series R-L, with mutual Rm/Lm linking all three (the M bar). Only balanced currents see Z₁; unbalanced currents see the full 3×3 matrix.'
    : 'Series R-L branch: a resistor and an inductor in series between the two terminals, the default line.') + '</div>';
  h += '<details class="sci sci2" open><summary>Numerics &amp; limits</summary><div class="scibody">';
  h += '<p>Trapezoidal companion (Req = R + 2L/dt); after a switching event the solver swaps in two backward-Euler half-steps at dt/2 for one step (CDA), which kills the Nyquist ringing pure trapezoidal leaves, while keeping the same conductance so the LU is reused. Coupled 3-phase and the π shunt cannot be combined (set one to 0): the coupled path is a single 3×3 spanning element, the π path loops per-phase shunts. The plotted signal is the series current (the π shunt charging currents are not separately exposed). Mutually-coupled parallel circuits are not modeled (one coupling per block).</p>';
  h += '</div></details></div></details>';
  return h;
}
// Line equivalent-circuit SVG. Three shapes: a single-phase series R-L chain
// (plain), the same with C/2 shunt caps to ground at each end (pi), or three
// mutually-coupled phase branches with an M bar (coupled).
function lineSvg(pi, coupled, R, XL, C) {
  const st = 'stroke="var(--tx2)" stroke-width="1.2" fill="none"';
  const tx = 'fill="var(--tx)" font-size="9" font-family="system-ui,sans-serif" text-anchor="middle"';
  const tx2 = 'fill="var(--tx2)" font-size="8.5" font-family="system-ui,sans-serif" text-anchor="middle"';
  const L = (x, y, t, c) => '<text x="' + x + '" y="' + y + '" ' + (c || tx2) + '>' + t + '</text>';
  if (coupled) {
    const ys = [22, 55, 88], lbl = ['a', 'b', 'c'];
    let s = '<svg class="cct" viewBox="0 0 340 110" xmlns="http://www.w3.org/2000/svg" style="color:var(--tx2)">';
    ys.forEach((y, k) => {
      s += '<circle cx="12" cy="' + y + '" r="2.5" ' + st + '/>';
      s += '<line x1="12" y1="' + y + '" x2="40" y2="' + y + '" ' + st + '/>';
      s += '<rect x="40" y="' + (y - 6) + '" width="30" height="12" ' + st + '/>';
      s += '<line x1="70" y1="' + y + '" x2="80" y2="' + y + '" ' + st + '/>';
      s += '<path d="M80 ' + y + ' a6 6 0 0 1 12 0 a6 6 0 0 1 12 0 a6 6 0 0 1 12 0" ' + st + '/>';
      s += '<line x1="116" y1="' + y + '" x2="226" y2="' + y + '" ' + st + '/>';
      s += '<circle cx="226" cy="' + y + '" r="2.5" ' + st + '/>';
      s += L(55, y - 8, 'R' + lbl[k]);
      s += L(98, y - 8, 'jL' + lbl[k]);
    });
    s += '<line x1="116" y1="22" x2="116" y2="88" stroke="var(--acc)" stroke-width="2.2"/>';
    s += L(116, 14, 'M', tx);
    return s + '</svg>';
  }
  let s = '<svg class="cct" viewBox="0 0 340 ' + (pi ? 110 : 96) + '" xmlns="http://www.w3.org/2000/svg" style="color:var(--tx2)">';
  const y = 30;
  s += '<circle cx="12" cy="' + y + '" r="2.5" ' + st + '/>';
  s += '<line x1="12" y1="' + y + '" x2="40" y2="' + y + '" ' + st + '/>';
  s += '<rect x="40" y="' + (y - 6) + '" width="30" height="12" ' + st + '/>';
  s += '<line x1="70" y1="' + y + '" x2="80" y2="' + y + '" ' + st + '/>';
  s += '<path d="M80 ' + y + ' a6 6 0 0 1 12 0 a6 6 0 0 1 12 0 a6 6 0 0 1 12 0" ' + st + '/>';
  s += '<line x1="116" y1="' + y + '" x2="226" y2="' + y + '" ' + st + '/>';
  s += '<circle cx="226" cy="' + y + '" r="2.5" ' + st + '/>';
  s += L(55, y - 8, 'R ' + sciNum(R) + 'Ω');
  s += L(98, y - 8, 'jωL ' + sciNum(XL) + 'Ω');
  if (pi) {
    [30, 210].forEach(cx => {
      s += '<line x1="' + cx + '" y1="' + y + '" x2="' + cx + '" y2="' + (y + 14) + '" ' + st + '/>';
      s += '<line x1="' + (cx - 8) + '" y1="' + (y + 14) + '" x2="' + (cx + 8) + '" y2="' + (y + 14) + '" ' + st + '/>';
      s += '<line x1="' + (cx - 8) + '" y1="' + (y + 20) + '" x2="' + (cx + 8) + '" y2="' + (y + 20) + '" ' + st + '/>';
      s += '<line x1="' + cx + '" y1="' + (y + 20) + '" x2="' + cx + '" y2="' + (y + 32) + '" ' + st + '/>';
      s += '<line x1="' + (cx - 10) + '" y1="' + (y + 32) + '" x2="' + (cx + 10) + '" y2="' + (y + 32) + '" ' + st + '/>';
      s += L(cx, y + 44, 'C/2', tx2);
    });
    s += L(98, y + 18, 'π', tx);
  }
  return s + '</svg>';
}
// Bergeron traveling-wave line. SPEC section 2 (Dommel 1969): lossless
// distributed LC; a wave entering one end arrives at the other after tau,
// reflects off mismatches, doubles at an open end. R lumped the standard way
// (R/4 each end, R/2 middle). The two ends decouple in the matrix (diagonal
// stamps; they talk only through delayed history).
function tlineSciencePanel(b) {
  const p = b.params;
  const Z = +p.Z, tau = +p.tau, R = +p.R;
  const Zm = Z + R / 4, hf = (Z - R / 4) / (Z + R / 4);
  const lossless = R === 0;
  const km = 300 * tau / 1000;        // ~km at ~300 m/us overhead (labeled approx)
  const eq = (s) => '<span class="eq">' + s + '</span>';
  let h = '<details class="sci" open><summary>Physics &amp; equations</summary><div class="scibody">';
  h += '<p>A traveling-wave (Bergeron) line models true distributed propagation: a wave entering one end arrives at the other exactly one travel time τ later, reflects off any impedance mismatch, and doubles at an open end. That is the founding EMTP method (Dommel, 1969). Unlike the lumped line it does not smear sharp wavefronts, so it is the right model for switching-surge and traveling-wave studies. The two ends are decoupled in the matrix: each stamps only a diagonal conductance at its own node, and they communicate solely through delayed history terms.</p>';
  h += eq('Z<sub>m</sub> = Z + R/4 ,&nbsp; h = (Z − R/4)/(Z + R/4) ,&nbsp; <i>i<sub>k</sub></i>(t) = <i>v<sub>k</sub></i>(t)/Z<sub>m</sub> + hist<sub>k</sub>');
  h += '<div class="scisub">Live: <i>Z</i> = <b>' + sciNum(Z) + '</b> Ω surge impedance, τ = <b>' + sciNum(tau) + '</b> µs travel time, <i>R</i> = <b>' + sciNum(R) + '</b> Ω. ' + (lossless ? 'R = 0 gives the classic lossless form (h = 1).' : 'Resistance is lumped the standard way: R/4 at each end, R/2 in the middle, giving h = ' + sciNum(hf) + ' and Z<sub>m</sub> = ' + sciNum(Zm) + ' Ω.') + '</div>';
  h += eq('hist<sub>k</sub> = −<span class="frac"><span class="num">1+h</span><span class="den">2Z<sub>m</sub></span></span>·<i>v<sub>m</sub></i>(t−τ) − <span class="frac"><span class="num">(1+h)·h</span><span class="den">2</span></span>·<i>i<sub>m</sub></i>(t−τ) − <span class="frac"><span class="num">1−h</span><span class="den">2Z<sub>m</sub></span></span>·<i>v<sub>k</sub></i>(t−τ)');
  h += '<div class="scisub">Each end\'s history is a linear combination of the τ-delayed voltages and currents at BOTH ends (the four terms above). τ must be ≥ dt; the delayed read is linearly interpolated, so τ need not be an integer number of steps. At typical overhead propagation velocity (~300 m/µs), τ = ' + sciNum(tau) + ' µs is roughly ' + sciNum(km) + ' km of line.</div>';
  h += tlineSvg();
  h += '<div class="scisub">A wavefront launched at end k propagates to end m, arriving after τ; a mismatch at m reflects a wave back toward k. At an open end the reflected voltage equals the incident, so the terminal voltage doubles.</div>';
  h += '<details class="sci sci2" open><summary>Numerics &amp; limits</summary><div class="scibody">';
  h += '<p>Lossless propagation with lumped R (no frequency-dependent attenuation, that is the FD Line\'s job). Balanced per-phase only (no coupled-mode Bergeron in this pass; ground return implicit). On backward-Euler CDA half-steps the element stores only on the second half-step so the delay buffer clock is not skewed. AC-side use intended.</p>';
  h += '</div></details></div></details>';
  return h;
}
// TW line propagation figure: two end nodes k and m, a forward wavefront with
// arrow, and a dashed reflected wave returning from the mismatch at m.
function tlineSvg() {
  const st = 'stroke="var(--tx2)" stroke-width="1.2" fill="none"';
  const em = 'stroke="var(--acc)" stroke-width="1.5" fill="none"';
  const tx = 'fill="var(--tx)" font-size="9" font-family="system-ui,sans-serif" text-anchor="middle"';
  const tx2 = 'fill="var(--tx2)" font-size="8.5" font-family="system-ui,sans-serif" text-anchor="middle"';
  const L = (x, y, t, c) => '<text x="' + x + '" y="' + y + '" ' + (c || tx2) + '>' + t + '</text>';
  return '<svg class="cct" viewBox="0 0 340 96" xmlns="http://www.w3.org/2000/svg" style="color:var(--tx2)">' +
    '<defs><marker id="tarr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6" ' + st + '/></marker></defs>' +
    '<circle cx="30" cy="48" r="3.5" ' + st + '/>' + L(30, 38, 'k', tx) +
    '<circle cx="310" cy="48" r="3.5" ' + st + '/>' + L(310, 38, 'm', tx) +
    '<line x1="30" y1="48" x2="310" y2="48" ' + st + '/>' +
    '<path d="M120 48 L150 38 L150 58 Z" fill="var(--acc)" stroke="none"/>' +
    '<line x1="150" y1="48" x2="210" y2="48" ' + em + ' marker-end="url(#tarr)"/>' +
    L(180, 30, 'forward (arrives after τ)', tx) +
    '<line x1="210" y1="62" x2="150" y2="62" ' + st + ' stroke-dasharray="3 3" marker-end="url(#tarr)"/>' +
    L(180, 76, 'reflected at mismatch', tx2) +
    '</svg>';
}
// Frequency-dependent line, JMarti class. SPEC section 2 (Marti 1982, Semlyen
// recursive convolution): Zc and the propagation H are rational functions of
// frequency, so high-frequency wavefronts attenuate and disperse while the
// fundamental passes nearly unscathed. Minimum fitting order (one pole each),
// canned typical parameters.
function fdlineSciencePanel(b) {
  const p = b.params;
  const Zh = +p.Zh, Zlf = +p.Zlf, fz = +p.fz, att = +p.att, fh = +p.fh, tau = +p.tau;
  const pz = 2 * Math.PI * fz, ph = 2 * Math.PI * fh;
  const kz = (Zlf - Zh) * pz, kh = att * ph;
  const degen = (Math.abs(Zlf - Zh) < 1e-9) && (Math.abs(att - 1) < 1e-9);
  const eq = (s) => '<span class="eq">' + s + '</span>';
  let h = '<details class="sci" open><summary>Physics &amp; equations</summary><div class="scibody">';
  h += '<p>A frequency-dependent (JMarti) line is the Bergeron line with real line physics: the characteristic impedance and the propagation are rational functions of frequency, so high-frequency wavefronts attenuate and disperse while the fundamental passes nearly unscathed. That is the behavior of lines with ground return, which the constant-Z<sub>c</sub> Bergeron line cannot represent. This block ships minimum fitting order (one pole each for Z<sub>c</sub> and H) with canned typical parameters; a real JMarti fit uses 5 to 15 poles and is where the complexity lives.</p>';
  h += eq('Z<sub>c</sub>(s) = Z<sub>h</sub> + k<sub>z</sub>/(s + p<sub>z</sub>) ,&nbsp; k<sub>z</sub> = (Z<sub>lf</sub> − Z<sub>h</sub>)·p<sub>z</sub>');
  h += '<div class="scisub">Live: Z<sub>c</sub> is Z<sub>lf</sub> = <b>' + sciNum(Zlf) + '</b> Ω at dc and rolls to Z<sub>h</sub> = <b>' + sciNum(Zh) + '</b> Ω at high frequency, through pole p<sub>z</sub> = 2π·' + sciNum(fz) + ' = <b>' + sciNum(pz) + '</b> rad/s (k<sub>z</sub> = ' + sciNum(kz) + ').</div>';
  h += eq('H(s) = e<sup>−sτ</sup>·k<sub>h</sub>/(s + p<sub>h</sub>) ,&nbsp; k<sub>h</sub> = att·p<sub>h</sub>');
  h += '<div class="scisub">Live: the propagation H is a travel-time delay e<sup>−sτ</sup> (τ = <b>' + sciNum(tau) + '</b> µs) times a one-pole smear with dc gain att = <b>' + sciNum(att) + '</b> and pole p<sub>h</sub> = 2π·' + sciNum(fh) + ' = <b>' + sciNum(ph) + '</b> rad/s. High-frequency content is attenuated and spread in time; the fundamental is not.</div>';
  h += eq('F<sub>k</sub> = v<sub>k</sub> + Z<sub>c</sub>·i<sub>k</sub> ,&nbsp; B<sub>k</sub> = v<sub>k</sub> − Z<sub>c</sub>·i<sub>k</sub> ,&nbsp; B<sub>k</sub> = H∗F<sub>m</sub>');
  h += '<div class="scisub">Forward and backward waves at each end; the backward wave at k is the forward wave at m, propagated through H. Recursive convolution (a one-pole kernel) gives an exact per-step recurrence y<sub>n</sub> = a·y<sub>n−1</sub> + b·x<sub>n</sub> + c·x<sub>n−1</sub>, so no history buffer of growing length is stored.</div>';
  if (degen) h += '<div class="scisub">With Z<sub>lf</sub> = Z<sub>h</sub> and att = 1 this degenerates exactly to the Bergeron (TW) line: constant Z<sub>c</sub>, no attenuation, pure delay.</div>';
  h += fdlineSvg(Zlf, Zh, fz, kz, pz, att, kh, ph, fh);
  h += '<div class="scisub">Left: |Z<sub>c</sub>(f)| rolling from Z<sub>lf</sub> at dc to Z<sub>h</sub> at high frequency. Right: |H(f)|, the propagation attenuation, dc gain att rolling off at p<sub>h</sub>.</div>';
  h += '<details class="sci sci2" open><summary>Numerics &amp; limits</summary><div class="scibody">';
  h += '<p>First-order fitting only (one pole each for Z<sub>c</sub> and H): accuracy beyond the fundamental and the first wavefront is qualitative. Per-phase and balanced only, no fitting from geometry, and the propagation recursion double-advances on CDA event steps (the same accepted half-step slop as the TW line\'s delay buffer). Diagonal-only stamps and τ-delayed F buffers exactly like the Bergeron line.</p>';
  h += '</div></details></div></details>';
  return h;
}
// FD line figure: |Zc(f)| (dc Zlf -> HF Zh, one pole at fz) on the left, |H(f)|
// (dc gain att, one pole at fh) on the right. Log-frequency axes, sampled
// from the actual rational functions.
function fdlineSvg(Zlf, Zh, fz, kz, pz, att, kh, ph, fh) {
  const st = 'stroke="var(--tx2)" stroke-width="1.2" fill="none"';
  const em = 'stroke="var(--acc)" stroke-width="1.5" fill="none"';
  const tx = 'fill="var(--tx)" font-size="9" font-family="system-ui,sans-serif" text-anchor="middle"';
  const tx2 = 'fill="var(--tx2)" font-size="8.5" font-family="system-ui,sans-serif" text-anchor="middle"';
  const L = (x, y, t, c) => '<text x="' + x + '" y="' + y + '" ' + (c || tx2) + '>' + t + '</text>';
  const bx = 30, by = 78, bw = 124, bh = 54;
  const fmin = fz / 100, fmax = fz * 100;
  const lx = (f) => bx + (Math.log10(f / fmin) / Math.log10(fmax / fmin)) * bw;
  const Zhi = Math.max(Zlf, Zh), Zlo = Math.min(Zlf, Zh);
  const ly = (Zc) => by - ((Zc - Zlo) / (Zhi - Zlo || 1e-9)) * bh;
  let d = '';
  for (let i = 0; i <= 40; i++) {
    const fr = fmin * Math.pow(fmax / fmin, i / 40);
    const s = 2 * Math.PI * fr;
    const re = Zh + kz * pz / (s * s + pz * pz), im = -kz * s / (s * s + pz * pz);
    d += (i === 0 ? 'M' : ' L') + lx(fr).toFixed(1) + ' ' + ly(Math.hypot(re, im)).toFixed(1);
  }
  const bx2 = 188, by2 = 78, bw2 = 124, bh2 = 54;
  const fmin2 = fh / 100, fmax2 = fh * 100;
  const lx2 = (f) => bx2 + (Math.log10(f / fmin2) / Math.log10(fmax2 / fmin2)) * bw2;
  const ly2 = (Hm) => by2 - (Hm / (att || 1e-9)) * bh2;
  let d2 = '';
  for (let i = 0; i <= 40; i++) {
    const fr = fmin2 * Math.pow(fmax2 / fmin2, i / 40);
    const s = 2 * Math.PI * fr;
    d2 += (i === 0 ? 'M' : ' L') + lx2(fr).toFixed(1) + ' ' + ly2(kh / Math.hypot(s, ph)).toFixed(1);
  }
  const topZ = (Zlf >= Zh ? 'Zlf' : 'Zh'), botZ = (Zlf >= Zh ? 'Zh' : 'Zlf');
  return '<svg class="cct" viewBox="0 0 340 96" xmlns="http://www.w3.org/2000/svg" style="color:var(--tx2)">' +
    '<line x1="' + bx + '" y1="' + by + '" x2="' + (bx + bw) + '" y2="' + by + '" ' + st + '/>' +
    '<line x1="' + bx + '" y1="' + by + '" x2="' + bx + '" y2="' + (by - bh) + '" ' + st + '/>' +
    '<path d="' + d + '" ' + em + '/>' +
    L(bx + bw / 2, by + 12, 'f (log)', tx) + L(bx - 5, by - bh + 2, topZ, tx2) + L(bx - 5, by - 2, botZ, tx2) +
    L(bx + bw / 2, by - bh - 5, '|Zc(f)|', tx) +
    '<line x1="' + bx2 + '" y1="' + by2 + '" x2="' + (bx2 + bw2) + '" y2="' + by2 + '" ' + st + '/>' +
    '<line x1="' + bx2 + '" y1="' + by2 + '" x2="' + bx2 + '" y2="' + (by2 - bh2) + '" ' + st + '/>' +
    '<path d="' + d2 + '" ' + em + '/>' +
    L(bx2 + bw2 / 2, by2 + 12, 'f (log)', tx) + L(bx2 - 5, by2 - bh2 + 2, 'att', tx2) +
    L(bx2 + bw2 / 2, by2 - bh2 - 5, '|H(f)|', tx) +
    '</svg>';
}
// Single-phase transformer: ideal turns ratio with primary-referred leakage,
// grounded two-port. SPEC section 2. Opt-in piecewise-linear saturable
// magnetizing branch (Lm > 0) is where inrush lives. 60 Hz is a labeled
// reference for the reactance illustrations (the block carries no frequency).
function xfmrSciencePanel(b) {
  const p = b.params;
  const a = xfmrA(p, 'xfmr'), R = +p.R, L = +p.L, Lm = +p.Lm, lknee = +p.lknee, Lsat = +p.Lsat;
  const fref = 60, w = 2 * Math.PI * fref;
  const XL = w * L / 1000, Zmag = Math.hypot(R, XL);
  const sat = Lm > 0;
  const Xm = sat ? w * Lm / 1000 : 0;
  const eq = (s) => '<span class="eq">' + s + '</span>';
  let h = '<details class="sci" open><summary>Physics &amp; equations</summary><div class="scibody">';
  h += '<p>A transformer is an ideal turns ratio with leakage: the primary and secondary share a magnetic core, so a ratio <i>a</i> = N1/N2 sets V2 = V1/<i>a</i>, and the windings\' imperfection is a series R-L leakage on the primary side. This block is a grounded two-port (both windings share the ground reference), suited to radial point-of-common-coupling circuits; isolated secondaries need full MNA. A piecewise-linear saturable magnetizing branch is opt-in (Lm &gt; 0): the classical inrush mechanism lives there.</p>';
  h += eq('a = N<sub>1</sub>/N<sub>2</sub> ,&nbsp; v<sub>b</sub> = v<sub>1</sub> − a·v<sub>2</sub> ,&nbsp; <i>i<sub>1</sub></i> = G·v<sub>b</sub> + I<sub>h</sub> ,&nbsp; G = 1/(R + 2L/d<sub>t</sub>)');
  h += '<div class="scisub">Live: <i>a</i> = <b>' + sciNum(a) + '</b> (so V2 = V1/' + sciNum(a) + '), leakage <i>R</i> = <b>' + sciNum(R) + '</b> Ω, <i>L</i> = <b>' + sciNum(L) + '</b> mH. At 60 Hz the leakage reactance is X<sub>L</sub> = <b>' + sciNum(XL) + '</b> Ω (|Z<sub>leak</sub>| = ' + sciNum(Zmag) + '). The leakage is the standard series-RL companion on v<sub>b</sub>; the ideal part is lossless (v1·i1 − a·i1·v2 = i1·v<sub>b</sub>).</div>';
  h += eq('Y = G·[[1, −a],[−a, a²]] ,&nbsp; I<sub>into node 2</sub> = a·i<sub>1</sub>');
  h += '<div class="scisub">The 2×2 nodal stamp is symmetric (same LU machinery as every element); every ordinary element is the a = 1 case. Reported current is the primary i1 (secondary = a·i1).</div>';
  if (sat) {
    h += eq('λ += (d<sub>t</sub>/2)·(v + v<sub>prev</sub>) ,&nbsp; |λ| ≤ λ<sub>k</sub>: i<sub>m</sub> = λ/L<sub>m</sub> ; |λ| &gt; λ<sub>k</sub>: i<sub>m</sub> = sign(λ)·λ<sub>k</sub>/L<sub>m</sub> + (λ − sign(λ)·λ<sub>k</sub>)/L<sub>sat</sub>');
    h += '<div class="scisub">Live (saturating): X<sub>m</sub> = <b>' + sciNum(Xm) + '</b> Ω' + (lknee > 0 ? ', knee flux λ<sub>k</sub> = <b>' + sciNum(lknee) + '</b> V·s, saturated L<sub>sat</sub> = <b>' + sciNum(Lsat) + '</b> mH (two-slope piecewise-linear flux-current curve).' : ' (linear regime, no knee set).') + ' Energization flux offset λ(t) = λ<sub>pk</sub>·(1 − cos ωt) decays only through the EXTERNAL source resistance (τ ≈ Lm/R<sub>source</sub>): that slow decay IS inrush.</div>';
  } else {
    h += '<div class="scisub">Magnetizing branch: off (Lm = 0), the original linear model. Set Lm &gt; 0 to add the saturable shunt and model inrush.</div>';
  }
  h += xfmrSvg(sat);
  h += '<div class="scisub">' + (sat ? 'Ideal transformer with primary leakage R-L, the magnetizing branch Lm shunted at the primary (the saturable shunt, in accent).' : 'Ideal transformer with primary leakage R-L; no magnetizing branch (linear model). Both windings share the ground return.') + '</div>';
  h += '<details class="sci sci2" open><summary>Scope &amp; limits</summary><div class="scibody">';
  h += '<p>Single-phase, grounded two-port (both windings share ground; isolated secondaries need MNA). Saturation is two-slope piecewise-linear (no hysteresis, no reverse-coupling). The saturable path becomes a spanning element (it stamps an independent shunt at one terminal, like the π line). solvePowerFlow() includes the linear jωLm shunt when Lm &gt; 0. Reports primary current; secondary = a×primary.</p>';
  h += '</div></details></div></details>';
  return h;
}
// Two-coil transformer SVG: primary term -> R -> jL (leakage) -> primary coil
// -> iron core (two bars) -> secondary coil -> secondary term, with a common
// ground return. Optional magnetizing shunt Lm to ground (sat only).
function xfmrSvg(sat) {
  const st = 'stroke="var(--tx2)" stroke-width="1.2" fill="none"';
  const em = 'stroke="var(--acc)" stroke-width="1.2" fill="none"';
  const tx = 'fill="var(--tx)" font-size="9" font-family="system-ui,sans-serif" text-anchor="middle"';
  const tx2 = 'fill="var(--tx2)" font-size="8.5" font-family="system-ui,sans-serif" text-anchor="middle"';
  const L = (x, y, t, c) => '<text x="' + x + '" y="' + y + '" ' + (c || tx2) + '>' + t + '</text>';
  const y = 30, gy = y + 42;
  let s = '<svg class="cct" viewBox="0 0 340 ' + (sat ? 110 : 96) + '" xmlns="http://www.w3.org/2000/svg" style="color:var(--tx2)">';
  s += '<circle cx="12" cy="' + y + '" r="2.5" ' + st + '/>';
  s += '<line x1="12" y1="' + y + '" x2="22" y2="' + y + '" ' + st + '/>';
  s += '<rect x="22" y="' + (y - 6) + '" width="26" height="12" ' + st + '/>';
  s += '<line x1="48" y1="' + y + '" x2="52" y2="' + y + '" ' + st + '/>';
  s += '<path d="M52 ' + y + ' a5 5 0 0 1 10 0 a5 5 0 0 1 10 0 a5 5 0 0 1 10 0" ' + st + '/>';
  s += '<line x1="82" y1="' + y + '" x2="94" y2="' + y + '" ' + st + '/>';
  s += '<line x1="94" y1="18" x2="94" y2="' + (y + 30) + '" ' + st + ' stroke-width="2.4"/>';
  s += '<line x1="100" y1="18" x2="100" y2="' + (y + 30) + '" ' + st + ' stroke-width="2.4"/>';
  s += '<line x1="100" y1="' + y + '" x2="112" y2="' + y + '" ' + st + '/>';
  s += '<path d="M112 ' + y + ' a5 5 0 0 1 10 0 a5 5 0 0 1 10 0 a5 5 0 0 1 10 0" ' + st + '/>';
  s += '<line x1="142" y1="' + y + '" x2="226" y2="' + y + '" ' + st + '/>';
  s += '<circle cx="226" cy="' + y + '" r="2.5" ' + st + '/>';
  s += '<line x1="12" y1="' + y + '" x2="12" y2="' + gy + '" ' + st + '/>';
  s += '<line x1="12" y1="' + gy + '" x2="226" y2="' + gy + '" ' + st + '/>';
  s += '<line x1="226" y1="' + y + '" x2="226" y2="' + gy + '" ' + st + '/>';
  s += '<line x1="115" y1="' + gy + '" x2="125" y2="' + gy + '" ' + st + '/>';
  s += '<line x1="117" y1="' + (gy + 4) + '" x2="123" y2="' + (gy + 4) + '" ' + st + '/>';
  s += '<line x1="119" y1="' + (gy + 8) + '" x2="121" y2="' + (gy + 8) + '" ' + st + '/>';
  s += L(35, y - 8, 'R');
  s += L(67, y - 8, 'jL');
  if (sat) {
    s += '<line x1="88" y1="' + y + '" x2="88" y2="' + (y + 12) + '" ' + st + '/>';
    s += '<path d="M82 ' + (y + 12) + ' a4 4 0 0 1 8 0 a4 4 0 0 1 8 0" ' + em + '/>';
    s += '<line x1="88" y1="' + (y + 20) + '" x2="88" y2="' + gy + '" ' + st + '/>';
    s += L(104, y + 18, 'Lm', tx2);
  }
  return s + '</svg>';
}
// Three-phase vector-group transformer. SPEC section 2: three single-phase
// units with winding connections (Y/delta) and a clock-number phase shift.
// The connection IS most of the zero-sequence physics (delta circulates,
// ungrounded wye blocks). 60 Hz reference for the leakage reactance.
function xfmr3SciencePanel(b) {
  const p = b.params;
  const conn = p.conn || 'Dy11';
  const a = xfmrA(p, 'xfmr3'), R = +p.R, L = +p.L, Rn1 = +p.Rn1, Rn2 = +p.Rn2;
  const fref = 60, w = 2 * Math.PI * fref;
  const XL = w * L / 1000;
  const pri = conn[0], sec = conn[1], clock = parseInt(conn.slice(2)) || 0;
  const SQ3 = Math.sqrt(3);
  const k1 = pri === 'Y' ? SQ3 : 1, k2 = sec === 'y' ? SQ3 : 1;
  const llratio = k2 / (k1 * a);
  const shift = ((-clock * 30) % 360 + 360) % 360;
  const shiftTxt = shift === 0 ? 'in phase (0°)'
    : shift <= 180 ? 'secondary leads by ' + shift + '°'
    : 'secondary lags by ' + (360 - shift) + '°';
  const neu = (rn, side) => rn === -1 ? side + ' neutral ungrounded'
    : rn > 0 ? side + ' neutral via ' + sciNum(rn) + ' Ω'
    : side + ' neutral solid';
  const eq = (s) => '<span class="eq">' + s + '</span>';
  let h = '<details class="sci" open><summary>Physics &amp; equations</summary><div class="scibody">';
  h += '<p>A three-phase vector-group transformer is three single-phase units whose windings are connected (Y or Δ), and the connection is most of the zero-sequence physics: a delta winding circulates zero-sequence current internally so it never reaches the line, and an ungrounded wye blocks it entirely. The clock number in the name (the 11 in Dy11) is the phase shift between primary and secondary in multiples of 30°. This block reuses the xfmr companion per unit; only the winding connection differs.</p>';
  h += eq('Y winding k: u<sub>k</sub> = v<sub>k</sub> − v<sub>n</sub> ; Δ winding k: u<sub>k</sub> = v<sub>k</sub> − v<sub>k+σ</sub> ,&nbsp; σ = ±1');
  h += '<div class="scisub">Live: connection <b>' + conn + '</b> (primary ' + (pri === 'Y' ? 'wye' : 'delta') + ', secondary ' + (sec === 'y' ? 'wye' : 'delta') + ', clock ' + clock + '). With positive sequence v<sub>k</sub> = V·e<sup>−j·2πk/3</sup>, a delta winding sees √3·V·e<sup>+j·σ·30°</sup>, so σ IS the clock number: ' + shiftTxt + '.</div>';
  h += eq('a = N<sub>1</sub>/N<sub>2</sub> (winding) ,&nbsp; V<sub>LL2</sub>/V<sub>LL1</sub> = k<sub>2</sub>/(k<sub>1</sub>·a) ,&nbsp; k = √3 (wye) or 1 (delta)');
  h += '<div class="scisub">Live: winding ratio a = <b>' + sciNum(a) + '</b>; the line-line ratio carries a √3 factor per connection, giving |V<sub>LL2</sub>|/|V<sub>LL1</sub>| = ' + (sec === 'y' ? '√3' : '1') + '/(' + (pri === 'Y' ? '√3' : '1') + '·' + sciNum(a) + ') = <b>' + sciNum(llratio) + '</b>. Leakage R = <b>' + sciNum(R) + '</b> Ω, L = <b>' + sciNum(L) + '</b> mH (X<sub>L</sub> = ' + sciNum(XL) + ' Ω at 60 Hz). ' + neu(Rn1, 'Primary') + '; ' + neu(Rn2, 'secondary') + '.</div>';
  h += eq('Y<sub>red</sub> = Y<sub>pp</sub> − Y<sub>pn</sub>·Y<sub>nn</sub><sup>−1</sup>·Y<sub>np</sub> &nbsp;(Kron, eliminate internal neutrals once at build)');
  h += '<div class="scisub">Each wye side that is not solidly grounded adds one internal neutral unknown (Rn &gt; 0 grounds it through 1/Rn; Rn = −1 leaves it ungrounded but still well-posed, the three winding conductances hold it). Zero-sequence circulation (delta) and blocking (ungrounded wye) fall out of the incidence structure; nothing is special-cased. Yy0 with both neutrals solid reduces exactly to three independent xfmr blocks.</div>';
  h += xfmr3Svg(conn, shift);
  h += '<div class="scisub">Vector diagram: primary phasor triangle ABC (gray) and secondary triangle abc (accent) on the same clock face, rotated by the connection\'s shift (' + shiftTxt + ').</div>';
  h += '<details class="sci sci2" open><summary>Scope &amp; limits</summary><div class="scibody">';
  h += '<p>No saturation or inrush (use the single-phase xfmr for that), no off-nominal tap, no Dd or zigzag connections. Winding-ratio (not line-line) a semantics; the line-line ratio carries the √3 factor shown above. Reports per-phase primary winding current; line current on a delta side is the difference of two winding currents and is not separately exposed. 3-phase only.</p>';
  h += '</div></details></div></details>';
  return h;
}
// xfmr3 vector diagram: two phasor triangles (ABC primary, abc secondary)
// on a clock face, the secondary rotated by the connection's phase shift.
function xfmr3Svg(conn, shift) {
  const st = 'stroke="var(--tx2)" stroke-width="1.2" fill="none"';
  const em = 'stroke="var(--acc)" stroke-width="1.5" fill="none"';
  const tx = 'fill="var(--tx)" font-size="9" font-family="system-ui,sans-serif" text-anchor="middle"';
  const tx2 = 'fill="var(--tx2)" font-size="8.5" font-family="system-ui,sans-serif" text-anchor="middle"';
  const L = (x, y, t, c) => '<text x="' + x + '" y="' + y + '" ' + (c || tx2) + '>' + t + '</text>';
  const cx = 95, cy = 50, r = 30;
  const pt = (ang) => { const a = ang * Math.PI / 180; return [cx + r * Math.cos(a), cy - r * Math.sin(a)]; };
  const angs = [90, -30, -150];
  const P = angs.map(pt), S = angs.map(ang => pt(ang + shift));
  const tri = (pts, col) => {
    let d = 'M' + pts[0][0].toFixed(1) + ' ' + pts[0][1].toFixed(1);
    pts.slice(1).forEach(p => d += ' L' + p[0].toFixed(1) + ' ' + p[1].toFixed(1));
    return '<path d="' + d + ' Z" ' + col + '/>';
  };
  let s = '<svg class="cct" viewBox="0 0 340 96" xmlns="http://www.w3.org/2000/svg" style="color:var(--tx2)">';
  s += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" ' + st + '/>';
  s += '<circle cx="' + cx + '" cy="' + cy + '" r="1.6" fill="var(--tx2)"/>';
  s += tri(P, st);
  s += tri(S, em);
  P.forEach(p => s += '<line x1="' + cx + '" y1="' + cy + '" x2="' + p[0].toFixed(1) + '" y2="' + p[1].toFixed(1) + '" ' + st + '/>');
  S.forEach(p => s += '<line x1="' + cx + '" y1="' + cy + '" x2="' + p[0].toFixed(1) + '" y2="' + p[1].toFixed(1) + '" ' + em + '/>');
  s += L(232, 30, conn + ' vector group', tx);
  s += L(232, 50, 'ABC (gray) primary', tx2);
  s += L(234, 66, 'abc (blue) secondary', tx2);
  return s + '</svg>';
}
// Three-winding transformer. SPEC section 2: primary, secondary, tertiary all
// referred to the primary and meeting at an internal star node eliminated
// analytically. The delta tertiary is the classic zero-sequence sink.
function xfmr3wSciencePanel(b) {
  const p = b.params;
  const conn = p.conn || 'Yy0d1';
  const [a2, a3] = xfmrA(p, 'xfmr3w');
  const R1 = +p.R1, L1 = +p.L1, R2 = +p.R2, L2 = +p.L2, R3 = +p.R3, L3 = +p.L3;
  const fref = 60, w = 2 * Math.PI * fref;
  const XL1 = w * L1 / 1000, XL2 = w * L2 / 1000, XL3 = w * L3 / 1000;
  const eq = (s) => '<span class="eq">' + s + '</span>';
  let h = '<details class="sci" open><summary>Physics &amp; equations</summary><div class="scibody">';
  h += '<p>A three-winding transformer has a primary, a secondary, and a tertiary, all referred to the primary (a2 = N1/N2, a3 = N1/N3) and meeting at an internal star node that is eliminated analytically. The classic reason these exist is the delta tertiary: with an ungrounded primary, a secondary single-line-to-ground fault has no zero-sequence path except circulation in the tertiary delta, so the delta is a zero-sequence sink.</p>';
  h += eq('g<sub>w</sub> = 1/(R<sub>w</sub> + 2L<sub>w</sub>/d<sub>t</sub>) ,&nbsp; v<sub>s</sub> = <span class="frac"><span class="num">Σ<sub>w</sub> g<sub>w</sub>·a<sub>w</sub>·u<sub>w</sub> + Σ<sub>w</sub> I<sub>hw</sub></span><span class="den">g<sub>1</sub>+g<sub>2</sub>+g<sub>3</sub></span></span> ,&nbsp; i<sub>w</sub> = a<sub>w</sub>·[g<sub>w</sub>·(a<sub>w</sub>·u<sub>w</sub> − v<sub>s</sub>) + I<sub>hw</sub>]');
  h += '<div class="scisub">Live: three referred leakage branches (R<sub>1</sub>=' + sciNum(R1) + ' Ω, L<sub>1</sub>=' + sciNum(L1) + ' mH; R<sub>2</sub>\'=' + sciNum(R2) + ', L<sub>2</sub>\'=' + sciNum(L2) + '; R<sub>3</sub>\'=' + sciNum(R3) + ', L<sub>3</sub>\'=' + sciNum(L3) + ') meet at the internal star node v<sub>s</sub>, found by enforcing Σ branch currents = 0, so v<sub>s</sub> is eliminated once at build (no extra unknown per step).</div>';
  h += eq('Y<sub>3</sub>[w][j] = a<sub>w</sub>·a<sub>j</sub>·(δ<sub>wj</sub>·g<sub>w</sub> − g<sub>w</sub>·g<sub>j</sub>/G) ,&nbsp; a<sub>1</sub>=1, a<sub>2</sub>=N<sub>1</sub>/N<sub>2</sub>, a<sub>3</sub>=N<sub>1</sub>/N<sub>3</sub>');
  h += '<div class="scisub">Live: a2 = <b>' + sciNum(a2) + '</b>, a3 = <b>' + sciNum(a3) + '</b> (referred to primary). At 60 Hz: X<sub>L1</sub>=' + sciNum(XL1) + ' Ω, X<sub>L2</sub>\'=' + sciNum(XL2) + ' Ω, X<sub>L3</sub>\'=' + sciNum(XL3) + ' Ω. The 3×3 port admittance is stamped per phase from the analytic star-node elimination.</div>';
  h += '<div class="scisub">Live: connection <b>' + conn + '</b>. The delta tertiary is the zero-sequence sink: with an ungrounded primary, a secondary SLG fault has no zero-sequence path except tertiary delta circulation, so a d1 tertiary passes tens of times the fault current of an ungrounded-y0 tertiary.</div>';
  h += xfmr3wSvg();
  h += '<div class="scisub">Per-phase 3-port equivalent: three referred leakage branches (R + jX) meeting at the internal star node, one each to the primary (P), secondary (S), and tertiary (T) terminals.</div>';
  h += '<details class="sci sci2" open><summary>Scope &amp; limits</summary><div class="scibody">';
  h += '<p>Primary-wye connections only in this pass (Yy0y0, Yy0d1, Yy0d11, Yd1d1); no Dd or zigzag. Winding-ratio a semantics as xfmr3. No saturation on the 3-winding unit (use xfmr for saturation). solvePowerFlow() stamps the same star (T) equivalent in positive sequence, so a case containing a 3-winding unit power-flows and a delta winding\'s 30° shift carries through. A star arm with negative reactance is normal for a T equivalent and the power flow handles it; check EMT stability before trusting transient results on one. Terminals: 0 = primary, 1 = secondary, 2 = tertiary. 3-phase only.</p>';
  h += '</div></details></div></details>';
  return h;
}
// 3-winding per-phase star equivalent: a vertical internal star node with
// three referred leakage branches (R + jL) radiating to the P/S/T terminals.
function xfmr3wSvg() {
  const st = 'stroke="var(--tx2)" stroke-width="1.2" fill="none"';
  const tx = 'fill="var(--tx)" font-size="9" font-family="system-ui,sans-serif" text-anchor="middle"';
  const tx2 = 'fill="var(--tx2)" font-size="8.5" font-family="system-ui,sans-serif" text-anchor="middle"';
  const L = (x, y, t, c) => '<text x="' + x + '" y="' + y + '" ' + (c || tx2) + '>' + t + '</text>';
  let s = '<svg class="cct" viewBox="0 0 300 96" xmlns="http://www.w3.org/2000/svg" style="color:var(--tx2)">';
  // vertical star bus
  s += '<line x1="150" y1="20" x2="150" y2="76" ' + st + ' stroke-width="2.2"/>';
  s += '<circle cx="150" cy="48" r="2.5" fill="var(--tx2)"/>';
  // primary arm: term(12,20) -> R -> jL -> star(150,20)
  s += '<circle cx="12" cy="20" r="2.5" ' + st + '/>';
  s += '<line x1="12" y1="20" x2="20" y2="20" ' + st + '/>';
  s += '<rect x="20" y="14" width="24" height="12" ' + st + '/>';
  s += '<line x1="44" y1="20" x2="52" y2="20" ' + st + '/>';
  s += '<path d="M52 20 a5 5 0 0 1 10 0 a5 5 0 0 1 10 0 a5 5 0 0 1 10 0" ' + st + '/>';
  s += '<line x1="82" y1="20" x2="150" y2="20" ' + st + '/>';
  // secondary arm: star(150,48) -> R -> jL -> term(288,48)
  s += '<line x1="150" y1="48" x2="158" y2="48" ' + st + '/>';
  s += '<rect x="158" y="42" width="24" height="12" ' + st + '/>';
  s += '<line x1="182" y1="48" x2="190" y2="48" ' + st + '/>';
  s += '<path d="M190 48 a5 5 0 0 1 10 0 a5 5 0 0 1 10 0 a5 5 0 0 1 10 0" ' + st + '/>';
  s += '<line x1="220" y1="48" x2="288" y2="48" ' + st + '/>';
  s += '<circle cx="288" cy="48" r="2.5" ' + st + '/>';
  // tertiary arm: star(150,76) -> R -> jL -> term(288,76)
  s += '<line x1="150" y1="76" x2="158" y2="76" ' + st + '/>';
  s += '<rect x="158" y="70" width="24" height="12" ' + st + '/>';
  s += '<line x1="182" y1="76" x2="190" y2="76" ' + st + '/>';
  s += '<path d="M190 76 a5 5 0 0 1 10 0 a5 5 0 0 1 10 0 a5 5 0 0 1 10 0" ' + st + '/>';
  s += '<line x1="220" y1="76" x2="288" y2="76" ' + st + '/>';
  s += '<circle cx="288" cy="76" r="2.5" ' + st + '/>';
  s += L(32, 12, 'R1'); s += L(67, 12, "jX1'");
  s += L(170, 40, "R2'"); s += L(205, 40, "jX2'");
  s += L(170, 88, "R3'"); s += L(205, 88, "jX3'");
  s += L(12, 16, 'P', tx);
  s += L(288, 44, 'S', tx);
  s += L(288, 80, 'T', tx);
  s += L(150, 56, 'star', tx2);
  return s + '</svg>';
}
// Series RLC branch. SPEC section 2: one current through R, L, C in series
// plus an independent capacitor-voltage state. Each element droppable
// (-1, or 0 for R and L) to leave a wire. 60 Hz reference for reactances.
function rlcSciencePanel(b) {
  const p = b.params;
  const Rv = +p.R, Lv = +p.L, Cv = +p.C;
  const pR = Rv > 0, pL = Lv > 0, pC = Cv > 0;
  const fref = 60, w = 2 * Math.PI * fref;
  const XL = pL ? w * Lv / 1000 : 0, XC = pC ? 1e6 / (w * Cv) : 0;
  const ReZ = pR ? Rv : 0, ImZ = (pL ? XL : 0) - (pC ? XC : 0);
  const Zmag = Math.hypot(ReZ, ImZ);
  const fr = (pL && pC) ? 1 / (2 * Math.PI * Math.sqrt((Lv / 1000) * (Cv / 1e6))) : 0;
  const eq = (s) => '<span class="eq">' + s + '</span>';
  let h = '<details class="sci" open><summary>Physics &amp; equations</summary><div class="scibody">';
  h += '<p>A series R-L-C branch carries one current through all three elements; a capacitor-voltage state v<sub>C</sub> is needed in addition to the branch current because v<sub>C</sub> does not collapse to a function of the total branch voltage. Each element can be dropped (set to −1, or 0 for R and L) to leave a wire in its place, so the same block is a plain resistor, inductor, capacitor, RL, RC, or LC. 60 Hz is a labeled reference for the reactances.</p>';
  h += eq('v = R·i + L·d<i>i</i>/d<i>t</i> + v<sub>C</sub> ,&nbsp; dv<sub>C</sub>/d<i>t</i> = i/C ,&nbsp; R<i>eq</i> = R + 2L/d<sub>t</sub> + d<sub>t</sub>/(2C)');
  h += '<div class="scisub">Live: ' + (pR ? 'R = <b>' + sciNum(Rv) + '</b> Ω; ' : '') + (pL ? 'L = <b>' + sciNum(Lv) + '</b> mH (X<sub>L</sub> = ' + sciNum(XL) + ' Ω); ' : '') + (pC ? 'C = <b>' + sciNum(Cv) + '</b> µF (X<sub>C</sub> = ' + sciNum(XC) + ' Ω); ' : '') + (!pR && !pL && !pC ? 'all absent: a near-zero-impedance short. ' : '') + 'At 60 Hz, Z = ' + sciNum(ReZ) + (ImZ >= 0 ? ' + j' : ' − j') + sciNum(Math.abs(ImZ)) + ' Ω (|Z| = <b>' + sciNum(Zmag) + '</b>).' + (fr > 0 ? ' Series resonance at f<sub>r</sub> = 1/(2π√(LC)) = <b>' + sciNum(fr) + '</b> Hz.' : '') + '</div>';
  h += eq('I<sub>h</sub> = [v<sub>n−1</sub> − i<sub>n−1</sub>·k − 2·v<sub>C,n−1</sub>]·G ,&nbsp; k = R − 2L/d<sub>t</sub> + d<sub>t</sub>/(2C) ,&nbsp; v<sub>C,n</sub> = v<sub>C,n−1</sub> + (d<sub>t</sub>/2C)·(i<sub>n</sub>+i<sub>n−1</sub>)');
  h += '<div class="scisub">The trapezoidal companion folds R, L, and C into one conductance G = 1/R<i>eq</i> plus a history source; the capacitor-voltage state v<sub>C</sub> is updated each step. Absent elements drop out of R<i>eq</i> and k exactly (the all-absent limit is floored to a small epsilon so the stamp does not blow up).</div>';
  h += rlcSvg(pR, pL, pC, Rv, XL, XC);
  h += '<div class="scisub">Series chain between the two terminals, one shared current: ' + (pR ? 'R' : '') + (pL ? (pR ? ' + ' : '') + 'jωL' : '') + (pC ? ((pR || pL) ? ' + ' : '') + '−j/(ωC)' : '') + '.</div>';
  h += '<details class="sci sci2" open><summary>Numerics &amp; limits</summary><div class="scibody">';
  h += '<p>Second-order branch (one current + one v<sub>C</sub> state). After a switching event the solver swaps in two backward-Euler half-steps at dt/2 for one step (CDA) to kill Nyquist ringing, reusing the same conductance. Power-flow phasor: Z = R + jωL + 1/(jωC), then cInv(Z) to admittance. A plain resistor, inductor, or capacitor is the single-element limit of this same companion.</p>';
  h += '</div></details></div></details>';
  return h;
}
// Series chain SVG: terminal -> [R] -> [L] -> [C] -> terminal, present
// elements only. R and L overlay the base wire (standard symbol); the cap
// erases the wire between its plates.
function rlcSvg(pR, pL, pC, R, XL, XC) {
  const st = 'stroke="var(--tx2)" stroke-width="1.2" fill="none"';
  const tx2 = 'fill="var(--tx2)" font-size="8.5" font-family="system-ui,sans-serif" text-anchor="middle"';
  const Lb = (x, y, t, c) => '<text x="' + x + '" y="' + y + '" ' + (c || tx2) + '>' + t + '</text>';
  const slots = [];
  if (pR) slots.push({ k: 'R', lbl: 'R ' + sciNum(R) + 'Ω' });
  if (pL) slots.push({ k: 'L', lbl: 'jωL ' + sciNum(XL) + 'Ω' });
  if (pC) slots.push({ k: 'C', lbl: '−j/ωC ' + sciNum(XC) + 'Ω' });
  const n = Math.max(1, slots.length);
  const y = 30, xL = 20, xR = 320;
  let s = '<svg class="cct" viewBox="0 0 340 60" xmlns="http://www.w3.org/2000/svg" style="color:var(--tx2)">';
  s += '<circle cx="' + xL + '" cy="' + y + '" r="2.5" ' + st + '/>';
  s += '<line x1="' + xL + '" y1="' + y + '" x2="' + xR + '" y2="' + y + '" ' + st + '/>';
  const span = xR - xL - 40;
  slots.forEach((sl, k) => {
    const cx = xL + 20 + (n === 1 ? span / 2 : span * k / (n - 1));
    if (sl.k === 'R') {
      s += '<rect x="' + (cx - 15) + '" y="' + (y - 6) + '" width="30" height="12" ' + st + '/>';
    } else if (sl.k === 'L') {
      s += '<path d="M' + (cx - 15) + ' ' + y + ' a5 5 0 0 1 10 0 a5 5 0 0 1 10 0 a5 5 0 0 1 10 0" ' + st + '/>';
    } else {
      s += '<rect x="' + (cx - 8) + '" y="' + (y - 7) + '" width="16" height="14" fill="var(--sfc)"/>';
      s += '<line x1="' + (cx - 3) + '" y1="' + (y - 6) + '" x2="' + (cx - 3) + '" y2="' + (y + 6) + '" ' + st + '/>';
      s += '<line x1="' + (cx + 3) + '" y1="' + (y - 6) + '" x2="' + (cx + 3) + '" y2="' + (y + 6) + '" ' + st + '/>';
    }
    s += Lb(cx, y - 12, sl.lbl);
  });
  s += '<circle cx="' + xR + '" cy="' + y + '" r="2.5" ' + st + '/>';
  return s + '</svg>';
}
// Parallel RLC branch. SPEC section 2: one shared voltage, three independent
// currents; companion is the sum of three independent admittances. The
// sentinel convention is the INVERSE of series RLC: -1 = absent, 0 = SHORT.
function rlcpSciencePanel(b) {
  const p = b.params;
  const Rv = +p.R, Lv = +p.L, Cv = +p.C;
  const pR = Rv > 0, pL = Lv > 0, pC = Cv > 0;
  const Rshort = Rv === 0, Lshort = Lv === 0;
  const fref = 60, w = 2 * Math.PI * fref;
  const Yre = pR ? 1 / Rv : 0;
  const Yim = (pC ? w * Cv / 1e6 : 0) - (pL ? 1 / (w * Lv / 1000) : 0);
  const Ymag = Math.hypot(Yre, Yim);
  const Zmag = Ymag > 0 ? 1 / Ymag : Infinity;
  const fr = (pL && pC) ? 1 / (2 * Math.PI * Math.sqrt((Lv / 1000) * (Cv / 1e6))) : 0;
  const eq = (s) => '<span class="eq">' + s + '</span>';
  let h = '<details class="sci" open><summary>Physics &amp; equations</summary><div class="scibody">';
  h += '<p>A parallel R||L||C branch shares one voltage across all three elements; each draws an independent current, and the total is the sum. Unlike the series RLC, the three do not interact algebraically, so the companion is just the sum of three independent admittances. The sentinel convention is the INVERSE of series RLC: here −1 means absent but 0 is a real short, not a synonym for absent.</p>';
  h += eq('G = G<sub>R</sub> + G<sub>L</sub> + G<sub>C</sub> ,&nbsp; G<sub>R</sub>=1/R ,&nbsp; G<sub>L</sub>=d<sub>t</sub>/(2L) ,&nbsp; G<sub>C</sub>=2C/d<sub>t</sub>');
  h += '<div class="scisub">Live: ' + (Rshort ? 'R = 0 (short, dominates the branch); ' : pR ? 'R = <b>' + sciNum(Rv) + '</b> Ω; ' : 'R absent; ') + (Lshort ? 'L = 0 (short); ' : pL ? 'L = <b>' + sciNum(Lv) + '</b> mH; ' : 'L absent; ') + (pC ? 'C = <b>' + sciNum(Cv) + '</b> µF; ' : 'C absent; ') + 'At 60 Hz, |Y| = <b>' + sciNum(Ymag) + '</b> S (|Z| = ' + (isFinite(Zmag) ? sciNum(Zmag) : '∞') + ' Ω).' + (fr > 0 ? ' Parallel resonance at f<sub>r</sub> = <b>' + sciNum(fr) + '</b> Hz.' : '') + '</div>';
  h += eq('I<sub>h</sub> = I<sub>hL</sub> + I<sub>hC</sub> ,&nbsp; I<sub>hL</sub> = i<sub>L,n−1</sub> + G<sub>L</sub>·v<sub>n−1</sub> ,&nbsp; I<sub>hC</sub> = −(G<sub>C</sub>·v<sub>n−1</sub> + i<sub>C,n−1</sub>)');
  h += '<div class="scisub">Two independent current states (i<sub>L</sub>, i<sub>C</sub>) since the three branch currents are not equal. All three absent gives G = 0, a genuine open branch (the solver reports the floating node): the opposite of series RLC, where all-absent forces a short.</div>';
  h += rlcpSvg(pR, pL, pC, Rshort, Lshort, Rv, Lv, Cv);
  h += '<div class="scisub">Three parallel branches between the two terminals, one shared voltage, independent currents.</div>';
  h += '<details class="sci sci2" open><summary>Numerics &amp; limits</summary><div class="scibody">';
  h += '<p>Power-flow phasor: admittances sum directly, Y = {re: 1/R, im: ωC − 1/(ωL)}, no impedance inversion. BE/CDA half-step drops the v term from each sub-branch history. No R<i>eq</i> floor guard is needed (all-absent is a clean open, not a divide-by-zero). "Parallel" is the internal topology of R, L, C relative to each other; the block is still a plain 2-terminal branch wireable anywhere.</p>';
  h += '</div></details></div></details>';
  return h;
}
// Parallel RLC SVG: two rails (the terminals) with up to three vertical
// branches (R, L, C) between them; a 0-valued R or L draws as a short.
function rlcpSvg(pR, pL, pC, Rshort, Lshort, R, L, C) {
  const st = 'stroke="var(--tx2)" stroke-width="1.2" fill="none"';
  const tx2 = 'fill="var(--tx2)" font-size="8.5" font-family="system-ui,sans-serif" text-anchor="middle"';
  const Lb = (x, y, t, c) => '<text x="' + x + '" y="' + y + '" ' + (c || tx2) + '>' + t + '</text>';
  const yT = 16, yB = 78;
  const branch = (x, kind) => {
    if (kind === 'R') return '<line x1="' + x + '" y1="' + yT + '" x2="' + x + '" y2="32" ' + st + '/><rect x="' + (x - 6) + '" y="32" width="12" height="30" ' + st + '/><line x1="' + x + '" y1="62" x2="' + x + '" y2="' + yB + '" ' + st + '/>';
    if (kind === 'L') return '<line x1="' + x + '" y1="' + yT + '" x2="' + x + '" y2="34" ' + st + '/><path d="M' + x + ' 34 a5 5 0 0 1 0 10 a5 5 0 0 1 0 10 a5 5 0 0 1 0 10" ' + st + '/><line x1="' + x + '" y1="64" x2="' + x + '" y2="' + yB + '" ' + st + '/>';
    if (kind === 'C') return '<line x1="' + x + '" y1="' + yT + '" x2="' + x + '" y2="43" ' + st + '/><line x1="' + (x - 8) + '" y1="43" x2="' + (x + 8) + '" y2="43" ' + st + '/><line x1="' + (x - 8) + '" y1="49" x2="' + (x + 8) + '" y2="49" ' + st + '/><line x1="' + x + '" y1="49" x2="' + x + '" y2="' + yB + '" ' + st + '/>';
    return '<line x1="' + x + '" y1="' + yT + '" x2="' + x + '" y2="' + yB + '" ' + st + '/>'; // short
  };
  let s = '<svg class="cct" viewBox="0 0 340 90" xmlns="http://www.w3.org/2000/svg" style="color:var(--tx2)">';
  s += '<circle cx="30" cy="' + yT + '" r="2.5" ' + st + '/>';
  s += '<circle cx="30" cy="' + yB + '" r="2.5" ' + st + '/>';
  s += '<line x1="30" y1="' + yT + '" x2="300" y2="' + yT + '" ' + st + '/>';
  s += '<line x1="30" y1="' + yB + '" x2="300" y2="' + yB + '" ' + st + '/>';
  const slots = [];
  if (pR) slots.push(['R', 'R ' + sciNum(R) + 'Ω']); else if (Rshort) slots.push(['short', 'R=0 short']);
  if (pL) slots.push(['L', 'L ' + sciNum(L) + 'mH']); else if (Lshort) slots.push(['short', 'L=0 short']);
  if (pC) slots.push(['C', 'C ' + sciNum(C) + 'µF']);
  const xs = [110, 190, 270];
  slots.forEach((sl, k) => {
    const x = xs[k] || 110;
    s += branch(x, sl[0]);
    s += Lb(x, yT - 5, sl[1]);
  });
  return s + '</svg>';
}
// Shunt capacitor. SPEC section 2: i = C dv/dt, trapezoidal companion
// G = 2C/dt. The same form underlies every capacitor in the solver.
function capSciencePanel(b) {
  const p = b.params;
  const C = +p.C;
  const fref = 60, w = 2 * Math.PI * fref;
  const XC = 1e6 / (w * C);
  const eq = (s) => '<span class="eq">' + s + '</span>';
  let h = '<details class="sci" open><summary>Physics &amp; equations</summary><div class="scibody">';
  h += '<p>A capacitor resists changes in voltage: its current is proportional to the time derivative of the voltage across it, so it stores energy in the electric field between its plates. This block is the trapezoidal companion used everywhere a capacitor appears (the shunt caps in a π line, the magnetizing branch, the DC-link capacitor). Wire it as a shunt to ground for the usual case; for a series capacitor use Series RLC with R = L = −1.</p>';
  h += eq('i = C·d<i>v</i>/d<i>t</i> ,&nbsp; i<sub>n</sub> = (2C/d<sub>t</sub>)·v<sub>n</sub> − [(2C/d<sub>t</sub>)·v<sub>n−1</sub> + i<sub>n−1</sub>]');
  h += '<div class="scisub">Live: C = <b>' + sciNum(C) + '</b> µF. At 60 Hz the reactance is X<sub>C</sub> = 1/(ωC) = <b>' + sciNum(XC) + '</b> Ω. The companion is a conductance G = 2C/d<sub>t</sub> plus a history source; the same form underlies every capacitor in the solver.</div>';
  h += capSvg(C);
  h += '<div class="scisub">Two terminals (one to the node, one to ground for a shunt); two plates, one stored-voltage state.</div>';
  h += '<details class="sci sci2" open><summary>Numerics &amp; limits</summary><div class="scibody">';
  h += '<p>Trapezoidal companion (G = 2C/dt); on a backward-Euler CDA half-step the history drops its current term (I<sub>h,BE</sub> = −G·v<sub>n−1</sub>) to kill post-switch ringing, same conductance. For a switched bank put a cap behind a Brk and drive that Brk with the Shunt Ctl (vsw) block.</p>';
  h += '</div></details></div></details>';
  return h;
}
function capSvg(C) {
  const st = 'stroke="var(--tx2)" stroke-width="1.2" fill="none"';
  const tx2 = 'fill="var(--tx2)" font-size="8.5" font-family="system-ui,sans-serif" text-anchor="middle"';
  const Lb = (x, y, t) => '<text x="' + x + '" y="' + y + '" ' + tx2 + '>' + t + '</text>';
  return '<svg class="cct" viewBox="0 0 340 60" xmlns="http://www.w3.org/2000/svg" style="color:var(--tx2)">' +
    '<circle cx="20" cy="30" r="2.5" ' + st + '/>' +
    '<line x1="20" y1="30" x2="160" y2="30" ' + st + '/>' +
    '<line x1="160" y1="18" x2="160" y2="42" ' + st + '/>' +
    '<line x1="172" y1="18" x2="172" y2="42" ' + st + '/>' +
    '<line x1="172" y1="30" x2="320" y2="30" ' + st + '/>' +
    '<circle cx="320" cy="30" r="2.5" ' + st + '/>' +
    Lb(166, 12, 'C ' + sciNum(C) + 'µF') +
    '</svg>';
}
// Ground reference: the solver's 0 V datum. No params.
function gndSciencePanel(b) {
  let h = '<details class="sci" open><summary>Physics &amp; equations</summary><div class="scibody">';
  h += '<p>Ground is the solver\'s voltage datum: it pins its node to exactly 0 V, the reference every other node voltage is measured against. Every circuit needs at least one ground (the matrix is otherwise singular: with no datum, only voltage differences are determined, not absolute levels). Star-ground all returns here so they share the one reference.</p>';
  h += '<span class="eq">V<sub>node</sub> = 0 &nbsp;(datum)</span>';
  h += gndSvg();
  h += '<div class="scisub">One terminal, no parameters. The ground symbol is the universal reference point.</div>';
  h += '</div></details>';
  return h;
}
function gndSvg() {
  const st = 'stroke="var(--tx2)" stroke-width="1.2" fill="none"';
  const tx2 = 'fill="var(--tx2)" font-size="8.5" font-family="system-ui,sans-serif" text-anchor="middle"';
  return '<svg class="cct" viewBox="0 0 340 56" xmlns="http://www.w3.org/2000/svg" style="color:var(--tx2)">' +
    '<circle cx="170" cy="12" r="2.5" ' + st + '/>' +
    '<line x1="170" y1="12" x2="170" y2="26" ' + st + '/>' +
    '<line x1="150" y1="26" x2="190" y2="26" ' + st + '/>' +
    '<line x1="156" y1="32" x2="184" y2="32" ' + st + '/>' +
    '<line x1="162" y1="38" x2="178" y2="38" ' + st + '/>' +
    '<text x="200" y="32" ' + tx2 + '>0 V (datum)</text>' +
    '</svg>';
}
// Voltage probe: ideal voltmeter, no loading. No params.
function probeSciencePanel(b) {
  let h = '<details class="sci" open><summary>Physics &amp; equations</summary><div class="scibody">';
  h += '<p>A voltage probe measures its node\'s voltage without loading it: ideal, no current drawn (i = 0), so it does not change the circuit it observes. Add one per node you want to plot, then pick the signal by block ID. The probe is the project\'s ID-based signal lookup convention in its purest form.</p>';
  h += '<span class="eq">i = 0 (ideal voltmeter) ,&nbsp; V<sub>measured</sub> = V<sub>node</sub></span>';
  h += probeSvg();
  h += '<div class="scisub">One terminal, no parameters. The dashed lead marks the ideal (current-free) sense path; the measured voltage is the node relative to ground.</div>';
  h += '</div></details>';
  return h;
}
function probeSvg() {
  const st = 'stroke="var(--tx2)" stroke-width="1.2" fill="none"';
  const em = 'stroke="var(--acc)" stroke-width="1.2" fill="none"';
  const tx = 'fill="var(--tx)" font-size="9" font-family="system-ui,sans-serif" text-anchor="middle"';
  const tx2 = 'fill="var(--tx2)" font-size="8.5" font-family="system-ui,sans-serif" text-anchor="middle"';
  return '<svg class="cct" viewBox="0 0 340 56" xmlns="http://www.w3.org/2000/svg" style="color:var(--tx2)">' +
    '<circle cx="60" cy="30" r="2.5" ' + st + '/>' +
    '<line x1="60" y1="30" x2="120" y2="30" ' + st + '/>' +
    '<circle cx="140" cy="30" r="14" ' + st + '/>' +
    '<text x="140" y="34" ' + tx + '>V</text>' +
    '<line x1="154" y1="30" x2="220" y2="30" ' + em + ' stroke-dasharray="3 3"/>' +
    '<line x1="220" y1="30" x2="220" y2="40" ' + st + '/>' +
    '<line x1="206" y1="40" x2="234" y2="40" ' + st + '/>' +
    '<line x1="210" y1="44" x2="230" y2="44" ' + st + '/>' +
    '<line x1="214" y1="48" x2="226" y2="48" ' + st + '/>' +
    '<text x="60" y="22" ' + tx2 + '>node</text>' +
    '</svg>';
}
// Bus: a junction bar tying all taps to one named node. Auto-plotted.
function busSciencePanel(b) {
  const p = b.params;
  const taps = +p.taps || 6;
  let h = '<details class="sci" open><summary>Physics &amp; equations</summary><div class="scibody">';
  h += '<p>A bus is a thick junction bar that ties every wired tap to ONE node, so multiple connections meet at a single named voltage without a tangle of crossing wires. Its node voltage is plotted automatically; pick it in a plot\'s Signals list by name. AC vs DC is detected from the circuit. One tap works too, as a named anchor.</p>';
  h += '<span class="eq">V<sub>tap k</sub> = V<sub>bus</sub> for all k &nbsp;(one node, many taps)</span>';
  h += '<div class="scisub">Live: <b>' + taps + '</b> tap' + (taps === 1 ? '' : 's') + (p.name ? ', name "' + p.name + '"' : '') + '. Extend via # taps / length; rotate with R for a vertical bus.</div>';
  h += busSvg(taps);
  h += '<div class="scisub">A single conductor; each tap is a connection point at the same node voltage.</div>';
  h += '</div></details>';
  return h;
}
function busSvg(taps) {
  const st = 'stroke="var(--tx2)" stroke-width="1.2" fill="none"';
  let s = '<svg class="cct" viewBox="0 0 340 50" xmlns="http://www.w3.org/2000/svg" style="color:var(--tx2)">';
  s += '<line x1="20" y1="22" x2="320" y2="22" ' + st + ' stroke-width="3"/>';
  const n = Math.max(1, Math.min(taps, 8));
  for (let k = 0; k < n; k++) {
    const x = 20 + (n === 1 ? 150 : 300 * k / (n - 1));
    s += '<circle cx="' + x.toFixed(1) + '" cy="22" r="3" fill="var(--tx2)"/>';
    s += '<line x1="' + x.toFixed(1) + '" y1="22" x2="' + x.toFixed(1) + '" y2="38" ' + st + '/>';
  }
  return s + '</svg>';
}
// Build an SVG path string by sampling fn(x) over [x0,x1] with n segments,
// through xmap/ymap pixel maps. Used by the characteristic-curve panels.
function curvePath(fn, x0, x1, n, xmap, ymap) {
  let d = '';
  for (let i = 0; i <= n; i++) {
    const x = x0 + (x1 - x0) * i / n;
    const px = xmap(x), py = ymap(fn(x));
    if (!isFinite(py)) continue;
    d += (d ? ' L' : 'M') + px.toFixed(1) + ' ' + py.toFixed(1);
  }
  return d;
}
// AC voltage source behind Rs (Thevenin -> Norton). SPEC section 2: the
// default stiff/slack source. No dynamics; sets V and f of its bus.
function srcSciencePanel(b) {
  const p = b.params;
  const Vrms = +p.Vrms, f = +p.f, Rs = +p.Rs;
  const Vpk = Vrms * Math.SQRT2, Isc = Vpk / Rs;
  const eq = (s) => '<span class="eq">' + s + '</span>';
  let h = '<details class="sci" open><summary>Physics &amp; equations</summary><div class="scibody">';
  h += '<p>An AC voltage source is the idealized grid or slack: a sinusoidal EMF behind a series internal resistance R<i>s</i> (Thevenin), injected into the network as a Norton current source. It has no dynamics, so it is a stiff source that sets the voltage and frequency of whatever bus it is wired to. Use it as a slack, or pair it with a machine or GFM when you want real inertial or droop response.</p>';
  h += eq('v<sub>s</sub>(t) = V<sub>rms</sub>·√2·sin(2π<i>f</i>t + φ<sub>ph</sub>) ,&nbsp; I = v<sub>s</sub>/R<i>s</sub> ,&nbsp; G = 1/R<i>s</sub>');
  h += '<div class="scisub">Live: V<sub>rms</sub> = <b>' + sciNum(Vrms) + '</b> V (peak ' + sciNum(Vpk) + ' V), <i>f</i> = <b>' + sciNum(f) + '</b> Hz, R<i>s</i> = <b>' + sciNum(Rs) + '</b> Ω. Short-circuit current I<sub>sc</sub> = V<sub>pk</sub>/R<i>s</i> = <b>' + sciNum(Isc) + '</b> A. The phase shift φ<sub>ph</sub> gives the three phases their 120° spacing. Left terminal is the return (ground), right is the live conductor; works in 1-ph and 3-ph.</div>';
  h += srcSvg();
  h += '<div class="scisub">An ideal sinusoidal source behind its internal resistance: the simplest stiff source, no inertia, no droop.</div>';
  h += '<details class="sci sci2" open><summary>Scope &amp; limits</summary><div class="scibody">';
  h += '<p>No dynamics (frequency fixed at <i>f</i>, voltage at V<sub>rms</sub>), so a bus sourced only by src cannot exhibit inertial or droop response; add a syncgen or GFM for that. The Norton injection keeps the matrix constant (G = 1/R<i>s</i> stamped, the source value moves to the RHS). In 3-ph the three phases share one source with 120° shifts.</p>';
  h += '</div></details></div></details>';
  return h;
}
function srcSvg() {
  const st = 'stroke="var(--tx2)" stroke-width="1.2" fill="none"';
  const tx2 = 'fill="var(--tx2)" font-size="8.5" font-family="system-ui,sans-serif" text-anchor="middle"';
  const Lb = (x, y, t) => '<text x="' + x + '" y="' + y + '" ' + tx2 + '>' + t + '</text>';
  return '<svg class="cct" viewBox="0 0 340 70" xmlns="http://www.w3.org/2000/svg" style="color:var(--tx2)">' +
    '<circle cx="20" cy="30" r="2.5" ' + st + '/>' +
    '<line x1="20" y1="30" x2="60" y2="30" ' + st + '/>' +
    '<circle cx="80" cy="30" r="12" ' + st + '/>' +
    '<path d="M72 30 a4 4 0 0 1 8 0 a4 4 0 0 1 8 0" ' + st + '/>' +
    '<line x1="92" y1="30" x2="110" y2="30" ' + st + '/>' +
    '<rect x="110" y="24" width="30" height="12" ' + st + '/>' +
    '<line x1="140" y1="30" x2="320" y2="30" ' + st + '/>' +
    '<circle cx="320" cy="30" r="2.5" ' + st + '/>' +
    '<line x1="20" y1="30" x2="20" y2="52" ' + st + '/>' +
    '<line x1="12" y1="52" x2="28" y2="52" ' + st + '/>' +
    '<line x1="15" y1="56" x2="25" y2="56" ' + st + '/>' +
    '<line x1="17" y1="60" x2="23" y2="60" ' + st + '/>' +
    Lb(125, 20, 'Rs') + Lb(80, 18, '~') +
    '</svg>';
}
// PFC rectifier: unity-pf AC/DC bridge, PI voltage loop on the DC side, G=0
// Norton (bus needs a cap). SPEC section 2.
function pfcSciencePanel(b) {
  const p = b.params;
  const Vref = +p.Vref, Imax = +p.Imax, kp = +p.kp, ki = +p.ki, Vac = +p.Vac, tgrid = +p.tgrid, rev = +p.rev;
  const UV = 0.5 * Math.SQRT2 * Vac;
  const eq = (s) => '<span class="eq">' + s + '</span>';
  let h = '<details class="sci" open><summary>Physics &amp; equations</summary><div class="scibody">';
  h += '<p>A PFC rectifier is a unity-power-factor AC/DC bridge modeled as a NORTON current source on the DC bus (no conductance stamp; the bus needs a capacitor). The DC side is a PI voltage loop with current limit; the AC side is an abstracted unity-pf balanced current sink carrying the DC power (lossless AVM). Undervoltage shutdown when the AC peak drops below 0.5√2·V<sub>ac</sub>.</p>';
  h += eq('err = V<sub>ref</sub> − v ,&nbsp; integ += k<sub>i</sub>·h·err ,&nbsp; raw = k<sub>p</sub>·err + integ ,&nbsp; i<sub>cmd</sub> = clamp(raw, lo, I<sub>max</sub>)');
  h += '<div class="scisub">Live: V<sub>ref</sub> = <b>' + sciNum(Vref) + '</b> V, I<sub>max</sub> = <b>' + sciNum(Imax) + '</b> A, k<sub>p</sub> = ' + sciNum(kp) + ', k<sub>i</sub> = ' + sciNum(ki) + '. ' + (rev ? 'reverse = 1: bidirectional, lo = −I<sub>max</sub> (can export to AC).' : 'reverse = 0: one-way rectifier, lo = 0.') + ' Anti-windup back-calculation: integ += i<sub>cmd</sub> − raw.</div>';
  h += eq('P = v<sub>dc</sub>·i<sub>cmd</sub> ,&nbsp; i<sub>p</sub> = [2P/(3V̂²)]·v<sub>p</sub> ,&nbsp; V̂² = (2/3)·Σv<sub>p</sub>² &nbsp;(unity-pf AC draw)');
  h += '<div class="scisub">Live: AC nominal ' + sciNum(Vac) + ' V rms; UV shutdown when V̂ &lt; ' + sciNum(UV) + ' V (auto-restarts). ' + (tgrid >= 0 ? 't<sub>grid</sub> = ' + sciNum(tgrid) + ' ms forces grid loss (i<sub>cmd</sub> = 0, integrator reset).' : 't<sub>grid</sub> = −1 (grid never lost).') + ' Put a cap on the DC bus (the G = 0 Norton needs it for a non-singular matrix).</div>';
  h += pfcSvg();
  h += '<div class="scisub">AC grid (abstracted, unity pf) feeds the bridge; the PI holds the DC bus at V<sub>ref</sub>; the DC cap is the energy store.</div>';
  h += '<details class="sci sci2" open><summary>Scope &amp; limits</summary><div class="scibody">';
  h += '<p>1-ph mode: the AC terminal is abstracted (wire it to ground). 3-ph hybrid mode: terminal 0 is the 3-φ AC input, terminal 1 the DC+ output, DC return via ground. Lossless AVM (no switching detail, no switching harmonics). PI integrated forward-Euler with a one-step measurement lag (negligible at 50 µs).</p>';
  h += '</div></details></div></details>';
  return h;
}
function pfcSvg() {
  const st = 'stroke="var(--tx2)" stroke-width="1.2" fill="none"';
  const fl = 'fill="var(--sfc1)" stroke="var(--tx2)" stroke-width="1.2"';
  const em = 'stroke="var(--acc)" stroke-width="1.2" fill="none"';
  const tx = 'fill="var(--tx)" font-size="9" font-family="system-ui,sans-serif" text-anchor="middle"';
  const tx2 = 'fill="var(--tx2)" font-size="8.5" font-family="system-ui,sans-serif" text-anchor="middle"';
  const Lb = (x, y, t, c) => '<text x="' + x + '" y="' + y + '" ' + (c || tx2) + '>' + t + '</text>';
  return '<svg class="cct" viewBox="0 0 340 80" xmlns="http://www.w3.org/2000/svg" style="color:var(--tx2)">' +
    '<circle cx="30" cy="40" r="12" ' + st + '/>' + '<path d="M24 40 a3 3 0 0 1 6 0 a3 3 0 0 1 6 0" ' + st + '/>' +
    '<line x1="42" y1="40" x2="70" y2="40" ' + st + '/>' +
    '<rect x="70" y="28" width="50" height="24" rx="3" ' + fl + '/>' + Lb(95, 44, 'PFC', tx) +
    '<line x1="120" y1="40" x2="170" y2="40" ' + st + '/>' +
    '<circle cx="170" cy="40" r="2.5" fill="var(--tx2)"/>' +
    '<line x1="170" y1="40" x2="170" y2="54" ' + st + '/>' +
    '<line x1="162" y1="54" x2="178" y2="54" ' + st + '/>' + '<line x1="162" y1="60" x2="178" y2="60" ' + st + '/>' +
    '<line x1="170" y1="60" x2="170" y2="70" ' + st + '/>' + '<line x1="160" y1="70" x2="180" y2="70" ' + st + '/>' +
    Lb(186, 58, 'C', tx2) + Lb(30, 24, 'AC', tx) + Lb(190, 36, 'DC', tx) +
    '<path d="M170 40 L150 40 L150 16 L95 16 L95 28" ' + em + ' marker-end=""/>' +
    Lb(132, 12, 'PI: Vdc -> Vref', tx2) +
    '</svg>';
}
// Battery: bidirectional DC/DC with SOC, SOC-gated clamp. SPEC section 2.
function battSciencePanel(b) {
  const p = b.params;
  const Vref = +p.Vref, Imax = +p.Imax, kp = +p.kp, ki = +p.ki, Ah = +p.Ah, soc0 = +p.soc0, Ichg = +p.Ichg;
  const eq = (s) => '<span class="eq">' + s + '</span>';
  let h = '<details class="sci" open><summary>Physics &amp; equations</summary><div class="scibody">';
  h += '<p>A battery is a bidirectional DC/DC with state of charge: the same PI as the PFC, but with an SOC-gated clamp. It discharges to hold V<sub>ref</sub> when the bus sags (stops at SOC 0) and charges at ≤ I<sub>chg</sub> when the bus sits above V<sub>ref</sub> (stops at SOC 100). One PI handles both directions; the clamp edges move with SOC so there is no chatter at the stops.</p>';
  h += eq('hi = (soc &gt; 0 ? I<sub>max</sub> : 0) ,&nbsp; lo = (soc &lt; 100 ? −I<sub>chg</sub> : 0) ,&nbsp; i<sub>cmd</sub> = clamp(k<sub>p</sub>·err + integ, lo, hi)');
  h += '<div class="scisub">Live: V<sub>ref</sub> = <b>' + sciNum(Vref) + '</b> V, I<sub>max</sub> = <b>' + sciNum(Imax) + '</b> A (discharge), I<sub>chg</sub> = <b>' + sciNum(Ichg) + '</b> A (charge), soc0 = <b>' + sciNum(soc0) + '</b>%, capacity ' + sciNum(Ah) + ' Ah. k<sub>p</sub> = ' + sciNum(kp) + ', k<sub>i</sub> = ' + sciNum(ki) + '.</div>';
  h += eq('d(soc)/d<i>t</i> = −i<sub>cmd</sub>/(36·Ah) &nbsp;(%/s, clamped to [0, 100])');
  h += '<div class="scisub">The capacity default is deliberately tiny (' + sciNum(Ah) + ' Ah): EMT runs are milliseconds, so a realistic rack battery (~100 Ah) would show a flat SOC. Right terminal = DC+ out; plot SOC from the Signals picker.</div>';
  h += battSvg();
  h += '<div class="scisub">Backup scheme: set V<sub>ref</sub> below the PFC V<sub>ref</sub> and the battery idles at 0 while the PFC holds the bus; on grid loss the bus sags to the battery setpoint and its PI takes over. No droop needed for a 2-source DC point of common coupling.</div>';
  h += '<details class="sci sci2" open><summary>Scope &amp; limits</summary><div class="scibody">';
  h += '<p>Lossless AVM (no cell chemistry, no temperature, no aging); the "battery" is really a bidirectional DC/DC with an SOC integrator. 1-ph/DC side only. SOC is the aux signal. The clamp edges (hi, lo) are functions of SOC, so the transition at full/empty is smooth rather than a hard chatter.</p>';
  h += '</div></details></div></details>';
  return h;
}
function battSvg() {
  const st = 'stroke="var(--tx2)" stroke-width="1.2" fill="none"';
  const fl = 'fill="var(--sfc1)" stroke="var(--tx2)" stroke-width="1.2"';
  const em = 'stroke="var(--acc)" stroke-width="1.4" fill="none"';
  const tx = 'fill="var(--tx)" font-size="9" font-family="system-ui,sans-serif" text-anchor="middle"';
  const tx2 = 'fill="var(--tx2)" font-size="8.5" font-family="system-ui,sans-serif" text-anchor="middle"';
  const Lb = (x, y, t, c) => '<text x="' + x + '" y="' + y + '" ' + (c || tx2) + '>' + t + '</text>';
  return '<svg class="cct" viewBox="0 0 340 70" xmlns="http://www.w3.org/2000/svg" style="color:var(--tx2)">' +
    '<circle cx="20" cy="35" r="2.5" ' + st + '/>' +
    '<line x1="20" y1="35" x2="60" y2="35" ' + st + '/>' +
    '<rect x="60" y="24" width="40" height="22" rx="2" ' + fl + '/>' +
    '<line x1="68" y1="20" x2="68" y2="24" ' + st + '/>' + '<line x1="64" y1="20" x2="72" y2="20" ' + st + '/>' +
    '<line x1="92" y1="20" x2="92" y2="24" ' + st + '/>' + '<line x1="90" y1="22" x2="94" y2="22" ' + st + '/>' +
    '<line x1="100" y1="35" x2="140" y2="35" ' + st + '/>' +
    '<rect x="140" y="24" width="44" height="22" rx="3" ' + fl + '/>' + Lb(162, 39, 'DC/DC', tx) +
    '<line x1="184" y1="35" x2="320" y2="35" ' + st + '/>' + '<circle cx="320" cy="35" r="2.5" ' + st + '/>' +
    Lb(80, 42, 'cell', tx2) + Lb(80, 14, 'SOC', tx2) +
    '<path d="M210 35 l-10 -4 v8 z" fill="var(--acc)"/>' + '<path d="M230 35 l10 -4 v8 z" fill="var(--acc)"/>' +
    Lb(220, 22, 'charge / discharge', tx2) +
    '</svg>';
}
// Dedicated DC/DC converter. SPEC section 2: two DC ports, CV (PI) or CC
// (direct), lossless power balance sets the IN current.
function dcdcSciencePanel(b) {
  const p = b.params;
  const mode = +p.mode, Vref = +p.Vref, Imax = +p.Imax, kp = +p.kp, ki = +p.ki, I0 = +p.I0;
  const eq = (s) => '<span class="eq">' + s + '</span>';
  let h = '<details class="sci" open><summary>Physics &amp; equations</summary><div class="scibody">';
  h += '<p>A dedicated bidirectional DC/DC is the industry way to control battery charge and discharge separately from the cell. Two DC ports (IN, OUT), both G = 0 Norton (the regulated side needs a cap). CV mode regulates OUT to V<sub>ref</sub>; CC mode dispatches a fixed current. Lossless power balance sets the IN current from the OUT power.</p>';
  if (mode === 1) {
    h += eq('CC: i<sub>cmdOut</sub> = clamp(I<sub>0</sub>, −I<sub>max</sub>, I<sub>max</sub>) &nbsp;(no PI, direct dispatch)');
    h += '<div class="scisub">Live (CC): I<sub>0</sub> = <b>' + sciNum(I0) + '</b> A. + = IN to OUT, − = OUT to IN. A direct current or power dispatch, e.g. constant-current charging.</div>';
  } else {
    h += eq('CV: err = V<sub>ref</sub> − v<sub>out</sub> ,&nbsp; i<sub>cmdOut</sub> = clamp(k<sub>p</sub>·err + integ, ±I<sub>max</sub>) &nbsp;(PI regulates OUT)');
    h += '<div class="scisub">Live (CV): V<sub>ref</sub> = <b>' + sciNum(Vref) + '</b> V, k<sub>p</sub> = ' + sciNum(kp) + ', k<sub>i</sub> = ' + sciNum(ki) + '. PI holds OUT at V<sub>ref</sub>.</div>';
  }
  h += eq('p<sub>out</sub> = i<sub>cmdOut</sub>·v<sub>out</sub> ,&nbsp; i<sub>cmdIn</sub> = clamp(p<sub>out</sub>/v<sub>in</sub>, ±I<sub>max</sub>) &nbsp;(lossless, 1 ms LPF)');
  h += '<div class="scisub">Term 0 = IN, term 1 = OUT (the regulated side). The 1 ms LPF on i<sub>cmdIn</sub> is required: without it a constant-power startup transient locks both sides at the current limit (the same negative-incremental-conductance shape a CPL has).</div>';
  h += dcdcSvg();
  h += '<div class="scisub">A buck-boost between two DC levels: the OUT side is regulated, the IN side draws whatever power balance demands.</div>';
  h += '<details class="sci sci2" open><summary>Scope &amp; limits</summary><div class="scibody">';
  h += '<p>Lossless AVM (no switching detail, no efficiency loss). Both ports need a regulating element (a cap or another source) to hold their voltage; a bare current source cannot stabilize a node by itself. Wire IN to a battery at its own native voltage to step it to a different bus voltage under explicit control. Composes safely with a battery block (passive supply-to-setpoint, not a competing voltage-setter).</p>';
  h += '</div></details></div></details>';
  return h;
}
function dcdcSvg() {
  const st = 'stroke="var(--tx2)" stroke-width="1.2" fill="none"';
  const fl = 'fill="var(--sfc1)" stroke="var(--tx2)" stroke-width="1.2"';
  const tx = 'fill="var(--tx)" font-size="9" font-family="system-ui,sans-serif" text-anchor="middle"';
  const tx2 = 'fill="var(--tx2)" font-size="8.5" font-family="system-ui,sans-serif" text-anchor="middle"';
  const Lb = (x, y, t, c) => '<text x="' + x + '" y="' + y + '" ' + (c || tx2) + '>' + t + '</text>';
  return '<svg class="cct" viewBox="0 0 340 60" xmlns="http://www.w3.org/2000/svg" style="color:var(--tx2)">' +
    '<circle cx="30" cy="30" r="2.5" ' + st + '/>' + Lb(30, 20, 'IN', tx) +
    '<line x1="30" y1="30" x2="110" y2="30" ' + st + '/>' +
    '<rect x="110" y="18" width="60" height="24" rx="3" ' + fl + '/>' + Lb(140, 34, 'DC/DC', tx) +
    '<line x1="170" y1="30" x2="310" y2="30" ' + st + '/>' +
    '<circle cx="310" cy="30" r="2.5" ' + st + '/>' + Lb(310, 20, 'OUT', tx) +
    Lb(140, 50, 'regulated', tx2) +
    '</svg>';
}
// PV array with embedded DC/DC + MPPT (Perturb & Observe). SPEC section 2.
function pvSciencePanel(b) {
  const p = b.params;
  const Voc = +p.Voc, Isc = +p.Isc, Vmpp = +p.Vmpp, Impp = +p.Impp, G = +p.G, Imax = +p.Imax, Tmppt = +p.Tmppt, dV = +p.dV;
  const sG = G / 1000;
  const IscG = Isc * sG, ImppG = Impp * sG;
  const Pmpp = Vmpp * ImppG;
  const eq = (s) => '<span class="eq">' + s + '</span>';
  let h = '<details class="sci" open><summary>Physics &amp; equations</summary><div class="scibody">';
  h += '<p>A PV array with an embedded DC/DC and maximum-power-point tracking: panel + converter + controller as one block, generation-only (it never absorbs). Its internal operating voltage v<sub>op</sub> hunts around the max-power point by real Perturb &amp; Observe, decoupled from the bus voltage (that decoupling is what the embedded converter is for). G is a static irradiance knob scaling I<sub>sc</sub> and I<sub>mpp</sub> linearly; V<sub>oc</sub> and V<sub>mpp</sub> do not shift with irradiance in this lightweight model.</p>';
  h += eq('P&amp;O: every T<sub>mppt</sub>, v<sub>op</sub> += dV·sign(ΔP) ,&nbsp; I = I(v<sub>op</sub>) ,&nbsp; i<sub>cmd</sub> = clamp(v<sub>op</sub>·I / v<sub>bus</sub>, 0, I<sub>max</sub>)');
  h += '<div class="scisub">Live: V<sub>oc</sub> = ' + sciNum(Voc) + ' V, I<sub>sc</sub> = ' + sciNum(IscG) + ' A, V<sub>mpp</sub> = ' + sciNum(Vmpp) + ' V, I<sub>mpp</sub> = ' + sciNum(ImppG) + ' A (at G = ' + sciNum(G) + ' W/m²). Max power P<sub>mpp</sub> = V<sub>mpp</sub>·I<sub>mpp</sub> = <b>' + sciNum(Pmpp) + ' W</b>. MPPT period ' + sciNum(Tmppt) + ' ms, step ±' + sciNum(dV) + ' V (steady state hunts ±' + sciNum(dV) + ' V around the peak).</div>';
  h += pvSvg(Voc, IscG, Vmpp, ImppG);
  h += '<div class="scisub">The I-V curve: constant-current up to the knee, then dropping to V<sub>oc</sub>. The MPP is the corner; v<sub>op</sub> hunts around it. Plot V<sub>op</sub> to watch it track.</div>';
  h += '<details class="sci sci2" open><summary>Scope &amp; limits</summary><div class="scibody">';
  h += '<p>Generation-only (floor of 0; a panel cannot absorb power). The panel I-V curve is a lightweight single-knee shape fit from (V<sub>oc</sub>, I<sub>sc</sub>, V<sub>mpp</sub>, I<sub>mpp</sub>); no two-diode model, no temperature derating. The 1 ms LPF on i<sub>cmd</sub> is the same fix CPL and dcdc use (negative-incremental-conductance shape). Needs a cap or another regulating element on its bus to hold a voltage.</p>';
  h += '</div></details></div></details>';
  return h;
}
function pvSvg(Voc, IscG, Vmpp, ImppG) {
  const st = 'stroke="var(--tx2)" stroke-width="1.2" fill="none"';
  const em = 'stroke="var(--acc)" stroke-width="1.5" fill="none"';
  const tx = 'fill="var(--tx)" font-size="9" font-family="system-ui,sans-serif" text-anchor="middle"';
  const tx2 = 'fill="var(--tx2)" font-size="8.5" font-family="system-ui,sans-serif" text-anchor="middle"';
  const Lb = (x, y, t, c) => '<text x="' + x + '" y="' + y + '" ' + (c || tx2) + '>' + t + '</text>';
  const bx = 30, by = 80, bw = 270, bh = 60;
  const xmax = Voc * 1.05, Imaxc = IscG * 1.05;
  const xmap = (v) => bx + (v / xmax) * bw;
  const ymap = (i) => by - (i / Imaxc) * bh;
  // piecewise: flat at IscG up to ~Vmpp, then linear down to 0 at Voc
  const Iv = (v) => {
    if (v <= 0) return IscG;
    if (v <= Vmpp) return IscG - (IscG - ImppG) * Math.pow(v / Vmpp, 4);
    return ImppG * Math.max(0, 1 - (v - Vmpp) / (Voc - Vmpp));
  };
  const d = curvePath(Iv, 0, Voc, 60, xmap, ymap);
  return '<svg class="cct" viewBox="0 0 340 96" xmlns="http://www.w3.org/2000/svg" style="color:var(--tx2)">' +
    '<line x1="' + bx + '" y1="' + by + '" x2="' + (bx + bw) + '" y2="' + by + '" ' + st + '/>' +
    '<line x1="' + bx + '" y1="' + by + '" x2="' + bx + '" y2="' + (by - bh) + '" ' + st + '/>' +
    '<path d="' + d + '" ' + em + '/>' +
    '<circle cx="' + xmap(Vmpp).toFixed(1) + '" cy="' + ymap(ImppG).toFixed(1) + '" r="2.8" fill="var(--acc)"/>' +
    Lb(xmap(Vmpp) + 6, ymap(ImppG) - 2, 'MPP', tx2) +
    Lb(bx + bw / 2, by + 12, 'V', tx) + Lb(bx - 5, by - bh, 'I', tx2) +
    '</svg>';
}
// Constant-power load (CPL). SPEC section 2: i = P/v, UVLO, 1 ms LPF,
// negative incremental resistance; stability needs kp > P/V^2.
function cplSciencePanel(b) {
  const p = b.params;
  const P = +p.P, vmin = +p.vmin;
  const eq = (s) => '<span class="eq">' + s + '</span>';
  let h = '<details class="sci" open><summary>Physics &amp; equations</summary><div class="scibody">';
  h += '<p>A constant-power load (a server rack, an electronic load) draws P/v regardless of voltage: as the bus sags it draws MORE current, the negative-incremental-resistance behavior that destabilizes weak DC buses. A 1 ms low-pass filter on the drawn current tames the step, and UVLO sheds the load below v<sub>min</sub>.</p>';
  h += eq('i<sub>target</sub> = P/v for v &gt; v<sub>min</sub> ,&nbsp; else 0 (UVLO) ,&nbsp; i += (h/1ms)·(i<sub>target</sub> − i) &nbsp;(1 ms LPF)');
  h += '<div class="scisub">Live: P = <b>' + sciNum(P) + '</b> kW, UVLO v<sub>min</sub> = <b>' + sciNum(vmin) + '</b> V. At 380 V the draw is P/v = ' + sciNum(P * 1000 / 380) + ' A; at v<sub>min</sub> it is ' + sciNum(P * 1000 / vmin) + ' A (the precharge inrush the UVLO ceiling keeps below typical I<sub>max</sub>). DC block, 1-ph mode.</div>';
  h += eq('stability (bus cap C, regulating converter k<sub>p</sub>): k<sub>p</sub> &gt; P/V² ,&nbsp; k<sub>i</sub> &gt; 0');
  h += '<div class="scisub">The CPL negative incremental conductance P/V² must be outweighed by the regulating converter\'s k<sub>p</sub>; with the defaults (k<sub>p</sub> = 2 A/V vs P/V² = 0.07 at 380 V) the bus poles sit far in the left half-plane and settle in ~4 ms.</div>';
  h += cplSvg(P, vmin);
  h += '<div class="scisub">The I-V characteristic i = P/v: a hyperbola, zeroed below the UVLO point. The negative slope (more current at less voltage) is the destabilizing property.</div>';
  h += '<details class="sci sci2" open><summary>Scope &amp; limits</summary><div class="scibody">';
  h += '<p>The 1 ms LPF is required: an instantaneous P/v step into a bus cap is the textbook CPL instability. UVLO default 300 V keeps the restart current below typical I<sub>max</sub> so the bus can climb through the UVLO point during current-limited precharge. DC only; sheds load below v<sub>min</sub>.</p>';
  h += '</div></details></div></details>';
  return h;
}
function cplSvg(P, vmin) {
  const st = 'stroke="var(--tx2)" stroke-width="1.2" fill="none"';
  const em = 'stroke="var(--acc)" stroke-width="1.5" fill="none"';
  const tx = 'fill="var(--tx)" font-size="9" font-family="system-ui,sans-serif" text-anchor="middle"';
  const tx2 = 'fill="var(--tx2)" font-size="8.5" font-family="system-ui,sans-serif" text-anchor="middle"';
  const Lb = (x, y, t, c) => '<text x="' + x + '" y="' + y + '" ' + (c || tx2) + '>' + t + '</text>';
  const bx = 30, by = 80, bw = 270, bh = 60;
  const vmax = 400, Imaxc = (P * 1000) / vmin * 1.1;
  const xmap = (v) => bx + (v / vmax) * bw;
  const ymap = (i) => by - (i / Imaxc) * bh;
  const Iv = (v) => (v > vmin ? (P * 1000) / v : 0);
  const d = curvePath(Iv, 0, vmax, 80, xmap, ymap);
  return '<svg class="cct" viewBox="0 0 340 96" xmlns="http://www.w3.org/2000/svg" style="color:var(--tx2)">' +
    '<line x1="' + bx + '" y1="' + by + '" x2="' + (bx + bw) + '" y2="' + by + '" ' + st + '/>' +
    '<line x1="' + bx + '" y1="' + by + '" x2="' + bx + '" y2="' + (by - bh) + '" ' + st + '/>' +
    '<line x1="' + xmap(vmin).toFixed(1) + '" y1="' + by + '" x2="' + xmap(vmin).toFixed(1) + '" y2="' + (by - bh) + '" ' + st + ' stroke-dasharray="2 2"/>' +
    '<path d="' + d + '" ' + em + '/>' +
    Lb(xmap(vmin) - 2, by + 12, 'UVLO', tx2) +
    Lb(bx + bw / 2, by + 12, 'V', tx) + Lb(bx - 5, by - bh, 'I', tx2) +
    '</svg>';
}
// Fault: R to ground at ton, clears at first current zero after toff.
// Reuses the breaker machinery (one-terminal switch to ground). SPEC section 2.
function faultSciencePanel(b) {
  const p = b.params;
  const Rf = +p.Rf, ton = +p.ton, toff = +p.toff, ph = +p.ph;
  const phLbl = ['3-phase (ABC)', 'phase A', 'phase B', 'phase C'][ph] || '3-phase (ABC)';
  const eq = (s) => '<span class="eq">' + s + '</span>';
  let h = '<details class="sci" open><summary>Physics &amp; equations</summary><div class="scibody">';
  h += '<p>A fault applies a resistance R<sub>f</sub> to ground at t<sub>on</sub>, modeling a bolted or resistive short. It reuses the breaker machinery: a one-terminal switch to ground with conductance 1/R<sub>f</sub>, closing at t<sub>on</sub> and clearing at the first current zero after t<sub>off</sub> (−1 = never clears, a sustained fault). It is a one-shot auto-clear device; for repeated close/open sequences use a breaker.</p>';
  h += eq('G = 1/R<sub>f</sub> at t &gt; t<sub>on</sub> ,&nbsp; clears at first current zero after t<sub>off</sub>');
  h += '<div class="scisub">Live: R<sub>f</sub> = <b>' + sciNum(Rf) + '</b> Ω, t<sub>on</sub> = <b>' + sciNum(ton) + '</b> ms, t<sub>off</sub> = <b>' + sciNum(toff) + '</b> ms' + (toff < 0 ? ' (never clears)' : '') + ', ' + phLbl + '. One-terminal shunt to ground.</div>';
  h += faultSvg();
  h += '<div class="scisub">A switch to ground through R<sub>f</sub>: open until t<sub>on</sub>, then closed (fault-on), then cleared at the first natural current zero after t<sub>off</sub>.</div>';
  h += '<details class="sci sci2" open><summary>Scope &amp; limits</summary><div class="scibody">';
  h += '<p>One-shot auto-clear (no reclose). The phase selector picks which phases fault (0 = all three, 1/2/3 = A/B/C only) for unbalanced-fault studies. R<sub>f</sub> = 0 is a bolted fault (the conductance is capped internally so the stamp stays finite). Uses the same current-zero opening and CDA half-step machinery as the breaker.</p>';
  h += '</div></details></div></details>';
  return h;
}
function faultSvg() {
  const st = 'stroke="var(--tx2)" stroke-width="1.2" fill="none"';
  const tx = 'fill="var(--tx)" font-size="9" font-family="system-ui,sans-serif" text-anchor="middle"';
  const tx2 = 'fill="var(--tx2)" font-size="8.5" font-family="system-ui,sans-serif" text-anchor="middle"';
  const Lb = (x, y, t, c) => '<text x="' + x + '" y="' + y + '" ' + (c || tx2) + '>' + t + '</text>';
  return '<svg class="cct" viewBox="0 0 340 70" xmlns="http://www.w3.org/2000/svg" style="color:var(--tx2)">' +
    '<circle cx="40" cy="24" r="2.5" ' + st + '/>' + Lb(40, 16, 'node', tx2) +
    '<line x1="40" y1="24" x2="40" y2="40" ' + st + '/>' +
    '<circle cx="40" cy="40" r="3" ' + st + '/>' + '<line x1="40" y1="40" x2="60" y2="30" ' + st + '/>' + // open switch arm
    '<line x1="40" y1="40" x2="40" y2="50" ' + st + '/>' +
    '<rect x="32" y="50" width="16" height="12" ' + st + '/>' + Lb(40, 60, 'Rf', tx2) +
    '<line x1="40" y1="62" x2="40" y2="68" ' + st + '/>' +
    '<line x1="30" y1="68" x2="50" y2="68" ' + st + '/>' + '<line x1="33" y1="71" x2="47" y2="71" ' + st + '/>' +
    '<line x1="120" y1="20" x2="320" y2="20" ' + st + '/>' + Lb(220, 14, 'timeline', tx) +
    '<line x1="160" y1="16" x2="160" y2="40" ' + st + ' stroke-dasharray="2 2"/>' + Lb(160, 12, 'ton', tx2) +
    '<line x1="250" y1="16" x2="250" y2="40" ' + st + ' stroke-dasharray="2 2"/>' + Lb(250, 12, 'toff', tx2) +
    '<line x1="120" y1="40" x2="160" y2="40" ' + st + '/>' + '<line x1="160" y1="40" x2="250" y2="28" ' + st + ' stroke-width="2.4"/>' + '<line x1="250" y1="28" x2="320" y2="28" ' + st + '/>' +
    '</svg>';
}
// Breaker: conductance switch, current-zero opening, multi-op reclosing.
// SPEC section 2.
function brkSciencePanel(b) {
  const p = b.params;
  const tc = +p.tclose, to = +p.topen, init = +p.init, nOps = Math.max(1, Math.min(5, +p.nOps));
  const eq = (s) => '<span class="eq">' + s + '</span>';
  let h = '<details class="sci" open><summary>Physics &amp; equations</summary><div class="scibody">';
  h += '<p>A breaker is a conductance switch in series: G<sub>on</sub> = 10⁴ S, G<sub>off</sub> = 10⁻⁸ S (never exactly zero, so the matrix stays nominally non-singular). Closing happens at t<sub>close</sub> in all phases; opening ARMS at t<sub>open</sub>, and each pole actually opens at the first current zero of its own current after arming, so the three poles clear at different instants (the physical arc-extinction picture).</p>';
  h += eq('G<sub>on</sub> = 10⁴ S ,&nbsp; G<sub>off</sub> = 10⁻⁸ S ,&nbsp; pole opens when i<sub>p</sub>·cur ≤ 0 after t<sub>open</sub>');
  h += '<div class="scisub">Live: t<sub>close</sub> = <b>' + sciNum(tc) + '</b> ms, t<sub>open</sub> = <b>' + sciNum(to) + '</b> ms' + (to < 0 ? ' (disabled, stays closed)' : '') + ', init = ' + (init ? 'closed' : 'open') + ', # operations = <b>' + nOps + '</b>. ' + (nOps > 1 ? 'Multi-op reclosing: after op N clears, op N+1\'s t<sub>close</sub>/t<sub>open</sub> take over; a t<sub>open</sub> = −1 means "stay closed from here on".' : 'Single close/open.') + '</div>';
  h += brkSvg();
  h += '<div class="scisub">A series switch: the arm closes at t<sub>close</sub>, opens (arms) at t<sub>open</sub>, and each pole parts at its own current zero.</div>';
  h += '<details class="sci sci2" open><summary>Scope &amp; limits</summary><div class="scibody">';
  h += '<p>A state change refactorizes the LU (per phase, each owns its factorization). The standalone breaker latches on opening (real breakers do not auto-reclose); for repeated operation drive it with a relay or switched-shunt controller, or use # operations &gt; 1. Do not combine # operations &gt; 1 with an external relay/vsw brkId link to the same breaker (both would drive the same state).</p>';
  h += '</div></details></div></details>';
  return h;
}
function brkSvg() {
  const st = 'stroke="var(--tx2)" stroke-width="1.2" fill="none"';
  const tx = 'fill="var(--tx)" font-size="9" font-family="system-ui,sans-serif" text-anchor="middle"';
  const tx2 = 'fill="var(--tx2)" font-size="8.5" font-family="system-ui,sans-serif" text-anchor="middle"';
  const Lb = (x, y, t, c) => '<text x="' + x + '" y="' + y + '" ' + (c || tx2) + '>' + t + '</text>';
  return '<svg class="cct" viewBox="0 0 340 60" xmlns="http://www.w3.org/2000/svg" style="color:var(--tx2)">' +
    '<circle cx="40" cy="30" r="2.5" ' + st + '/>' +
    '<line x1="40" y1="30" x2="70" y2="30" ' + st + '/>' +
    '<circle cx="70" cy="30" r="3" ' + st + '/>' + '<line x1="70" y1="30" x2="92" y2="20" ' + st + ' stroke-width="2"/>' +
    '<line x1="92" y1="20" x2="110" y2="30" ' + st + '/>' + '<line x1="110" y1="30" x2="160" y2="30" ' + st + '/>' +
    '<circle cx="160" cy="30" r="2.5" ' + st + '/>' + Lb(85, 14, 'switch', tx2) +
    '<line x1="190" y1="30" x2="320" y2="30" ' + st + '/>' + Lb(255, 22, 'i(t) with current-zero parting', tx2) +
    '<path d="M195 30 q12 -14 24 0 q12 14 24 0 q12 -14 24 0 q12 14 24 0 q12 -14 24 0" ' + st + '/>' +
    '</svg>';
}
// Overcurrent relay, IEEE C37.112. SPEC section 2: inverse-time 51 element
// (dynamic disk-travel integral) + instantaneous 50, trips a brk by ID.
function relaySciencePanel(b) {
  const p = b.params;
  const Ipu = +p.Ipu, curve = p.curve || 'VI', TD = +p.TD, Iinst = +p.Iinst, brkId = +p.brkId;
  const curves = { MI: { A: 0.0515, B: 0.114, p: 0.02 }, VI: { A: 19.61, B: 0.491, p: 2 }, EI: { A: 28.2, B: 0.1217, p: 2 } };
  const c = curves[curve] || curves.VI;
  const tAt = (M) => TD * (c.A / (Math.pow(M, c.p) - 1) + c.B);
  const t3 = tAt(3), t10 = tAt(10);
  const eq = (s) => '<span class="eq">' + s + '</span>';
  let h = '<details class="sci" open><summary>Physics &amp; equations</summary><div class="scibody">';
  h += '<p>An overcurrent relay is the protection DECISION element: a series sensing block (fixed closed conductance; the ~0.1 mV/A drop is the sensing shunt) that trips a separate breaker by block ID. The inverse-time element 51 integrates the IEEE C37.112 dynamic disk-travel form and trips when ∫dt/t(M) ≥ 1; the instantaneous element 50 trips with no intentional delay.</p>';
  h += eq('t(M) = TD·( A/(M<sup>p</sup> − 1) + B ) ,&nbsp; M = I<sub>rms</sub>/I<sub>pu</sub> ,&nbsp; trip when ∫d<i>t</i>/t(M) ≥ 1');
  h += '<div class="scisub">Live: pickup I<sub>pu</sub> = <b>' + sciNum(Ipu) + '</b> A, curve <b>' + curve + '</b> (A = ' + c.A + ', B = ' + c.B + ', p = ' + c.p + '), TD = <b>' + sciNum(TD) + '</b>. Trip time at M = 3: <b>' + sciNum(t3) + ' s</b>; at M = 10: <b>' + sciNum(t10) + ' s</b>. ' + (Iinst > 0 ? 'Instantaneous 50: I<sub>inst</sub> = ' + sciNum(Iinst) + ' A (trips immediately).' : 'Instantaneous 50: off.') + ' Target breaker #' + brkId + '.</div>';
  h += relaySvg(c, TD);
  h += '<div class="scisub">The inverse-time t(M) curve: as the current rises above pickup (M = 1), the trip time falls. Below pickup the disk flies back; plot the trip integral (0 to 1) to watch it wind up.</div>';
  h += '<details class="sci sci2" open><summary>Scope &amp; limits</summary><div class="scibody">';
  h += '<p>One target breaker per relay (the brkId link, validated up front). No directional element, no reclose (the relay trips; the breaker or a vsw handles reclosing). Curve constants per C37.112-1996; the dynamic integral handles time-varying current, not just the constant-M analytic curve. The relay itself never opens, so its LU is never refactorized on its account.</p>';
  h += '</div></details></div></details>';
  return h;
}
function relaySvg(c, TD) {
  const st = 'stroke="var(--tx2)" stroke-width="1.2" fill="none"';
  const em = 'stroke="var(--acc)" stroke-width="1.5" fill="none"';
  const tx = 'fill="var(--tx)" font-size="9" font-family="system-ui,sans-serif" text-anchor="middle"';
  const tx2 = 'fill="var(--tx2)" font-size="8.5" font-family="system-ui,sans-serif" text-anchor="middle"';
  const Lb = (x, y, t, cc) => '<text x="' + x + '" y="' + y + '" ' + (cc || tx2) + '>' + t + '</text>';
  const bx = 30, by = 80, bw = 270, bh = 60;
  const Mmin = 1.01, Mmax = 20;
  const tmin = TD * (c.A / (Math.pow(Mmax, c.p) - 1) + c.B), tmax = TD * (c.A / (Math.pow(Mmin, c.p) - 1) + c.B);
  const xmap = (M) => bx + (Math.log10(M / Mmin) / Math.log10(Mmax / Mmin)) * bw;
  const ymap = (t) => by - (Math.log10(t / tmin) / Math.log10(tmax / tmin)) * bh;
  const tfn = (M) => TD * (c.A / (Math.pow(M, c.p) - 1) + c.B);
  const d = curvePath(tfn, Mmin, Mmax, 40, xmap, ymap);
  return '<svg class="cct" viewBox="0 0 340 96" xmlns="http://www.w3.org/2000/svg" style="color:var(--tx2)">' +
    '<line x1="' + bx + '" y1="' + by + '" x2="' + (bx + bw) + '" y2="' + by + '" ' + st + '/>' +
    '<line x1="' + bx + '" y1="' + by + '" x2="' + bx + '" y2="' + (by - bh) + '" ' + st + '/>' +
    '<path d="' + d + '" ' + em + '/>' +
    Lb(bx + bw / 2, by + 12, 'M = I/Ipu (log)', tx) + Lb(bx - 5, by - bh / 2, 't (log)', tx2) +
    Lb(bx + 2, by + 4, 'pickup', tx2) +
    '</svg>';
}
// Surge arrester (MOV): piecewise-linear two-segment per polarity. SPEC section 2.
function movSciencePanel(b) {
  const p = b.params;
  const Vc = +p.Vc, Rd = +p.Rd;
  const eq = (s) => '<span class="eq">' + s + '</span>';
  let h = '<details class="sci" open><summary>Physics &amp; equations</summary><div class="scibody">';
  h += '<p>A surge arrester (metal-oxide varistor) is the classical clamp for switching and fault-clearing overvoltages: a piecewise-linear resistor with two segments per polarity. Below the knee V<sub>c</sub> it draws only leakage; above it the slope is 1/R<sub>d</sub>, continuous at the knee so segment changes cause no numerical shock. A two-segment PWL model, not the exponential i = k·(v/V<sub>ref</sub>)<sup>α</sup> law (which is unstable without a per-step Newton solve in this LU-once solver).</p>';
  h += eq('|v| ≤ V<sub>c</sub>: i = G<sub>off</sub>·v (leakage) ,&nbsp; v &gt; V<sub>c</sub>: i = (v − V<sub>c</sub>)/R<sub>d</sub> ,&nbsp; v &lt; −V<sub>c</sub>: i = (v + V<sub>c</sub>)/R<sub>d</sub>');
  h += '<div class="scisub">Live: knee V<sub>c</sub> = <b>' + sciNum(Vc) + '</b> V (peak), clamp slope R<sub>d</sub> = <b>' + sciNum(Rd) + '</b> Ω (1/R<sub>d</sub> = ' + sciNum(1 / Rd) + ' S). Leakage G<sub>off</sub> = 10⁻⁸ S. Conducts only near voltage peaks, so expect a handful of LU refactors per cycle while clamping (bounded).</div>';
  h += movSvg(Vc, Rd);
  h += '<div class="scisub">The i-v characteristic: nearly flat (leakage) below the knee, then a steep affine clamp above ±V<sub>c</sub>, continuous at the knees.</div>';
  h += '<details class="sci sci2" open><summary>Scope &amp; limits</summary><div class="scibody">';
  h += '<p>Two-segment piecewise-linear only (no α exponent, no frequency-dependent or IEEE-WG dynamic arrester model, no energy accumulator or failure model). Segment selection uses the same generic segCheck hook a breaker uses, triggering an LU refactor and CDA half-steps only when the conductance actually changes (near the voltage peaks).</p>';
  h += '</div></details></div></details>';
  return h;
}
function movSvg(Vc, Rd) {
  const st = 'stroke="var(--tx2)" stroke-width="1.2" fill="none"';
  const em = 'stroke="var(--acc)" stroke-width="1.5" fill="none"';
  const tx = 'fill="var(--tx)" font-size="9" font-family="system-ui,sans-serif" text-anchor="middle"';
  const tx2 = 'fill="var(--tx2)" font-size="8.5" font-family="system-ui,sans-serif" text-anchor="middle"';
  const Lb = (x, y, t, c) => '<text x="' + x + '" y="' + y + '" ' + (c || tx2) + '>' + t + '</text>';
  const bx = 40, by = 50, bw = 260, bh = 80;
  const vmax = Vc * 1.4, imax = (vmax - Vc) / Rd * 1.1;
  const xmap = (v) => bx + ((v + vmax) / (2 * vmax)) * bw;
  const ymap = (i) => by - ((i + imax) / (2 * imax)) * bh;
  const iv = (v) => {
    if (v > Vc) return (v - Vc) / Rd;
    if (v < -Vc) return (v + Vc) / Rd;
    return 1e-8 * v;
  };
  const d = curvePath(iv, -vmax, vmax, 80, xmap, ymap);
  return '<svg class="cct" viewBox="0 0 340 96" xmlns="http://www.w3.org/2000/svg" style="color:var(--tx2)">' +
    '<line x1="' + bx + '" y1="' + by + '" x2="' + (bx + bw) + '" y2="' + by + '" ' + st + '/>' +
    '<line x1="' + xmap(0).toFixed(1) + '" y1="' + by + '" x2="' + xmap(0).toFixed(1) + '" y2="' + (by - bh) + '" ' + st + '/>' +
    '<path d="' + d + '" ' + em + '/>' +
    Lb(xmap(Vc) + 2, by + 12, '+Vc', tx2) + Lb(xmap(-Vc) - 2, by + 12, '−Vc', tx2) +
    Lb(bx + bw / 2, by - bh - 4, 'i-v (PWL clamp)', tx) +
    '</svg>';
}
// Switched-shunt voltage controller (vsw): a sensor that closes/opens a brk
// by ID to switch a cap/reactor bank. SPEC section 2.
function vswSciencePanel(b) {
  const p = b.params;
  const brkId = +p.brkId, mode = +p.mode, Von = +p.Von, Voff = +p.Voff, Td = +p.Td;
  const dead = Voff - Von;
  const eq = (s) => '<span class="eq">' + s + '</span>';
  let h = '<details class="sci" open><summary>Physics &amp; equations</summary><div class="scibody">';
  h += '<p>A switched-shunt voltage controller is a SENSOR (no stamp, no injection, the probe of the control family) that closes or opens a breaker by block ID to switch a capacitor or reactor bank (the bank itself is a cap or rlc behind that breaker). V<sub>rms</sub> comes from a one-cycle moving average so switching transients do not chatter the thresholds.</p>';
  h += eq(mode === 1
    ? 'mode 1 (reactor): close when V<sub>rms</sub> &gt; V<sub>on</sub>, open when &lt; V<sub>off</sub>'
    : 'mode 0 (capacitor): close when V<sub>rms</sub> &lt; V<sub>on</sub>, open when &gt; V<sub>off</sub>');
  h += '<div class="scisub">Live: target breaker #' + brkId + ', mode ' + (mode ? 'limit (reactor bank)' : 'support (capacitor bank)') + ', V<sub>on</sub> = <b>' + sciNum(Von) + '</b> V, V<sub>off</sub> = <b>' + sciNum(Voff) + '</b> V (dead band ' + sciNum(dead) + ' V holds the bank in), delay T<sub>d</sub> = <b>' + sciNum(Td) + '</b> ms (the condition must hold continuously). Allows reclose (a switched shunt is built to repeat); a standalone breaker forbids it. Commanded bank state (0/1) is the aux signal.</div>';
  h += vswSvg(mode, Von, Voff);
  h += '<div class="scisub">The V bands: a dead band between V<sub>on</sub> and V<sub>off</sub> holds the current state, so the bank does not chatter at the threshold.</div>';
  h += '<details class="sci sci2" open><summary>Scope &amp; limits</summary><div class="scibody">';
  h += '<p>No stamp and no injection (pure sensor); it only drives a target breaker. The one-cycle RMS window shares the off-nominal-frequency caveat of the PQ load (exact only for a steady sinusoid at the window\'s nominal frequency). The controller-driven reclose path is exempt from the standalone breaker\'s no-reclose latch.</p>';
  h += '</div></details></div></details>';
  return h;
}
function vswSvg(mode, Von, Voff) {
  const st = 'stroke="var(--tx2)" stroke-width="1.2" fill="none"';
  const em = 'stroke="var(--acc)" stroke-width="1.4" fill="none"';
  const tx = 'fill="var(--tx)" font-size="9" font-family="system-ui,sans-serif" text-anchor="middle"';
  const tx2 = 'fill="var(--tx2)" font-size="8.5" font-family="system-ui,sans-serif" text-anchor="middle"';
  const Lb = (x, y, t, c) => '<text x="' + x + '" y="' + y + '" ' + (c || tx2) + '>' + t + '</text>';
  const bx = 40, by = 80, bw = 260, bh = 60;
  const lo = Math.min(Von, Voff) - 10, hi = Math.max(Von, Voff) + 10;
  const xmap = (V) => bx + ((V - lo) / (hi - lo)) * bw;
  // bank-state bar: closed in the action region, open in the dead band
  const yClosed = by - bh + 6, yOpen = by - 6;
  const closedRange = mode === 1 ? [Von, hi] : [lo, Von];
  const s = '<svg class="cct" viewBox="0 0 340 96" xmlns="http://www.w3.org/2000/svg" style="color:var(--tx2)">' +
    '<line x1="' + bx + '" y1="' + by + '" x2="' + (bx + bw) + '" y2="' + by + '" ' + st + '/>' +
    '<line x1="' + xmap(Von).toFixed(1) + '" y1="' + by + '" x2="' + xmap(Von).toFixed(1) + '" y2="' + (by - bh) + '" ' + st + ' stroke-dasharray="2 2"/>' +
    '<line x1="' + xmap(Voff).toFixed(1) + '" y1="' + by + '" x2="' + xmap(Voff).toFixed(1) + '" y2="' + (by - bh) + '" ' + st + ' stroke-dasharray="2 2"/>' +
    '<line x1="' + xmap(closedRange[0]).toFixed(1) + '" y1="' + yClosed + '" x2="' + xmap(closedRange[1]).toFixed(1) + '" y2="' + yClosed + '" ' + em + ' stroke-width="3"/>' +
    Lb(xmap(Von), by + 12, 'Von', tx2) + Lb(xmap(Voff), by + 12, 'Voff', tx2) +
    Lb(bx + bw / 2, by - bh - 5, 'Vrms (bank closed in accent band)', tx) +
    '</svg>';
  return s;
}
// Latching generation-trip relay (gtrip): voltage and frequency protection
// that trips a target breaker by block ID. The latch is never cleared.
function gtripSciencePanel(b) {
  const p = b.params;
  const brkId = +p.brkId, Vov = +p.Vov, Vuv = +p.Vuv, Tdv = +p.Tdv;
  const Fov = +p.Fov, Fuv = +p.Fuv, Tdf = +p.Tdf;
  const hysV = +p.hysV, hysF = +p.hysF, Vblk = +p.Vblk, f0 = +p.f0 || 60;
  const KpPLL = +p.KpPLL || 30, KiPLL = +p.KiPLL || 900;
  const w0 = 2 * Math.PI * f0;
  const wn = Math.sqrt(KiPLL), zeta = KpPLL / (2 * wn);
  const tSettle = (4 / (zeta * wn) * 1000).toFixed(0);
  const eq = (s) => '<span class="eq">' + s + '</span>';
  let h = '<details class="sci" open><summary>Physics &amp; equations</summary><div class="scibody">';
  h += '<p>A latching generation-trip relay is a SENSOR (no stamp, no injection, it cannot perturb the circuit it measures) that watches Vrms and bus frequency at its node and trips a target breaker by block ID. Four definite-time elements with pickup/dropout hysteresis: 59 (overvoltage), 27 (undervoltage), 81O (overfrequency), 81U (underfrequency). Each element owns its own dwell timer; the first to time out latches the trip permanently for the rest of the run.</p>';
  h += eq('59: pick Vrms &ge; Vov, drop Vrms &lt; Vov(1 ' + (hysV ? '&minus;' : '+') + ' hysV)');
  h += '<br>' + eq('27: pick Vrms &le; Vuv, drop Vrms &gt; Vuv(1 + hysV)');
  if (Fov > 0 || Fuv > 0) {
    h += '<br>' + eq('81O: pick f &ge; Fov, drop f &lt; Fov ' + (hysF ? '&minus;' : '+') + ' hysF');
    h += ',&nbsp;' + eq('81U: pick f &le; Fuv, drop f &gt; Fuv + hysF');
  }
  h += '<div class="scisub">Live: target breaker #' + brkId;
  if (Vov > 0) h += ', 59 at ' + sciNum(Vov) + ' V';
  if (Vuv > 0) h += ', 27 at ' + sciNum(Vuv) + ' V';
  if (Fov > 0) h += ', 81O at ' + sciNum(Fov) + ' Hz';
  if (Fuv > 0) h += ', 81U at ' + sciNum(Fuv) + ' Hz';
  h += ', delay V = <b>' + sciNum(Tdv) + '</b> ms, f = <b>' + sciNum(Tdf) + '</b> ms';
  if (Vblk > 0) h += ', Vblk = <b>' + sciNum(Vblk) + '</b> V';
  h += '.</div>';
  h += '<p>The bus frequency comes from an SRF-PLL (synchronous reference frame phase-locked loop): the node voltages are projected onto a rotating frame, averaged over one cycle, and the angle error drives a PI controller. Two frequencies are computed: the VCO frequency (proportional + integral) tracks theta for the correlator, while the measurement frequency (integral state only) feeds the 81 elements and the aux signal. This separation prevents transient spikes in the proportional path from false-tripping the relay.</p>';
  h += eq('f<sub>meas</sub> = f0 + Ki&middot;&int;delta / (2&pi;) ,&nbsp; locked when |delta| &lt; 2deg for one cycle');
  h += '<div class="scisub">PLL: wn = ' + wn.toFixed(1) + ' rad/s (' + (wn/(2*Math.PI)).toFixed(1) + ' Hz), zeta = ' + zeta.toFixed(2) + ', settling ~' + tSettle + ' ms. The 81 elements are held at zero while the PLL is not locked or Vrms falls below Vblk (the classical 27-block-81 guard).</div>';
  h += gtripSvg(Vov > 0, Vuv > 0, Fov > 0, Fuv > 0);
  h += '<details class="sci sci2" open><summary>Scope &amp; limits</summary><div class="scibody">';
  h += '<p>No stamp and no injection (pure sensor); it only arms a target breaker. The latch is never cleared within a run (a generator trip stays tripped, unlike vsw which recloses). Place the gtrip on the network side of the generator\'s breaker so it keeps watching system frequency after the machine is isolated. The 81 elements are 3-phase AC only (the SRF-PLL needs three phases); on a lateral or in 1-phase mode only 59/27 exist. Each condition must hold continuously for its delay; between pickup and dropout the timer keeps running (hysteresis prevents ripple from holding off a trip).</p>';
  h += '</div></details></div></details>';
  return h;
}
// Distance / line-protection relay (zrel): apparent-impedance characteristic.
function zrelSciencePanel(b) {
  const p = b.params;
  const Z1 = +p.Z1, T1 = +p.T1, Z2 = +p.Z2, T2 = +p.T2, Z3 = +p.Z3, T3 = +p.T3;
  const theta = +p.theta || 80, mode = String(p.mode || 'mho').toLowerCase().trim();
  const brkId = +p.brkId, f = +p.f || 60;
  const th = theta * Math.PI / 180;
  const eq = (s) => '<span class="eq">' + s + '</span>';
  let h = '<details class="sci" open><summary>Physics &amp; equations</summary><div class="scibody">';
  h += '<p>A distance relay is the line-protection decision element: a series sensor that extracts the positive-sequence voltage at its terminal and the current through the protected line, forms the apparent impedance Z = V/I, and trips a separate breaker when Z enters a reach characteristic for the set delay.</p>';
  h += eq('Z = V<sub>1</sub> / I<sub>1</sub> = |Z|·e<sup>j∠Z</sup>');
  h += '<div class="scisub">Live: target breaker #' + brkId + ', nominal frequency ' + f + ' Hz, one-cycle RMS/phasor window.</div>';
  if (mode === 'imp') {
    h += eq('impedance circle: |Z − Z<sub>r</sub>·e<sup>jθ</sup>| &lt; Z<sub>r</sub>');
    h += '<div class="scisub">Plain impedance-circle mode: center at (' + Z1.toFixed(1) + '·cosθ, ' + Z1.toFixed(1) + '·sinθ) Ω, radius = reach. Zone 1: ' + Z1 + ' Ω / ' + T1 + ' ms; Zone 2: ' + Z2 + ' Ω / ' + T2 + ' ms; Zone 3: ' + Z3 + ' Ω / ' + T3 + ' ms.</div>';
  } else {
    h += eq('mho circle: |Z − (Z<sub>r</sub>/2)·e<sup>jθ</sup>| &lt; Z<sub>r</sub>/2');
    h += '<div class="scisub">Mho mode: circle diameter from the origin to Z<sub>r</sub>·e<sup>jθ</sup> (characteristic angle θ = ' + theta + '°). Zone 1: ' + Z1 + ' Ω / ' + T1 + ' ms; Zone 2: ' + Z2 + ' Ω / ' + T2 + ' ms; Zone 3: ' + Z3 + ' Ω / ' + T3 + ' ms. A fault close to the relay has small |Z| and sits near the origin; a remote fault has large |Z| and sits near the reach boundary.</div>';
  }
  h += zrelSvg(mode, Z1, Z2, Z3, th);
  const oos = Math.round(+p.oos || 0);
  if (oos > 0) {
    h += '<details class="sci sci2" open><summary>Out-of-step (double blinder)</summary><div class="scibody">';
    h += '<p>Distance zones cannot see a system separation. A separation swing is a mostly RESISTIVE excursion, and a mho circle set at the line angle has almost no resistive coverage, so it never picks up however far it is reached. The classical answer discriminates on TIME instead of position.</p>';
    h += eq('u = R·sin θ − X·cos θ');
    h += '<div class="scisub">Two blinders parallel to the line characteristic, at |u| = ' + (+p.RB1) + ' Ω (inner) and ' + (+p.RB2) + ' Ω (outer). A fault steps the impedance across in one sample; two systems pulling apart take tens of milliseconds. A transit slower than T<sub>sw</sub> = ' + (+p.Tsw) + ' ms is therefore a power swing, not a fault.</div>';
    h += '<div class="scisub">Trip logic: <b>' + (oos === 2 ? 'on the way IN' : 'on the way OUT') + '</b>. ' + (oos === 2
      ? 'The trip is issued as soon as the swing is declared.'
      : 'The trip waits for the locus to leave the outer blinder on the far side, i.e. a completed pole slip, so the breaker interrupts with the systems swinging back together and sees far less recovery voltage than it would at the 180° point. This is the classical preference.') + '</div>';
    h += '</div></details>';
  }
  h += '<details class="sci sci2" open><summary>Scope &amp; limits</summary><div class="scibody">';
  h += '<p>Public-domain core only: mho and plain impedance reach with definite-time delays, plus the classical double-blinder out-of-step scheme' + (oos > 0 ? '' : ' (set "OOS trip" to enable)') + '. No directional element, no quadrilateral or lens characteristics, no out-of-step BLOCKING of the distance zones (only tripping), no trip-on-Nth-slip counter, no sequence-component supervision, no communication-assisted schemes, no traveling-wave fault location. The relay is a 3-ph AC element: it needs a full 3-phase node, not a lateral or 1-ph run. One target breaker per relay.</p>';
  h += '</div></details></div></details>';
  return h;
}
function zrelSvg(mode, Z1, Z2, Z3, th) {
  const st = 'stroke="var(--tx2)" stroke-width="1.2" fill="none"';
  const em = 'stroke="var(--acc)" stroke-width="1.4" fill="none"';
  const em2 = 'stroke="var(--acc2)" stroke-width="1.2" fill="none" stroke-dasharray="3 2"';
  const tx = 'fill="var(--tx)" font-size="9" font-family="system-ui,sans-serif" text-anchor="middle"';
  const tx2 = 'fill="var(--tx2)" font-size="8.5" font-family="system-ui,sans-serif" text-anchor="middle"';
  const Lb = (x, y, t, c) => '<text x="' + x + '" y="' + y + '" ' + (c || tx2) + '>' + t + '</text>';
  const bx = 40, by = 80, bw = 260, bh = 70;
  const Zmax = Math.max(Z1, Z2, Z3) * 1.2;
  const xmap = (R) => bx + (0.5 + 0.5 * R / Zmax) * bw;
  const ymap = (X) => by - (0.2 + 0.8 * X / Zmax) * bh;
  const circle = (Zr, dash) => {
    const Zx = Zr * Math.cos(th), Zy = Zr * Math.sin(th);
    const cx = mode === 'imp' ? xmap(Zx) : xmap(Zx / 2);
    const cy = mode === 'imp' ? ymap(Zy) : ymap(Zy / 2);
    const r = (mode === 'imp' ? Zr : Zr / 2) * (bw / 2) / Zmax;
    return '<circle cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="' + r.toFixed(1) + '" ' + (dash ? em2 : em) + '/>';
  };
  let s = '<svg class="cct" viewBox="0 0 340 96" xmlns="http://www.w3.org/2000/svg" style="color:var(--tx2)">';
  s += '<line x1="' + bx + '" y1="' + by + '" x2="' + (bx + bw) + '" y2="' + by + '" ' + st + '/>'; // R axis
  s += '<line x1="' + xmap(0) + '" y1="' + (by + 10) + '" x2="' + xmap(0) + '" y2="' + (by - bh) + '" ' + st + '/>'; // X axis
  s += circle(Z3, true) + circle(Z2, true) + circle(Z1, false);
  s += Lb(xmap(Zmax), by + 12, 'R (Ω)', tx) + Lb(xmap(0) - 10, by - bh - 4, 'X (Ω)', tx2);
  s += Lb(xmap(0), by + 22, 'relay', tx2);
  s += '</svg>';
  return s;
}
function gtripSvg(has59, has27, has81O, has81U) {
  const st = 'stroke="var(--tx2)" stroke-width="1.2" fill="none"';
  const em = 'stroke="var(--acc)" stroke-width="1.6" fill="none"';
  const tx = 'fill="var(--tx)" font-size="9" font-family="system-ui,sans-serif" text-anchor="middle"';
  const tx2 = 'fill="var(--tx2)" font-size="8.5" font-family="system-ui,sans-serif" text-anchor="middle"';
  const Lb = (x, y, t, c) => '<text x="' + x + '" y="' + y + '" ' + (c || tx2) + '>' + t + '</text>';
  const s = '<svg class="cct" viewBox="0 0 340 96" xmlns="http://www.w3.org/2000/svg" style="color:var(--tx2)">' +
    // Four element boxes arranged in a row
    ((has59 || has27) ? ('<rect x="10" y="30" width="50" height="30" rx="4" ' + (has59 || has27 ? em : st) + '/>' +
      Lb(35, 50, (has59 ? '59' : '') + (has59 && has27 ? '/' : '') + (has27 ? '27' : ''), tx)) : '') +
    ((has81O || has81U) ? ('<rect x="90" y="30" width="50" height="30" rx="4" ' + (has81O || has81U ? em : st) + '/>' +
      Lb(115, 50, (has81O ? '81O' : '') + (has81O && has81U ? '/' : '') + (has81U ? '81U' : ''), tx)) : '') +
    // Arrow to trip
    '<path d="M' + ((has59 || has27) ? '160' : (has81O || has81U ? '140' : '80')) + ',45 L' + ((has59 || has27) ? '190' : (has81O || has81U ? '170' : '110')) + ',45" ' + em + ' marker-end="url(#arr)"/>' +
    '<polygon points="190,42 198,45 190,48" fill="var(--acc)" stroke="none"/>' +
    Lb(220, 48, 'TRIP (latched)', tx) +
    '<rect x="200" y="30" width="70" height="30" rx="4" ' + em + '/>' +
    // Labels
    Lb(170, 25, 'any element times out', tx2) +
    '</svg>';
  return s;
}
// Aggregation current-scaling coupler (scale). SPEC section 2: N identical
// replicas represented by one reference unit; asymmetric dependent-source
// stamp Y = g*[[N,-N],[-1,1]]; does NOT conserve power at the coupling.
function scaleSciencePanel(b) {
  const p = b.params;
  const N = +p.N, Rf = +p.Rf;
  const eq = (s) => '<span class="eq">' + s + '</span>';
  let h = '<details class="sci" open><summary>Physics &amp; equations</summary><div class="scibody">';
  h += '<p>An aggregation scaling coupler represents N identical parallel copies of one reference unit (a hyperscale datacenter is N copies of one 1 to 2 MW UPS chain). Build ONE reference unit at a well-conditioned native scale; term 0 (network side) carries N× term 1 current, so the shared network sees the aggregate while the reference unit senses the real unscaled voltage. It deliberately does NOT conserve power at the coupling: it stands in for the N−1 replicas that are never separately simulated.</p>';
  h += eq('Y = g·[[N, −N],[−1, 1]] ,&nbsp; g = 1/R<sub>f</sub> ,&nbsp; I<sub>term0</sub> = N·I<sub>term1</sub>');
  h += '<div class="scisub">Live: N = <b>' + sciNum(N) + '</b> replicas, coupling R<sub>f</sub> = <b>' + sciNum(Rf) + '</b> Ω. The stamp is asymmetric (the off-diagonals are −N·g and −g, NOT equal, unlike every other 2-terminal stamp): the algebraic expression of a unity-gain VCVS (term 1 tracks term 0) and a gain-N CCCS (term 0 receives N× term 1\'s draw). 3-ph AC only.</div>';
  h += scaleSvg(N);
  h += '<div class="scisub">Term 0 (network) and term 1 (reference unit) sit at nearly the same voltage but carry different current: term 0 carries the aggregate (N copies), term 1 carries one.</div>';
  h += '<details class="sci sci2" open><summary>Scope &amp; limits</summary><div class="scibody">';
  h += '<p>3-ph AC only; not a real conductor (no power conservation at the coupling, by design). R<sub>f</sub> is the small coupling resistance that keeps the two nodes from being identical. Use it to study a fleet at scale without resizing every gain by hand (the error class a per-element resize turns up). Same-step algebraic stamp, no history term.</p>';
  h += '</div></details></div></details>';
  return h;
}
function scaleSvg(N) {
  const st = 'stroke="var(--tx2)" stroke-width="1.2" fill="none"';
  const em = 'stroke="var(--acc)" stroke-width="1.4" fill="none"';
  const fl = 'fill="var(--sfc1)" stroke="var(--tx2)" stroke-width="1.2"';
  const tx = 'fill="var(--tx)" font-size="9" font-family="system-ui,sans-serif" text-anchor="middle"';
  const tx2 = 'fill="var(--tx2)" font-size="8.5" font-family="system-ui,sans-serif" text-anchor="middle"';
  const Lb = (x, y, t, c) => '<text x="' + x + '" y="' + y + '" ' + (c || tx2) + '>' + t + '</text>';
  return '<svg class="cct" viewBox="0 0 340 80" xmlns="http://www.w3.org/2000/svg" style="color:var(--tx2)">' +
    '<circle cx="30" cy="40" r="2.5" ' + st + '/>' + Lb(30, 30, 'network', tx) +
    '<line x1="30" y1="40" x2="120" y2="40" ' + st + '/>' + Lb(75, 34, 'N·I', tx2) +
    '<rect x="120" y="28" width="60" height="24" rx="3" ' + fl + '/>' + Lb(150, 44, 'scale', tx) +
    '<line x1="180" y1="40" x2="310" y2="40" ' + st + '/>' + Lb(245, 34, 'I', tx2) +
    '<circle cx="310" cy="40" r="2.5" ' + st + '/>' + Lb(310, 30, '1 unit', tx) +
    '<path d="M150 52 L150 66 L90 66" ' + em + '/>' + '<path d="M86 66 l8 -4 v8 z" fill="var(--acc)"/>' + Lb(60, 64, 'V sense', tx2) +
    Lb(150, 22, 'N=' + N, tx) +
    '</svg>';
}
function setParam(id, key, val) {
  pushHistory(); touchModel();
  S.blocks.find(x => x.id === id).params[key] = val;
  render();
}
function delSelected() {
  if (!S.sel.length) { delSelectedWire(); return; } // Delete with only a wire selected removes the wire
  pushHistory(); touchModel();
  const ids = S.sel;
  S.wires = S.wires.filter(w => !ids.includes(w.a[0]) && !ids.includes(w.b[0]));
  S.blocks = S.blocks.filter(b => !ids.includes(b.id));
  ids.forEach(pruneBlockSignals); // drop the deleted blocks' signals now, even if the
  S.sel = [];                     // next run fails (a failed run never rebuilds the registry)
  selWire = null;                 // wire indices just shifted; any wire selection is stale
  render(); showProps();
}

// ---- clipboard: copy / cut / paste / duplicate ----
// Building anything repetitive meant a trip to the Library per block plus
// retyping every parameter. A feeder is the same three blocks over and over,
// and the app shipped a 39-bus example while offering no way to copy one.
//
// The load-bearing part is that a multi-block copy keeps the wiring INTERNAL to
// the selection. Copying a line plus its breaker and getting two unconnected
// blocks back is barely better than placing them by hand; the wiring is most of
// the work. Wires with exactly one end in the selection are dropped, because
// their other end is a block the paste has no copy of.
//
// An in-page clipboard, not the system one: the system clipboard needs a secure
// context, which file:// is not, and this app is meant to work opened straight
// off disk. The cost is that copying between two OpenEMT tabs does not work,
// which Save/Load already covers.
let clipboard = null;
const PASTE_OFFSET = 24; // world units, so a paste lands visibly beside the original
function copySelection(cut) {
  if (!S.sel.length) { showWarn('Select one or more blocks first, then copy.'); return false; }
  const ids = new Set(S.sel);
  const blocks = S.blocks.filter(b => ids.has(b.id));
  clipboard = {
    blocks: JSON.parse(JSON.stringify(blocks)),
    // Store wire ends as INDICES into the copied block array, not block ids:
    // the ids are reassigned on paste, and an index survives that.
    wires: S.wires.filter(w => ids.has(w.a[0]) && ids.has(w.b[0])).map(w => ({
      a: [blocks.findIndex(b => b.id === w.a[0]), w.a[1]],
      b: [blocks.findIndex(b => b.id === w.b[0]), w.b[1]]
    }))
  };
  if (cut) delSelected();
  const n = clipboard.blocks.length, m = clipboard.wires.length;
  setStatus((cut ? 'Cut ' : 'Copied ') + n + ' block' + (n === 1 ? '' : 's')
    + (m ? ' and ' + m + ' wire' + (m === 1 ? '' : 's') + ' between them' : '')
    + '. Ctrl+V to paste.');
  return true;
}
// dx/dy let Duplicate reuse this with a fixed offset. Pasted blocks become the
// new selection, so a second Ctrl+V steps further out rather than stacking.
function pasteClipboard(dx, dy) {
  if (!clipboard || !clipboard.blocks.length) {
    showWarn('Nothing to paste. Select blocks and press Ctrl+C first.'); return;
  }
  pushHistory(); touchModel();
  const ox = dx == null ? PASTE_OFFSET : dx, oy = dy == null ? PASTE_OFFSET : dy;
  const made = clipboard.blocks.map(src => {
    const b = JSON.parse(JSON.stringify(src));
    b.id = S.nextId++; b.x += ox; b.y += oy;
    // pfInit/pfV are a saved operating point, not part of the model (CLAUDE.md).
    // Carrying them into a copy would start the new block from another block's
    // solve, so they are stripped here the same way the build strips them.
    delete b.pfInit; delete b.pfV;
    S.blocks.push(b); return b;
  });
  clipboard.wires.forEach(w => {
    if (!made[w.a[0]] || !made[w.b[0]]) return;
    S.wires.push({ a: [made[w.a[0]].id, w.a[1]], b: [made[w.b[0]].id, w.b[1]] });
  });
  S.sel = made.map(b => b.id); selWire = null;
  // Paste again and the copies walk, rather than piling on the same spot.
  clipboard.blocks.forEach(b => { b.x += ox; b.y += oy; });
  const n = made.length, m = clipboard.wires.length;
  setStatus('Pasted ' + n + ' block' + (n === 1 ? '' : 's')
    + (m ? ' and ' + m + ' wire' + (m === 1 ? '' : 's') : '') + '. Ctrl+Z to undo.');
  render(); showProps();
}
function duplicateSelection() {
  if (!S.sel.length) { showWarn('Select one or more blocks first, then duplicate.'); return; }
  const keep = clipboard;      // Duplicate must not clobber what the user copied
  if (copySelection(false)) pasteClipboard();
  clipboard = keep || clipboard;
}
function selectAllBlocks() {
  if (!S.blocks.length) return;
  S.sel = S.blocks.map(b => b.id); selWire = null;
  setStatus('Selected all ' + S.sel.length + ' blocks.');
  render(); showProps();
}
// Arrow keys nudge the selection. Shift is the coarse step, matching the grid
// most schematic editors use, so fine alignment does not need the mouse.
function nudgeSelection(dx, dy) {
  if (!S.sel.length) return;
  pushHistory(); touchModel();
  S.blocks.forEach(b => { if (S.sel.includes(b.id)) { b.x += dx; b.y += dy; } });
  render(); showProps();
}

// ---- auto-layout (hierarchical tier-based left-to-right or top-to-bottom) ----
// 'fit' is the only direction offered in the UI right now. 'lr' and 'tb' still
// work in doHierarchicalLayout() and are reachable from the API, but the dialog
// disables them: busAwareLayout() has no direction of its own, so on any
// meshed network (3+ buses) 'lr' silently produced the same figure as 'fit'
// while 'tb' fell back to a tidy-tree that draws such networks badly. Rather
// than ship a control that appears to do nothing, the options are greyed until
// busAwareLayout() learns to transpose. Tracked in IDEAS.md.
let layoutDir = 'fit';
function openLayoutDialog() {
  const dlg = document.getElementById('layoutdlg');
  if (dlg) {
    dlg.style.display = 'block';
    // Position it near the button click (approximate center of canvas area)
    dlg.style.left = '120px'; dlg.style.top = '60px';
  }
}
function closeLayoutDialog() {
  const dlg = document.getElementById('layoutdlg');
  if (dlg) dlg.style.display = 'none';
}
function selectLayoutDir(dir) {
  layoutDir = dir;
  document.querySelectorAll('.layoutopt').forEach(opt => {
    if (opt.dataset.dir === dir) opt.classList.add('active');
    else opt.classList.remove('active');
  });
}
function applyLayout() {
  doHierarchicalLayout(layoutDir);
  closeLayoutDialog();
}

// ---- Bus-aware layout for meshed power networks (DECISIONS.md 2026-07-15) ----
// Treats buses as the structural backbone. Builds a graph whose nodes are the
// bus blocks and whose edges are the 2-terminal "connector" elements (line /
// xfmr / brk) that bridge two buses; lays that graph out in columns (BFS layers
// from the highest-generation bus, barycentric crossing reduction within each
// column); then hangs every bus's LOCAL branch (generator+step-up+ground,
// load+ground, a lone probe) off its taps. Buses are drawn vertical (rot 90) so
// taps stack and connections leave horizontally, perpendicular to the bar.
// Returns false — caller falls back to the tidy-tree — when there are fewer
// than two buses or the buses are not interconnected.
function busAwareLayout() {
  const GAP = 34;
  const byId = new Map(S.blocks.map(b => [b.id, b]));
  const buses = S.blocks.filter(b => b.type === 'bus');
  const busIds = new Set(buses.map(b => b.id));
  if (buses.length < 2) return false;

  // adjacency over all blocks: which block, via which of MY terminals, on which wire
  const adj = new Map(S.blocks.map(b => [b.id, []]));
  S.wires.forEach((w, wi) => {
    adj.get(w.a[0]).push({ nid: w.b[0], selfT: w.a[1], wi });
    adj.get(w.b[0]).push({ nid: w.a[0], selfT: w.b[1], wi });
  });

  // connected components of the NON-bus blocks (buses are the cut points)
  const comp = new Map(); let nc = 0;
  const nonbus = S.blocks.filter(b => !busIds.has(b.id));
  nonbus.forEach(b => {
    if (comp.has(b.id)) return;
    const cid = nc++; comp.set(b.id, cid); const q = [b.id];
    while (q.length) { const x = q.shift();
      adj.get(x).forEach(e => { if (busIds.has(e.nid)) return; if (!comp.has(e.nid)) { comp.set(e.nid, cid); q.push(e.nid); } }); }
  });
  // which buses each component attaches to (and the block/wire doing the attaching)
  const touches = new Map();
  nonbus.forEach(b => adj.get(b.id).forEach(e => {
    if (!busIds.has(e.nid)) return;
    const cid = comp.get(b.id);
    if (!touches.has(cid)) touches.set(cid, []);
    touches.get(cid).push({ bus: e.nid, blk: b.id, wi: e.wi });
  }));
  const compBlocks = new Map();
  nonbus.forEach(b => { const c = comp.get(b.id); (compBlocks.get(c) || compBlocks.set(c, []).get(c)).push(b.id); });

  // classify each component: connector (bridges 2 buses) vs local branch (1 bus).
  // A component on 3+ buses (a three-winding transformer) is drawn as a connector
  // between its two BEST-CONNECTED buses, and every further bus becomes a
  // SATELLITE parked beside the component body rather than entering the column
  // grid. The old "keep the first pair" left the third bus out of the bus graph
  // entirely, so it fell to layer 0, landed in the leftmost column and dragged
  // its winding wire across the whole figure (DECISIONS.md 2026-08-01).
  const busDeg = new Map(buses.map(b => [b.id, 0]));
  touches.forEach(arr => [...new Set(arr.map(a => a.bus))].forEach(id => busDeg.set(id, busDeg.get(id) + 1)));
  const connectors = [], locals = [], satOf = new Map();
  touches.forEach((arr, cid) => {
    const ub = [...new Set(arr.map(a => a.bus))];
    if (ub.length === 1) { locals.push({ cid, bus: ub[0], ends: arr, blocks: compBlocks.get(cid) }); return; }
    if (ub.length === 2) { connectors.push({ cid, ends: arr, buses: ub }); return; }
    const rank = ub.slice().sort((x, y) => busDeg.get(y) - busDeg.get(x));
    const main = rank.slice(0, 2), sats = rank.slice(2);
    connectors.push({ cid, ends: arr.filter(e => main.includes(e.bus)), buses: main, sats });
    sats.forEach(id => satOf.set(id, { cid, ends: arr.filter(e => e.bus === id) }));
  });
  if (!connectors.length) return false; // buses not tied together -> tidy-tree does better
  const gridBuses = buses.filter(b => !satOf.has(b.id)); // the column-grid backbone
  if (gridBuses.length < 2) return false;

  // ---- bus graph, BFS layers from the highest-generation bus ----
  const bAdj = new Map(gridBuses.map(b => [b.id, new Set()]));
  connectors.forEach(c => { bAdj.get(c.buses[0]).add(c.buses[1]); bAdj.get(c.buses[1]).add(c.buses[0]); });
  const genSize = new Map();
  locals.forEach(l => l.blocks.forEach(id => { const b = byId.get(id);
    if (['syncgen', 'src', 'gfm', 'pv'].includes(b.type)) {
      const s = b.params.Sbase || b.params.Pm0 || 1; genSize.set(l.bus, Math.max(genSize.get(l.bus) || 0, s)); } }));
  let root = gridBuses[0].id, best = -1;
  gridBuses.forEach(b => { const sc = (genSize.get(b.id) || 0) * 1e6 + bAdj.get(b.id).size; if (sc > best) { best = sc; root = b.id; } });
  const layer = new Map([[root, 0]]);
  { const q = [root]; while (q.length) { const x = q.shift();
    bAdj.get(x).forEach(n => { if (!layer.has(n)) { layer.set(n, layer.get(x) + 1); q.push(n); } }); } }
  gridBuses.forEach(b => { if (!layer.has(b.id)) layer.set(b.id, 0); }); // island buses

  // group by layer (column); order within each column by barycenter to cut crossings
  const layers = []; layer.forEach((L, id) => { (layers[L] || (layers[L] = [])).push(id); });
  const order = new Map(); layers.forEach(col => col.forEach((id, i) => order.set(id, i)));
  for (let s = 0; s < 8; s++) for (let Li = 0; Li < layers.length; Li++) {
    const col = layers[Li]; if (!col) continue;
    const bary = new Map();
    col.forEach(id => { const nb = [...bAdj.get(id)].filter(n => Math.abs(layer.get(n) - Li) === 1);
      const v = nb.map(n => order.get(n)); bary.set(id, v.length ? v.reduce((a, b) => a + b, 0) / v.length : order.get(id)); });
    col.sort((a, b) => bary.get(a) - bary.get(b)); col.forEach((id, i) => order.set(id, i));
  }

  // ---- per bus: assign each connection a side, pack onto taps, size the bar ----
  // Connectors point toward the neighbour bus's column (left = lower layer,
  // right = higher). Local branches go to the outer side. Each tap carries up to
  // two connections, one per side; a lone probe rides the free half of a tap.
  const busConns = new Map(buses.map(b => [b.id, []]));
  connectors.forEach(c => c.ends.forEach(end => {
    const other = c.buses.find(x => x !== end.bus);
    const side = (layer.get(other) < layer.get(end.bus)) ? 'L'
      : (layer.get(other) > layer.get(end.bus)) ? 'R'
      : (order.get(other) < order.get(end.bus) ? 'U' : 'D');
    busConns.get(end.bus).push({ kind: 'conn', c, end, side, isProbe: false });
  }));
  // a satellite bus keeps its winding on the right and takes its locals on the left
  satOf.forEach((s, busId) => s.ends.forEach(end =>
    busConns.get(busId).push({ kind: 'sat', end, side: 'R', isProbe: false })));
  locals.forEach(l => {
    const isProbe = l.blocks.length === 1 && byId.get(l.blocks[0]).type === 'probe';
    // Grow the local branch (generator, load, ...) into the LESS-crowded side of
    // its own bus, so it clusters right next to the interconnection instead of
    // being forced to one global edge (fixes generators/sources landing far from
    // their bus just because they sit on the leftmost layer — DECISIONS 2026-07-15).
    // Connectors were pushed first, so their sides are already known here.
    const existing = busConns.get(l.bus);
    const nL = existing.filter(c => c.side === 'L' || c.side === 'U').length;
    const nR = existing.filter(c => c.side === 'R' || c.side === 'D').length;
    const side = nL <= nR ? 'L' : 'R';
    busConns.get(l.bus).push({ kind: 'local', l, side, isProbe });
  });
  const busTapPlan = new Map();
  buses.forEach(b => {
    const conns = busConns.get(b.id), mains = conns.filter(c => !c.isProbe), probes = conns.filter(c => c.isProbe);
    const Ls = mains.filter(c => c.side === 'L' || c.side === 'U'), Rs = mains.filter(c => c.side === 'R' || c.side === 'D');
    const nT = Math.max(1, Ls.length, Rs.length), plan = [];
    for (let i = 0; i < nT; i++) plan.push({ L: Ls[i] || null, R: Rs[i] || null });
    probes.forEach(p => { let s = plan.find(t => !t.L); if (s) { s.L = p; p.side = 'L'; }
      else { s = plan.find(t => !t.R); if (s) { s.R = p; p.side = 'R'; } else { plan.push({ L: p, R: null }); p.side = 'L'; } } });
    busTapPlan.set(b.id, plan);
    b.params.taps = plan.length; b.params.len = 50 * plan.length; b.rot = 90; // 50 world units per tap
  });

  // ---- adaptive spacing: ROW from the tallest bus (tap span), COL from the
  // deepest local branch (graph depth, so parallel elements don't inflate it) ----
  let maxReach = 200, maxTaps = 1;
  locals.forEach(l => {
    const start = l.ends[0].blk, dist = new Map([[start, 0]]), q = [start];
    while (q.length) { const x = q.shift();
      adj.get(x).forEach(e => { if (busIds.has(e.nid)) return; if (!dist.has(e.nid)) { dist.set(e.nid, dist.get(x) + 1); q.push(e.nid); } }); }
    const md = [...dist.entries()].filter(([id]) => !['gnd', 'probe', 'fault'].includes(byId.get(id).type)).map(([, d]) => d);
    maxReach = Math.max(maxReach, GAP + 24 + ((md.length ? Math.max(...md) : 0) + 1) * 92);
  });
  gridBuses.forEach(b => maxTaps = Math.max(maxTaps, busTapPlan.get(b.id).length));
  const COL = Math.max(400, Math.round(maxReach) + 120), ROW = Math.max(240, maxTaps * 50 + 160);

  // ---- vertical coordinates: start on the row grid, then relax each bus toward
  // the mean of its neighbours in the adjacent columns, re-imposing the minimum
  // row separation (in the barycentric order fixed above) after every sweep.
  // Raw row indices top-align every column, which strands a one-bus column at
  // the top of a three-bus one and bends its connectors right back up.
  const ypos = new Map();
  gridBuses.forEach(b => ypos.set(b.id, order.get(b.id) * ROW));
  for (let s = 0; s < 12; s++) layers.forEach((col, Li) => {
    if (!col) return;
    col.forEach(id => {
      const nb = [...bAdj.get(id)].filter(n => Math.abs(layer.get(n) - Li) === 1);
      if (nb.length) ypos.set(id, 0.5 * ypos.get(id) + 0.5 * nb.reduce((a, n) => a + ypos.get(n), 0) / nb.length);
    });
    for (let i = 1; i < col.length; i++) ypos.set(col[i], Math.max(ypos.get(col[i]), ypos.get(col[i - 1]) + ROW));
    for (let i = col.length - 2; i >= 0; i--) ypos.set(col[i], Math.min(ypos.get(col[i]), ypos.get(col[i + 1]) - ROW));
  });
  const yMin = Math.min(...gridBuses.map(b => ypos.get(b.id)));

  // place grid buses by column/row (centre of the bar on the grid point)
  gridBuses.forEach(b => { const L = b.params.len, cx = 200 + layer.get(b.id) * COL, cy = 160 + ypos.get(b.id) - yMin;
    b.x = cx - L / 2; b.y = cy - 8; });
  const busTapPos = (b, i) => termPos(b, i);

  // ---- assign a tap index to every connection and rewrite its bus-side wire
  // (electrically identical: all taps on a bus are one node) ----
  const setWireEnd = (wi, blk, term) => { const w = S.wires[wi]; if (busIds.has(w.a[0])) w.a = [blk, term]; else w.b = [blk, term]; };
  buses.forEach(b => busTapPlan.get(b.id).forEach((slot, ti) => ['L', 'R'].forEach(sk => {
    const conn = slot[sk]; if (!conn) return; conn.tap = ti; conn.tapSide = sk;
    if (conn.kind === 'conn' || conn.kind === 'sat') setWireEnd(conn.end.wi, b.id, ti);
    else conn.l.ends.filter(e => e.bus === b.id).forEach(e => setWireEnd(e.wi, b.id, ti));
  })));

  // ---- connectors: drop each series element on the line between its two taps.
  // Measure every connector's axis first, because two decisions need it: a
  // symbol is turned to lie ALONG its own wire (a connector inside one column
  // runs vertically, and drawing it flat put the body across the wire it is
  // part of), and PARALLEL connectors are spread apart perpendicular to that
  // axis. Parallel connectors land on adjacent taps, one 50-unit tap pitch
  // apart, which is less than a transformer symbol is tall, so their bodies
  // overlapped. ----
  const cenX = gridBuses.reduce((a, b) => a + b.x + b.params.len / 2, 0) / gridBuses.length;
  const cenY = gridBuses.reduce((a, b) => a + b.y + 8, 0) / gridBuses.length;
  const geo = new Map();
  connectors.forEach(c => {
    const e0 = c.ends[0], e1 = c.ends.find(e => e.bus !== e0.bus);
    const c0 = busConns.get(e0.bus).find(x => x.kind === 'conn' && x.end === e0);
    const c1 = busConns.get(e1.bus).find(x => x.kind === 'conn' && x.end === e1);
    const p0 = busTapPos(byId.get(e0.bus), c0.tap), p1 = busTapPos(byId.get(e1.bus), c1.tap);
    const ax = p1[0] - p0[0], ay = p1[1] - p0[1], L = Math.hypot(ax, ay) || 1;
    geo.set(c.cid, { p0, p1, ux: ax / L, uy: ay / L, px: -ay / L, py: ax / L, shift: 0 });
  });
  const par = new Map();
  connectors.forEach(c => { const k = c.buses.slice().sort((a, b) => a - b).join(':');
    (par.get(k) || par.set(k, []).get(k)).push(c); });
  par.forEach(gr => {
    if (gr.length < 2) return;
    const g0 = geo.get(gr[0].cid);
    // perpendicular coordinate of each body, and the widest body measured across
    // that same perpendicular (bounding-box support, so a diagonal axis is honest)
    const q = c => { const g = geo.get(c.cid);
      return (g.p0[0] + g.p1[0]) / 2 * g0.px + (g.p0[1] + g.p1[1]) / 2 * g0.py; };
    const ext = c => Math.max(...compBlocks.get(c.cid).map(id => { const d = getDims(byId.get(id));
      return Math.abs(g0.px) * d.w + Math.abs(g0.py) * d.h; }));
    const sorted = gr.slice().sort((a, b) => q(a) - q(b)), qs = sorted.map(q);
    const pitch = Math.max(...gr.map(ext)) + 16, qbar = qs.reduce((a, b) => a + b, 0) / qs.length;
    sorted.forEach((c, k) => geo.get(c.cid).shift = qbar + (k - (sorted.length - 1) / 2) * pitch - qs[k]);
  });
  const bodies = [];
  connectors.forEach(c => {
    const blocks = compBlocks.get(c.cid), g = geo.get(c.cid);
    const sx = g.px * g.shift, sy = g.py * g.shift, vert = Math.abs(g.uy) > Math.abs(g.ux);
    const span = Math.hypot(g.p1[0] - g.p0[0], g.p1[1] - g.p0[1]);
    const mid = t => [g.p0[0] + (g.p1[0] - g.p0[0]) * t + sx, g.p0[1] + (g.p1[1] - g.p0[1]) * t + sy];
    blocks.forEach((id, i) => { const blk = byId.get(id), d = getDims(blk), m = mid((i + 1) / (blocks.length + 1));
      blk.rot = vert ? 90 : 0; blk.x = m[0] - d.w / 2; blk.y = m[1] - d.h / 2;
      bodies.push({ blk, ux: g.ux, uy: g.uy, px: g.px, py: g.py, span }); });
    // satellite buses (a three-winding transformer's tertiary) sit beside the
    // body, perpendicular to the axis: on the side the parallel spread already
    // pushed this connector toward, or failing that away from the bus centroid
    (c.sats || []).forEach((sid, si) => {
      const sb = byId.get(sid), d = getDims(sb), m = mid(0.5);
      let dx = g.px, dy = g.py;
      const away = Math.abs(g.shift) > 1 ? g.shift : dx * (m[0] - cenX) + dy * (m[1] - cenY);
      if (away < 0) { dx = -dx; dy = -dy; }
      const off = GAP + 40 + (Math.abs(dx) * DEFS.bus.h + Math.abs(dy) * d.w) / 2 + si * 140;
      sb.rot = 90; sb.x = m[0] + dx * off - d.w / 2; sb.y = m[1] + dy * off - DEFS.bus.h / 2;
    });
  });

  placeBusLocals({ byId, busIds, adj, busConns, busTapPos, GAP, locals });
  orientBlocks();
  declutterConnectors(bodies);
  declutterProbes();
  fitView(); showProps();
  return true;
}

// Cosmetic orientation pass: a multi-terminal block (line, xfmr, breaker, load,
// three-winding transformer, etc.) can end up "backwards" — the terminal wired
// to a neighbour sits on the FAR side of the block from that neighbour, so the
// symbol lies on top of its own wire. Rotating it 180° swaps which terminal
// faces which side without changing anything electrical. For each such block we
// compare total wired-terminal length at its current angle vs. flipped, and keep
// whichever is shorter (the connection side ends up closest to what it connects
// to — the rule from DECISIONS.md). Only b.rot changes; positions and wires are
// intact. 1-terminal blocks (gnd, probe) are skipped: a flip cannot shorten a
// single lead, and their angle is set deliberately by the placement pass.
function orientBlocks() {
  const byId = new Map(S.blocks.map(b => [b.id, b]));
  const links = new Map();
  S.wires.forEach(w => {
    const a = byId.get(w.a[0]), b = byId.get(w.b[0]); if (!a || !b) return;
    (links.get(a.id) || links.set(a.id, []).get(a.id)).push({ selfT: w.a[1], to: [b.id, w.b[1]] });
    (links.get(b.id) || links.set(b.id, []).get(b.id)).push({ selfT: w.b[1], to: [a.id, w.a[1]] });
  });
  S.blocks.forEach(blk => {
    if (blk.type === 'bus') return;
    if (getTerms(blk).length < 2) return;
    const ls = links.get(blk.id); if (!ls || !ls.length) return;
    const wiredLen = () => ls.reduce((s, l) => {
      const tp = termPos(blk, l.selfT), other = byId.get(l.to[0]);
      if (!other) return s;
      const op = termPos(other, l.to[1]);
      return s + Math.hypot(tp[0] - op[0], tp[1] - op[1]);
    }, 0);
    const d0 = wiredLen(), save = blk.rot || 0;
    blk.rot = (save + 180) % 360;
    if (wiredLen() + 1e-6 >= d0) blk.rot = save; // flip didn't help — revert
  });
}

// Place a bus's local branches. Each branch extends horizontally away from the
// bus on its assigned side; blocks are ordered by graph depth from the bus, so
// parallel elements (e.g. two breakers between the same nodes) share a depth and
// stack vertically instead of overlapping. Two-terminal blocks rotate so their
// bus-side terminal faces the bar; grounds sit just outward of their parent; a
// lone probe seats right at its tap.
function placeBusLocals(ctx) {
  const { byId, busIds, adj, busConns, busTapPos, GAP, locals } = ctx;
  const isSat = id => ['gnd', 'probe', 'fault'].includes(byId.get(id).type);
  locals.forEach(cinfo => {
    const b = byId.get(cinfo.bus);
    const conn = busConns.get(cinfo.bus).find(x => x.kind === 'local' && x.l === cinfo);
    const tap = busTapPos(b, conn.tap || 0), dir = (conn.tapSide === 'R') ? 1 : -1;
    if (conn.isProbe) { // lone probe: seat at its tap on the assigned side
      const p = byId.get(cinfo.blocks[0]); p.rot = 0; p.x = tap[0] + dir * GAP - 26; p.y = tap[1] - 36; return;
    }
    const startBlk = cinfo.ends[0].blk, dist = new Map([[startBlk, 0]]), q = [startBlk];
    while (q.length) { const x = q.shift();
      adj.get(x).forEach(e => { if (busIds.has(e.nid)) return; if (!dist.has(e.nid)) { dist.set(e.nid, dist.get(x) + 1); q.push(e.nid); } }); }
    const byDist = new Map();
    [...dist.keys()].filter(id => !isSat(id)).forEach(id => { const dd = dist.get(id); (byDist.get(dd) || byDist.set(dd, []).get(dd)).push(id); });
    let cx = tap[0] + dir * (GAP + 24);
    [...byDist.keys()].sort((a, b) => a - b).forEach(dd => {
      const group = byDist.get(dd), gw = Math.max(...group.map(id => getDims(byId.get(id)).w));
      group.forEach((id, gi) => { const blk = byId.get(id), d = getDims(blk);
        blk.rot = (dir > 0) ? 180 : 0; blk.x = cx - d.w / 2; blk.y = tap[1] - d.h / 2 + (gi - (group.length - 1) / 2) * 72; });
      cx += dir * (gw / 2 + 64);
    });
    [...dist.keys()].filter(isSat).forEach(id => { const blk = byId.get(id);
      const pe = adj.get(id).find(e => !busIds.has(e.nid)), parent = pe ? byId.get(pe.nid) : b;
      const [pcx, pcy] = blockCenter(parent), pd = getDims(parent), d = getDims(blk);
      if (blk.type === 'gnd') { blk.rot = (dir > 0) ? 270 : 90; blk.x = pcx + dir * (pd.w / 2 + GAP) - d.w / 2; blk.y = pcy - d.h / 2; }
      else { blk.rot = 0; blk.x = pcx - d.w / 2; blk.y = pcy - pd.h / 2 - GAP - d.h; } // probe above its parent
    });
  });
}

// A block's rotated screen box, and whether two of them overlap by more than a
// hairline. Shared by the two overlap-repair passes below.
function blockBox(b) {
  const d = getDims(b), rot = ((b.rot || 0) % 180) !== 0, w = rot ? d.h : d.w, h = rot ? d.w : d.h, [cx, cy] = blockCenter(b);
  return { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 };
}
function boxHit(a, c) {
  return Math.min(a.x1, c.x1) - Math.max(a.x0, c.x0) > 4 && Math.min(a.y1, c.y1) - Math.max(a.y0, c.y0) > 4;
}

// Overlap repair for connector bodies. A connector is dropped on the straight
// line between the two taps it bridges, and in a meshed network that line can
// run right over an intermediate bus or a generator hanging off one. Slide the
// body ALONG its own wire first — it stays on the line, so nothing reads as
// disconnected — and only then perpendicular, taking the cheapest clear spot.
// The along-axis travel is capped so a body cannot slide out from under its own
// span and end up sitting on a different bus instead.
// bodies: [{ blk, ux, uy, px, py, span }] from the connector placement pass.
function declutterConnectors(bodies) {
  bodies.forEach(({ blk, ux, uy, px, py, span }) => {
    const others = S.blocks.filter(b => b.id !== blk.id);
    const x0 = blk.x, y0 = blk.y;
    const clear = (dx, dy) => { blk.x = x0 + dx; blk.y = y0 + dy; const box = blockBox(blk);
      const ok = !others.some(o => boxHit(box, blockBox(o))); blk.x = x0; blk.y = y0; return ok; };
    if (clear(0, 0)) return;
    const maxAlong = span * 0.3;
    let best = null, bestCost = Infinity;
    for (let r = 24; r <= 192; r += 24) for (const sg of [1, -1])
      for (const [vx, vy, w, lim] of [[ux, uy, 1, maxAlong], [px, py, 1.4, Infinity]]) {
        if (r > lim) continue;
        const dx = sg * r * vx, dy = sg * r * vy;
        if (!clear(dx, dy)) continue;
        const cost = r * w; if (cost < bestCost) { bestCost = cost; best = [dx, dy]; }
      }
    if (best) { blk.x = x0 + best[0]; blk.y = y0 + best[1]; }
  });
}

// Final overlap repair for probes (the flexible measurement points): if a probe
// still overlaps a block after placement, slide it to the nearest clear spot.
function declutterProbes() {
  const rbox = blockBox, hit = boxHit;
  S.blocks.filter(b => b.type === 'probe').forEach(p => {
    const others = S.blocks.filter(b => b.id !== p.id && b.type !== 'bus');
    const overlaps = pos => { const sx = p.x, sy = p.y; p.x = pos.x; p.y = pos.y; const box = rbox(p);
      const bad = others.some(o => hit(box, rbox(o))); p.x = sx; p.y = sy; return bad; };
    if (!overlaps({ x: p.x, y: p.y })) return;
    const x0 = p.x, y0 = p.y; let bestPos = null, bestCost = Infinity;
    for (let r = 20; r <= 140 && !bestPos; r += 20)
      for (const [dx, dy] of [[0, r], [0, -r], [r, 0], [-r, 0], [r, r], [-r, r], [r, -r], [-r, -r]]) {
        if (overlaps({ x: x0 + dx, y: y0 + dy })) continue;
        const cost = Math.hypot(dx, dy); if (cost < bestCost) { bestCost = cost; bestPos = { x: x0 + dx, y: y0 + dy }; }
      }
    if (bestPos) { p.x = bestPos.x; p.y = bestPos.y; }
  });
}

// Tidy-tree layout. The tree is a BFS spanning tree rooted at the grid
// source(s) — direction comes from traversal order (always correct), NOT from
// wire a/b order (which is just whichever terminal the user clicked first; a
// previous version derived parent/child from it and produced garbage trees).
// Placement is the classic tidy-tree rule: depth sets the main-axis coordinate
// (x for left-to-right, y for top-to-bottom); each leaf takes the next free
// slot on the cross axis; each parent centers on its children. Guarantees no
// overlaps and reads as a pyramid branching away from the source.
function doHierarchicalLayout(direction) {
  if (S.blocks.length === 0) return;
  pushHistory();
  // Meshed power networks (3+ interconnected buses) use a dedicated bus-aware
  // layout: the tidy-tree below is built on a spanning tree and cannot draw the
  // loops a transmission network contains, so it scatters every loop-closing
  // line across the figure. busAwareLayout() lays the BUSES out as the backbone
  // and hangs each bus's local branches off its taps. Radial / converter
  // circuits (<3 buses, or buses not interconnected) fall through to the tree.
  //
  // ...but ONLY when the requested direction is one it can actually produce.
  // busAwareLayout() has no direction of its own: it always advances its BFS
  // columns rightward with vertical bus bars, i.e. it is inherently
  // left-to-right. Taking it unconditionally therefore swallowed the user's
  // choice on every circuit with 3+ buses — which is every transmission case —
  // so "Top to Bottom" silently produced the same left-to-right figure as the
  // other two options and the direction picker looked broken. 'lr' and 'fit'
  // still get it (it IS left-to-right, and for 'fit' choosing the best shape is
  // the request); 'tb' falls through to the tidy-tree, which honours it.
  // Teaching busAwareLayout to transpose for 'tb' is the real fix and is
  // tracked in IDEAS.md; this restores the control's meaning meanwhile.
  if (direction !== 'tb' && S.blocks.filter(b => b.type === 'bus').length >= 3) {
    try { if (busAwareLayout()) return; }
    catch (e) { console.warn('bus-aware layout failed; using tidy-tree', e); }
  }
  let isLR = direction !== 'tb'; // 'fit' decides for real below, once the tree is measured
  const sourceTypes = new Set(['src', 'gfm', 'pv', 'syncgen', 'gfl']); // generation roots; batt/pfc/dcdc are mid-tree
  const leafBias = { gnd: 2, probe: 1, fault: 1 }; // push meters/grounds to a branch's outer edge
  // Two-terminal "through" blocks rotate 90° in top-to-bottom layout so their
  // lead line runs WITH the vertical flow instead of sitting sideways across
  // it (the cosmetic complaint this fixed — see SPEC §3). Bus stays a
  // horizontal bar by convention; gnd/probe/fault already point the right way
  // in either direction (single terminal, inherently vertical symbol) so they
  // never need forced rotation.
  const rotateTypes = new Set(['src', 'line', 'tline', 'fdline', 'cap', 'rlc', 'rlcp', 'xfmr', 'xfmr3', 'xfmr3w', 'brk', 'relay', 'gfm', 'syncgen', 'im', 'wt4', 'hvdc', 'gfl', 'svc', 'pfc', 'batt', 'cpl', 'dcdc', 'pv', 'pq', 'zip', 'scale']);

  const blocksById = new Map(S.blocks.map(b => [b.id, b]));
  const adj = new Map(S.blocks.map(b => [b.id, new Set()]));
  S.wires.forEach(w => {
    if (!adj.has(w.a[0]) || !adj.has(w.b[0])) return;
    adj.get(w.a[0]).add(w.b[0]);
    adj.get(w.b[0]).add(w.a[0]);
  });

  // Roots: grid sources first; anything still unreached later starts its own tree
  // (covers source-less fragments and island circuits).
  const roots = S.blocks.filter(b => sourceTypes.has(b.type));
  const children = new Map(S.blocks.map(b => [b.id, []]));
  const visited = new Set();
  const bfs = rootId => {
    visited.add(rootId);
    const q = [rootId];
    while (q.length) {
      const bid = q.shift();
      adj.get(bid).forEach(nid => {
        if (visited.has(nid)) return;
        visited.add(nid);
        children.get(bid).push(nid);
        q.push(nid);
      });
    }
  };
  roots.forEach(r => bfs(r.id));
  S.blocks.forEach(b => { if (!visited.has(b.id)) { roots.push(b); bfs(b.id); } });

  // Within each node, order children: real subtrees (biggest first, so the main
  // feeder runs along one edge) before probe/fault taps, grounds last.
  const subSize = new Map();
  const sizeOf = bid => {
    let n = 1;
    children.get(bid).forEach(k => { n += sizeOf(k); });
    subSize.set(bid, n);
    return n;
  };
  roots.forEach(r => sizeOf(r.id));
  children.forEach(kids => kids.sort((a, b) =>
    (leafBias[blocksById.get(a).type] || 0) - (leafBias[blocksById.get(b).type] || 0)
    || subSize.get(b) - subSize.get(a)));

  // Single-terminal taps (gnd/probe/fault) that are tree LEAVES are not laid
  // out as tree nodes at the next depth level — that's what shoved a source's
  // ground a full step PAST the source. They're pulled out here and placed as
  // satellites beside the terminal they attach to (post-pass below), rotated
  // to face it — the presentation convention from DECISIONS.md 2026-07-14.
  // A gnd/probe with tree children (it bridges subtrees) stays a tree node.
  const satellite = new Set();
  S.blocks.forEach(b => {
    if (!['gnd', 'probe', 'fault'].includes(b.type)) return;
    if (children.get(b.id).length) return;                       // structural — keep in tree
    if (S.wires.some(w => w.a[0] === b.id || w.b[0] === b.id)) satellite.add(b.id);
  });

  // Tidy placement: cross = slot for leaves / mean of children for parents.
  // Rotating TB's through-blocks 90° makes their on-screen footprint the same
  // shape as LR's (just transposed), so one pair of constants covers both
  // directions — no separate TB tuning needed.
  const mainStep = 190; // between depth levels
  const crossStep = 95; // between sibling slots
  const cross = new Map();
  let nextSlot = 0;
  const place = bid => {
    const kids = children.get(bid).filter(k => !satellite.has(k)); // satellites take no slot
    if (!kids.length) { cross.set(bid, nextSlot++); return; }
    kids.forEach(place);
    cross.set(bid, kids.reduce((s, k) => s + cross.get(k), 0) / kids.length);
  };
  const depth = new Map();
  const setDepth = (bid, d) => { depth.set(bid, d); children.get(bid).forEach(k => setDepth(k, d + 1)); };
  roots.forEach(r => { place(r.id); setDepth(r.id, 0); nextSlot++; }); // blank slot between trees

  // 'fit': the tree's depth/slot extents are direction-independent (TB is LR
  // transposed, footprints included, per the rotation note above) — so predict
  // both bounding boxes and keep whichever orientation fitView() can show
  // LARGER (smaller fitted view width = more zoomed in). Ties go to LR.
  if (direction === 'fit') {
    const mainExt = Math.max(...S.blocks.map(b => depth.get(b.id))) * mainStep + 200;
    const crossExt = Math.max(1, nextSlot - 1) * crossStep + 100;
    const asp = viewAspect(); // h/w of the live canvas element
    const fitted = (bw, bh) => Math.max(bw, bh / asp); // view width fitView() would pick
    isLR = fitted(mainExt, crossExt) <= fitted(crossExt, mainExt);
  }

  S.blocks.forEach(b => {
    if (satellite.has(b.id)) return; // placed in the post-pass below
    const d = getDims(b); // center each block on its grid point (blocks vary in size)
    const main = 60 + depth.get(b.id) * mainStep, cr = 60 + cross.get(b.id) * crossStep;
    if (isLR) { b.x = main; b.y = cr - d.h / 2; }
    else { b.x = cr - d.w / 2; b.y = main; }
    if (rotateTypes.has(b.type)) b.rot = isLR ? 0 : 90;
  });

  // Satellite post-pass. Orientation comes from the ATTACHED terminal's actual
  // post-layout geometry (offset from its block's center), not from isLR — so
  // one rule covers LR, TB, and rotated parents: a gnd on a source's return
  // terminal lands OUTWARD of it on the same axis, terminal facing back;
  // probes sit perpendicular to the run; faults hang off the far side.
  const GAP = 28; // wire stub length between parent terminal and satellite terminal
  satellite.forEach(sid => {
    const b = blocksById.get(sid);
    const w = S.wires.find(w => w.a[0] === sid || w.b[0] === sid);
    const [pid, pti] = w.a[0] === sid ? w.b : w.a;
    const parent = blocksById.get(pid);
    const [px, py] = termPos(parent, pti);
    const [pcx, pcy] = blockCenter(parent);
    const dx = px - pcx, dy = py - pcy;
    const horiz = Math.abs(dx) >= Math.abs(dy); // terminal sticks out horizontally?
    if (b.type === 'gnd') { // outward, same axis as the terminal, facing back
      if (horiz && dx < 0) { b.rot = 90; b.x = px - GAP - 40; b.y = py - 18; }        // left,  term at (x+40,y+18)
      else if (horiz) { b.rot = 270; b.x = px + GAP - 4; b.y = py - 18; }             // right, term at (x+4,y+18)
      else if (dy < 0) { b.rot = 180; b.x = px - 22; b.y = py - GAP - 36; }           // above, term at (x+22,y+36)
      else { b.rot = 0; b.x = px - 22; b.y = py + GAP; }                              // below, term at (x+22,y)
    } else if (b.type === 'probe') { // perpendicular to the run, beside its node
      if (horiz) { b.rot = 0; b.x = px - 26; b.y = py - GAP - 36; }                   // above, term at (x+26,y+36)
      else { b.rot = 90; b.x = px + GAP - 8; b.y = py - 18; }                         // right, term at (x+8,y+18)
    } else { // fault: opposite side of the run, terminal toward the wire
      if (horiz) { b.rot = 0; b.x = px - 30; b.y = py + GAP; }                        // below, term at (x+30,y)
      else { b.rot = 270; b.x = px + GAP - 8; b.y = py - 22; }                        // right, term at (x+8,y+22)
    }
  });

  fitView();
  showProps();
}
// Zoom/pan the camera to show every block (a laid-out tree usually exceeds the
// default 680x340 window). Keeps the locked aspect ratio; only widens, never
// zooms in past the default (a small circuit stays at normal size).
function fitView() {
  if (!S.blocks.length) { resetView(); return; }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  S.blocks.forEach(b => {
    const d = getDims(b);
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + d.w); y1 = Math.max(y1, b.y + d.h);
  });
  const pad = 40, bw = x1 - x0 + 2 * pad, bh = y1 - y0 + 2 * pad;
  const asp = viewAspect();
  const w = Math.min(maxViewW(), Math.max(VIEW0.w, bw, bh / asp));
  const h = w * asp;
  view.w = w; view.h = h;
  view.x = (x0 + x1) / 2 - w / 2;
  view.y = (y0 + y1) / 2 - h / 2;
  render();
}
// remove any explicit plot signals (keys "v:<id>:ph" / "i:<id>:ph") for a block
function pruneBlockSignals(id) {
  if (!S.plots) return;
  S.plots.forEach(pl => { if (!pl.auto) pl.sigs = pl.sigs.filter(s => s.key.split(':')[1] !== String(id)); });
}
function clearAll() {
  pushHistory(); touchModel(); resetRunState(); findReset(); // an empty canvas has no results and nothing to find
  S.blocks = []; S.wires = []; S.sel = []; S.wireFrom = null; selWire = null;
  S.vconv = 'll'; // a fresh blank circuit defaults to line-to-line entry (SPEC §2); loaded files keep their own convention
  S.plots.forEach(pl => { if (!pl.auto) pl.sigs = []; });
  setProj('Untitled', false); // fresh canvas — nothing worth marking dirty yet
  syncVconvUI(); render(); showProps();
}
// Voltage convention (SPEC §2): 'ph' = params are phase RMS (legacy), 'll' =
// line-to-line RMS. The solver divides an LL value by sqrt(3) at the boundary
// in 3-ph (1-ph is untouched: line = phase). Toggling CONVERTS already-entered
// convention-aware values (x sqrt(3) PH->LL, / sqrt(3) LL->PH) so the physical
// voltage is preserved, not reinterpreted, which means mid-build convention
// switches stay consistent. Undoable (snapshot carries vconv). Absent vconv
// reads as 'ph', which is why every legacy file and the loadDemo circuit stay
// phase.
function setVconv(v) {
  const newConv = (v === 'll') ? 'll' : 'ph';
  if (newConv === S.vconv) { syncVconvUI(); return; } // no-op: nothing to rescale
  pushHistory(); // snapshot the pre-toggle values + vconv so undo reverts both
  const factor = (newConv === 'll') ? SQRT3 : 1 / SQRT3;
  S.blocks.forEach(b => scaleVconvParams(b, factor));
  S.vconv = newConv;
  syncVconvUI(); render(); showProps();
}
function syncVconvUI() {
  const el = document.getElementById('vconv');
  if (el) el.value = (S.vconv === 'll') ? 'll' : 'ph';
}
// "Wide" toggles a fluid class on .emt so the app fills the available screen
// width instead of capping at the default max-width. Useful on wide monitors
// with the 3-pane layout (params | canvas | science). Persisted in
// localStorage so the choice sticks across sessions.
function syncWideUI() {
  const emt = document.querySelector('.emt');
  const btn = document.getElementById('widebtn');
  const on = localStorage.getItem('emt_wide') === '1';
  if (emt) emt.classList.toggle('fluid', on);
  if (btn) btn.classList.toggle('on', on);
}
function toggleWide() {
  const on = localStorage.getItem('emt_wide') !== '1';
  localStorage.setItem('emt_wide', on ? '1' : '0');
  syncWideUI();
}
// Library (left component sidebar) toggle. Same pattern as Wide: a class on
// .emt (.lib) shows the #library drawer, an .on state on the toolbar button,
// and the choice persists in localStorage. ON by default since July 2026: with
// the toolbar's category flyout removed, the drawer is the only way to add a
// block, so a first visit must open with it showing. See buildLibrary().
function syncLibraryUI() {
  const emt = document.querySelector('.emt');
  const btn = document.getElementById('libbtn');
  const on = localStorage.getItem('emt_lib') !== '0';
  if (emt) emt.classList.toggle('lib', on);
  if (btn) btn.classList.toggle('on', on);
}
function toggleLibrary() {
  const on = localStorage.getItem('emt_lib') === '0'; // flip
  localStorage.setItem('emt_lib', on ? '1' : '0');
  syncLibraryUI();
}
// Per-rail show/hide (View toggles). Same pattern as Wide/Library: a class on
// .emt (.hideparam / .hidesci) suppresses the params / science rail even when
// a block is selected, an .on state on the toolbar button reflects visibility,
// and the choice persists in localStorage. Both default to shown (on), so the
// rails behave as before until the user turns one off (useful on small screens
// where the rails crowd the canvas while navigating and rearranging). The
// classes only affect display when a selection is active (.sel/.msel); with
// nothing selected both rails are already hidden.
function syncParamsUI() {
  const emt = document.querySelector('.emt');
  const btn = document.getElementById('parambtn');
  const on = localStorage.getItem('emt_params') !== '0'; // default shown
  if (emt) emt.classList.toggle('hideparam', !on);
  if (btn) btn.classList.toggle('on', on);
}
function toggleParams() {
  const on = localStorage.getItem('emt_params') === '0'; // flip
  localStorage.setItem('emt_params', on ? '1' : '0');
  syncParamsUI();
}
function syncScienceUI() {
  const emt = document.querySelector('.emt');
  const btn = document.getElementById('scibtn');
  const on = localStorage.getItem('emt_sci') !== '0'; // default shown
  if (emt) emt.classList.toggle('hidesci', !on);
  if (btn) btn.classList.toggle('on', on);
}
function toggleScience() {
  const on = localStorage.getItem('emt_sci') === '0'; // flip
  localStorage.setItem('emt_sci', on ? '1' : '0');
  syncScienceUI();
}
// The description paragraph under the title. Shown by DEFAULT (absent key), not
// hidden: it is the only thing on the page that says what OpenEMT is and that
// results are not certified, so a first-time visitor must get it. Once
// dismissed the choice sticks, which is what buys back the 44px of height that
// pushed the plots below the fold for the people who already know.
// Note the polarity is the inverse of the rail toggles above: those persist "1"
// for shown, this persists "1" for HIDDEN, because the default differs.
function syncAboutUI() {
  const el = document.getElementById('about');
  const btn = document.getElementById('infobtn');
  const hidden = localStorage.getItem('emt_about') === '1';
  if (el) el.hidden = hidden;
  if (btn) btn.classList.toggle('on', !hidden);
}
function toggleAbout() {
  const hidden = localStorage.getItem('emt_about') !== '1'; // flip
  localStorage.setItem('emt_about', hidden ? '1' : '0');
  syncAboutUI();
  syncCanvasHeight(); // the row appearing/disappearing moves the canvas top
  onCanvasResize(); // ...and therefore changes its aspect
}
// "More" reveals the collapsed toolbar clusters on narrow screens. Not
// persisted: unlike the rail toggles this is a peek at controls you are about
// to use once, not a layout preference, and leaving it latched would put the
// phone back to the five-row toolbar it exists to avoid.
function toggleMore() {
  const emt = document.querySelector('.emt');
  const btn = document.getElementById('morebtn');
  if (!emt) return;
  const on = !emt.classList.contains('more');
  emt.classList.toggle('more', on);
  if (btn) btn.classList.toggle('on', on);
  syncCanvasHeight(); onCanvasResize(); // the toolbar grew or shrank
}
// The sticky Run mirrors whichever action is live: Run normally, Stop while a
// run is in flight, so a long run can be cancelled from the plots without
// scrolling back to the toolbar.
let fabRunning = false;
function fabAction() { if (fabRunning) stopSim(); else runEMTLive(); }
function syncFab(running) {
  fabRunning = !!running;
  const f = document.getElementById('fabrun');
  if (!f) return;
  f.classList.toggle('stop', fabRunning);
  f.textContent = fabRunning ? '■ Stop' : '▶ Run';
  f.title = fabRunning ? 'Stop the running simulation' : 'Run the simulation';
}
// Show it only once the real Run button has scrolled out of view. An
// IntersectionObserver rather than a scroll handler: this has to be correct
// while the page is also being scrolled by revealPlots(), and a scroll listener
// firing during a smooth scroll is exactly where that gets fiddly.
function bindFab() {
  const btn = document.getElementById('runbtn');
  const emt = document.querySelector('.emt');
  if (!btn || !emt || typeof IntersectionObserver === 'undefined') return;
  new IntersectionObserver(es => {
    emt.classList.toggle('fab', !es[0].isIntersecting);
  }, { threshold: 0 }).observe(btn);
}
// Numerics popover (time step, plot step, flow arrows), anchored under its gear
// button. Not persisted: it is a transient panel, not a layout preference.
function toggleSimAdv(ev) {
  const pop = document.getElementById('simadv');
  const btn = document.getElementById('simadvbtn');
  if (!pop || !btn) return;
  const open = pop.style.display === 'none';
  pop.style.display = open ? 'flex' : 'none';
  btn.classList.toggle('on', open);
  if (open) {
    // Position relative to .emt, which is the nearest positioned ancestor.
    const host = document.querySelector('.emt').getBoundingClientRect();
    const b = btn.getBoundingClientRect();
    pop.style.top = (b.bottom - host.top + 6) + 'px';
    // Keep it on screen when the gear sits near the right edge.
    pop.style.left = Math.max(0, Math.min(b.left - host.left, host.width - 240)) + 'px';
  }
  if (ev) ev.stopPropagation();
}
function closeSimAdv() {
  const pop = document.getElementById('simadv');
  const btn = document.getElementById('simadvbtn');
  if (pop && pop.style.display !== 'none') { pop.style.display = 'none'; if (btn) btn.classList.remove('on'); }
}
// Dismiss on an outside click or Escape, the two things every popover must do.
document.addEventListener('mousedown', e => {
  const pop = document.getElementById('simadv');
  if (!pop || pop.style.display === 'none') return;
  if (pop.contains(e.target) || e.target.closest('#simadvbtn')) return;
  closeSimAdv();
});

// ---- save / load ----
// Run settings travel WITH the circuit. Without this a case whose first event
// is seconds in looks like a dead flat line on load: the Duration field keeps
// whatever was in it (120 ms by default), the run ends long before anything
// happens, and nothing tells you why. A circuit that needs a 14 s window at
// dt = 100 us is not fully described by its blocks and wires.
function simSettings() {
  const num = (id, dflt) => {
    const v = +(document.getElementById(id) || {}).value;
    return Number.isFinite(v) && v > 0 ? v : dflt;
  };
  return {
    duration: num('duration', 120), dtUs: num('dtus', 50),
    plotUs: +(document.getElementById('plotus') || {}).value || 0,
    nph: +(document.getElementById('phmode') || {}).value || 3,
    pfinit: !!(document.getElementById('pfinit') || {}).checked
  };
}
function applySimSettings(s) {
  if (!s || typeof s !== 'object') return;
  const set = (id, v) => {
    const el = document.getElementById(id);
    if (!el || !Number.isFinite(+v) || +v <= 0) return;
    // Respect the input's own max, or the browser marks the field invalid and
    // the run silently uses a clamped value the user never chose.
    const mx = +el.max;
    el.value = Number.isFinite(mx) && mx > 0 ? Math.min(+v, mx) : +v;
  };
  set('duration', s.duration); set('dtus', s.dtUs);
  if (Number.isFinite(+s.plotUs) && +s.plotUs > 0) set('plotus', s.plotUs);
  const ph = document.getElementById('phmode');
  if (ph && (+s.nph === 1 || +s.nph === 3)) ph.value = String(+s.nph);
  const pf = document.getElementById('pfinit');
  if (pf && typeof s.pfinit === 'boolean') pf.checked = s.pfinit;
}

function saveCircuit() {
  const data = JSON.stringify({ webemt: 1, vconv: S.vconv, sim: simSettings(), blocks: S.blocks, wires: S.wires, plots: S.plots }, null, 1);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  const fname = (projName || 'circuit').replace(/\.json$/i, '') + '.json';
  a.download = fname;
  a.click();
  URL.revokeObjectURL(a.href);
  setProj(fname, false); // saved: the badge now names the downloaded file, dot cleared
}
// Validate a parsed circuit object and commit it as the live circuit, or reject
// it without touching the current circuit. Shared by Load (JSON files) and Import
// (converted external cases) so there is a single loader. Returns { ok:true } or
// { err } with a user-facing message; the caller owns the #stat line.
function applyCircuit(d, name) {
  if (!d || d.webemt !== 1 || !Array.isArray(d.blocks) || !Array.isArray(d.wires)) {
    return { err: 'not an OpenEMT circuit file.' };
  }
  const bad = d.blocks.find(b => !DEFS[b.type]);
  if (bad) return { err: 'unknown block type "' + bad.type + '".' };
  // backfill params added since the file was saved (e.g. line Rm/Lm, fault ph)
  d.blocks.forEach(b => {
    const defaults = Object.fromEntries(Object.entries(DEFS[b.type].params).map(([k, p]) => [k, p.v]));
    b.params = { ...defaults, ...b.params };
    if (typeof b.rot !== 'number') b.rot = 0;
  });
  pushHistory(); // an accidental Load/Import shouldn't be unrecoverable
  touchModel(); resetRunState(); // the previous circuit's results are not this circuit's
  findReset();                   // a query aimed at the circuit being replaced
  S.blocks = d.blocks; S.wires = d.wires;
  S.sel = []; S.wireFrom = null; selWire = null;
  S.vconv = d.vconv === 'll' ? 'll' : 'ph'; // absent => 'ph' (legacy files stay phase)
  applySimSettings(d.sim);                  // absent => leave the toolbar alone
  S.nextId = d.blocks.reduce((m, b) => Math.max(m, b.id), 0) + 1;
  // restore saved plots (backfill defaults for pre-plots files). `h` is the
  // card height in px, absent on any file saved before plots became resizable
  // — plotHeight() falls back to PLOT_H0 for it.
  S.plots = Array.isArray(d.plots) && d.plots.length
    ? d.plots.map(pl => ({ id: pl.id, title: pl.title || 'Plot', auto: pl.auto || null, sigs: Array.isArray(pl.sigs) ? pl.sigs : [], h: +pl.h || undefined }))
    : null;
  yZoom = {}; // view state of the plots being replaced
  initPlots();
  // A saved plot can name signals on blocks this circuit does not contain (its
  // plot list was configured against an earlier version of the model, or was
  // carried over by hand). Such a key resolves to nothing, so the plot looks
  // configured but stays permanently blank with nothing saying why. Drop them
  // at load and report the count, keyed by block id exactly like
  // pruneBlockSignals. Auto plots expand from the live registry and have no
  // stored keys to prune.
  const haveIds = new Set(S.blocks.map(b => b.id));
  let dropped = 0;
  S.plots.forEach(pl => {
    if (pl.auto) return;
    const kept = pl.sigs.filter(s => haveIds.has(+String(s.key).split(':')[1]));
    dropped += pl.sigs.length - kept.length;
    pl.sigs = kept;
  });
  nextPlotId = S.plots.reduce((m, p) => Math.max(m, p.id), 0) + 1;
  setProj(name, false);
  syncVconvUI(); render(); showProps(); renderPlots();
  return { ok: true, dropped };
}

function loadCircuit(file) {
  const rd = new FileReader();
  rd.onload = () => {
    const stat = document.getElementById('stat');
    let d;
    try { d = JSON.parse(rd.result); } catch { showError('Load failed: that file is not valid JSON.'); return; }
    const res = applyCircuit(d, file.name);
    if (res.err) { showError('Load failed: ' + res.err); return; }
    stat.textContent = 'Loaded ' + file.name + ': ' + S.blocks.length + ' blocks, ' + S.wires.length + ' wires.'
      + (d.sim ? ' Run settings from file: ' + document.getElementById('duration').value + ' ms at '
        + document.getElementById('dtus').value + ' µs.' : '')
      + (res.dropped ? ' ' + res.dropped + ' saved plot signal(s) dropped: no such block in this circuit.' : '');
  };
  rd.readAsText(file);
}

// ---- shipped examples (embedded by build.py as EXAMPLES) ----

// Name of the shipped example currently on the canvas, or null when the
// circuit is anything else (drawn by hand, loaded from disk, imported, edited).
// Only a non-null value can be turned into a shareable ?example= link.
let loadedExample = null;

// Load one by name, the same commit path the Load button uses. The deep copy is
// not optional: applyCircuit() backfills params into the blocks it is given and
// then keeps the arrays as S.blocks/S.wires, so handing it the embedded object
// would let the user's edits mutate the master copy and make the second load of
// an example differ from the first.
function loadExampleByName(name) {
  const stat = document.getElementById('stat');
  if (!name) return false;
  const d = EXAMPLES[name];
  if (!d) { showError('No such example: ' + name + '.'); return false; }
  const res = applyCircuit(JSON.parse(JSON.stringify(d)), name + '.json');
  if (res.err) { showError('Could not open ' + name + ': ' + res.err); return false; }
  loadedExample = name; // after applyCircuit: its touchModel() clears this
  fitView();
  render();
  stat.textContent = 'Opened example ' + name + ': ' + S.blocks.length + ' blocks, '
    + S.wires.length + ' wires.'
    + (d.sim ? ' Run settings from file: ' + document.getElementById('duration').value + ' ms at '
      + document.getElementById('dtus').value + ' µs.' : '')
    + (res.dropped ? ' ' + res.dropped + ' saved plot signal(s) dropped.' : '');
  return true;
}

// Share the current case as a ?example= URL. Only shipped examples can be
// linked: the app deliberately has no way to put an arbitrary circuit in a URL
// (ieee39bus alone is 46 kB, far past any practical URL length, see
// DECISIONS.md 2026-08-09), so for anything else this says so plainly instead
// of handing over a link that would silently open a different circuit on the
// recipient's screen.
function copyCaseLink() {
  const stat = document.getElementById('stat');
  if (!loadedExample) {
    showWarn('Only the shipped examples have a shareable link, and this circuit is not one '
      + '(or has been edited since it was opened). Use Save to send the .json file instead.');
    return;
  }
  const pf = !!(document.getElementById('pfinit') || {}).checked;
  const url = location.origin + location.pathname
    + '?example=' + encodeURIComponent(loadedExample) + (pf ? '&pf=1' : '') + '&run=1';
  const done = () => { stat.textContent = 'Link copied: ' + url; };
  // The clipboard API needs a secure context, which file:// is not. Falling
  // back to printing the URL keeps the feature usable for the offline
  // single-file case rather than failing silently.
  const fallback = () => { stat.textContent = 'Copy this link: ' + url; };
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, fallback);
    } else fallback();
  } catch (e) { fallback(); }
}

function buildExamplesMenu() {
  const sel = document.getElementById('examplesel');
  if (!sel) return;
  Object.keys(EXAMPLES).sort().forEach(n => {
    const o = document.createElement('option');
    o.value = n; o.textContent = n;
    sel.appendChild(o);
  });
}

// Startup: honour ?example=<name>[&pf=1][&run=1], else the built-in Demo.
// The name is matched against the embedded keys and nothing else, so the
// parameter can never reach a path, a URL, or the filesystem.
// The case a visitor lands on with no ?example= in the URL.
//
// This used to be loadDemo(): a source, a breaker, a line and a resistor, built
// in code. It solved and plotted correctly, and the plot was a clean
// energization step into a resistive load, which does not show what an EMT
// solver is FOR. showcase.json is a real transient: a phase-A-to-ground fault
// at 55 ms clearing at 85 ms, seen through a 2:1 transformer, with a GFM droop
// inverter dispatching into the secondary bus. Same first ten seconds of the
// visit, a far better answer to "what does this thing do".
//
// loadDemo() stays as the fallback. It needs no data beyond its own code, so it
// is the one thing that still works if the embedded examples are ever missing
// or malformed, and a landing page that renders nothing is the worst outcome
// here.
const LANDING_EXAMPLE = 'showcase';
function loadLanding() {
  if (!Object.prototype.hasOwnProperty.call(EXAMPLES, LANDING_EXAMPLE)
      || !loadExampleByName(LANDING_EXAMPLE)) { loadDemo(); return; }
  history = []; future = []; updateUndoButtons(); // arriving is not a user edit
  // The file carries sim.pfinit, which applyCircuit has already put on the
  // checkbox, and runEMTLive() solves the power flow itself when it is set. So
  // this is just a run, not a run plus a separate PF step.
  setTimeout(runEMTLive, 400);
}
function bootFromUrl() {
  let p;
  try { p = new URLSearchParams(location.search); } catch (e) { p = null; }
  const want = p && p.get('example');
  if (!want || !Object.prototype.hasOwnProperty.call(EXAMPLES, want)) {
    if (want) {
      // The complaint now lives in the notice band, which survives the landing
      // case's auto-run. It used to go on the status line, which meant the run
      // had to be suppressed to keep it readable; that is no longer true, so a
      // bad link lands on something working instead of a bare circuit.
      showError('No such example: "' + want + '". Showing ' + LANDING_EXAMPLE
        + ' instead. Pick another from the Examples menu.', true); // survives the landing run
      loadLanding();
      return;
    }
    loadLanding();
    return;
  }
  if (!loadExampleByName(want)) { loadLanding(); return; }
  history = []; future = []; updateUndoButtons(); // arriving via a link is not a user edit
  const on = (k) => { const v = p.get(k); return v !== null && v !== '0' && v !== 'false'; };
  if (on('pf')) { try { solvePF(); } catch (e) { console.warn('[deeplink] pf:', e); } }
  if (on('run')) setTimeout(runEMTLive, 400);
}

// Import an external case file (currently PSS/E RAW), convert it to an OpenEMT
// circuit via importCase() (src/import.js), commit it through applyCircuit(),
// then auto-arrange it (imported circuits carry only a rough grid layout) and
// surface any conversion warnings on the status line.
function importCircuit(file) {
  const rd = new FileReader();
  rd.onload = () => {
    const stat = document.getElementById('stat');
    const res = importCase(rd.result, file.name);
    if (res.err) { showError('Import failed: ' + res.err); return; }
    const ap = applyCircuit(res.circuit, file.name);
    if (ap.err) { showError('Import failed: ' + ap.err); return; }
    // Imported circuits have only a coarse grid layout; tidy them like the user
    // would with the Layout dialog, then frame the whole network.
    try { doHierarchicalLayout('fit'); } catch (e) { fitView(); }
    render();
    const m = res.meta || {};
    let msg = 'Imported ' + file.name + ' (' + (m.format || 'case') + ' v' + m.rev + '): ' +
      m.buses + ' buses, ' + m.gens + ' gens, ' + m.branches + ' branches, ' + m.xfmrs + ' xfmrs.';
    if (res.warnings && res.warnings.length) msg += ' ' + res.warnings.length + ' warning(s): ' + res.warnings[0];
    stat.textContent = msg;
    if (res.warnings) res.warnings.forEach(w => console.warn('[import]', w));
  };
  rd.readAsText(file);
}

// ---- plots: customizable multi-plot signal viewer (SPEC §3) ----
// A "signal" is one probe voltage OR one branch current, on one phase. The
// registry is rebuilt from each run's meta; user selections live in S.plots
// and survive re-runs (stale keys pruned when a block/phase disappears).
const DASH = [[], [6, 3], [2, 3]];  // solid A / dashed B / dotted C
const PH_LBL = ['A', 'B', 'C'];
let live = null;        // { nph, probeIds, curSigs, t, vp, ic, bv } — accumulated buffers
let sigIndex = {};      // signal key -> descriptor (with .get() → buffer series)
let nextPlotId = 1;
// ---- results vs circuit (issue #1) ----
// A run's samples are an answer about ONE circuit, and nothing about them says
// which. `modelRev` counts changes to the ELECTRICAL model — blocks, wires,
// params, and wholesale replacements (load/import/undo). Geometry deliberately
// does NOT count: moving or rotating a block changes no physics, and marking
// the plots stale on every drag would be noise nobody reads. Each run stamps
// the revision it ran against into live.rev, so anything drawn while the two
// differ can be labelled as belonging to an older circuit instead of being
// passed off as current.
let modelRev = 0;
let stalePaint = false;
function touchModel() {
  // Any edit, load or import means what is on screen is no longer the pristine
  // shipped example, so a ?example= link would send the recipient somewhere
  // else. Clearing it here covers every path at once: applyCircuit() calls
  // touchModel(), so file loads, imports and the Demo all invalidate too, and
  // loadExampleByName() re-arms it afterwards.
  loadedExample = null;
  modelRev++;
  // Flow arrows belong to the run that produced them and are keyed by wire
  // INDEX, not by id, so deleting a block or wire silently re-points them at
  // whatever now occupies that index. Drop them here rather than leave them
  // drawing a previous circuit's power flow over the current one.
  wireFlow = {}; wireFlowQ = {};
  // The staleness banner is painted by the plot renderer, but most edit paths
  // only re-render the canvas. Defer one coalesced redraw to the next frame, so
  // it lands after whatever mutation called this (touchModel runs BEFORE the
  // change, to keep it next to pushHistory) and a multi-step edit repaints once.
  if (!stalePaint) {
    stalePaint = true;
    requestAnimationFrame(() => {
      stalePaint = false;
      drawAllPlots();
      findRefresh(); // the hit set and its count follow blocks appearing/disappearing
    });
  }
}
function resultsStale() { return !!live && live.rev !== modelRev; }
// Drop everything a run produced. For a circuit that is REPLACED rather than
// edited (load, import, New), the previous results are not stale data worth
// labelling — they answer a different question, and because signals are keyed
// by block id they can reappear under an id the new circuit has reused for
// something else. That is issue #1's original symptom: two "Probe #14" /
// "Probe #15" series survived a load into IEEE39, where those ids are buses
// and no probe block exists at all.
function resetRunState() {
  live = null;
  sigIndex = {};
  wireFlow = {}; wireFlowQ = {};
  tZoom = null;  // a time window measured against another circuit's run
  yZoom = {};
  Object.keys(groupColor).forEach(k => delete groupColor[k]);
  colorCursor = 0;
  updateZoomInfo();
  updatePlotStepInfo();
}
const groupColor = {}; let colorCursor = 0;
// Colour is keyed by group+quantity (not just group) so e.g. a branch's raw
// current and its derived power don't render in the same colour/dash and
// become indistinguishable if plotted together; all phases of the SAME
// quantity still share one colour, distinguished by dash (solid/dash/dot).
function colorForGroup(gk) { if (groupColor[gk] === undefined) groupColor[gk] = colorCursor++; return COLORS[groupColor[gk] % COLORS.length]; }

// ---- derived signals: RMS (one fundamental cycle, sliding window) and
// active/reactive power (SPEC §3). P = movAvg(v·i) over one cycle — exact
// for any periodic waveform. Q uses the standard quarter-cycle-lookahead
// quadrature method: Q = movAvg(v(t)·i(t+T/4)) (derivation: for v=Vm sin(wt),
// i=Im sin(wt-phi), this averages to (Vm Im/2) sin(phi) = Q). Both need only
// each branch's own recorded v/i — no new circuit elements.
function cycleWindow() {
  const t = live && live.t;
  if (!t || t.length < 2) return 1;
  const dtOut = t[1] - t[0] || 1;
  return Math.max(1, Math.round(1000 / (live.freqHz || 60) / dtOut));
}
function movAvg(samples, win) {
  const out = new Array(samples.length);
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] || 0;
    if (i >= win) sum -= (samples[i - win] || 0);
    out[i] = sum / Math.min(i + 1, win);
  }
  return out;
}
function rmsSeries(samples) {
  const win = cycleWindow();
  const out = new Array(samples.length);
  let sumsq = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] || 0; sumsq += v * v;
    if (i >= win) { const old = samples[i - win] || 0; sumsq -= old * old; }
    out[i] = Math.sqrt(Math.max(0, sumsq) / Math.min(i + 1, win));
  }
  return out;
}
function activePowerSeries(vArr, iArr) {
  const win = cycleWindow(), n = Math.min(vArr.length, iArr.length);
  const p = new Array(n);
  for (let i = 0; i < n; i++) p[i] = (vArr[i] || 0) * (iArr[i] || 0);
  return movAvg(p, win);
}
function reactivePowerSeries(vArr, iArr) {
  const win = cycleWindow(), n = Math.min(vArr.length, iArr.length), shift = Math.max(1, Math.round(win / 4));
  const prod = new Array(n);
  for (let i = 0; i < n; i++) { const j = Math.min(n - 1, i + shift); prod[i] = (vArr[i] || 0) * (iArr[j] || 0); }
  return movAvg(prod, win);
}
// Element-wise sum of several equal-length (or near-equal, during a live
// streaming run) series — used to total a 3-phase branch's per-phase P/Q
// into ONE 3-phase value (SPEC §3), the conventional way 3-phase power is
// reported. Summing already-averaged per-phase series is exact here since
// movAvg is linear (sum-of-averages = average-of-sum for a shared window).
function sumSeries(arrs) {
  const n = Math.min(...arrs.map(a => a.length));
  const out = new Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (const a of arrs) s += a[i] || 0; out[i] = s; }
  return out;
}

// ---- power-flow direction arrows (SPEC §3, July 2026): a per-branch,
// trailing-window flow value used only to pick an arrow direction on the
// schematic. FLOW_REVERSED is the ONE physically-grounded polarity table for
// the whole app — also reused below by ingestMeta's plotted P/Q sign, so
// there is exactly one definition of "positive/negative power," not a
// separate display convention. Tracing every inject() in blocks.js: only
// `src`, `gfm`'s AC pair (term0/term1), and `syncgen` use the reversed
// "I[n1]+=,I[n2]-=" EMF-source stamp; batt/pv/pfc/dcdc/gfm's own DC port all
// use the ordinary "I[n1]-=,I[n2]+=" passive-branch stamp — so only those
// three need a flip to read consistently with everything else (an earlier
// version also flipped batt/pv for a "generators read positive" UX nicety;
// removed after a user flagged that role-based exception as confusing to
// read across mixed generator/load circuits — see ingestMeta below for the
// full rationale).
const FLOW_REVERSED = { src: 1, gfm: 1, syncgen: 1, wt4: 1, hvdc: 1, gfl: 1 }; // AC pair only — gfm's DC port (term 2) is handled separately below. im is NOT here: its current-source interface uses the passive convention directly (I[n1] -= i, like pq/cpl), so its plotted P is already positive-absorbing (SPEC §2).
const FLOW_FLOOR_W = 1;    // W — AC branches, active power: below this, treat as no meaningful flow
const FLOW_FLOOR_VAR = 1;  // VAR — AC branches, reactive power: same idea
const FLOW_FLOOR_A = 0.05; // A — DC branches: same idea, in current rather than power (no Q concept)
const FLOW_Q_COLOR = '#f2c94c'; // yellow, distinct from --acc (P) and the category tick hues
// Trailing-window flow value at ONE TERMINAL of a branch (July 2026 fix:
// arrows now use THROUGH power — v_node·i at the queried terminal, exactly
// the 'pin:'/'pout:' quantity from ingestMeta — not ABSORBED power vb·i as
// before. Absorbed power was the wrong quantity for direction: a closed
// breaker absorbs ~0 W, so BOTH its wires fell below the floor and each
// resolved direction from its opposite endpoint independently — a user saw
// the two arrows around one breaker pointing away from each other. Through
// power is what an arrow physically represents, and it's well above the
// floor everywhere along a carrying chain.)
// Positive return = "power flows INTO the element at this terminal" (in at
// term 0, or backfeeding in at term 1); negative = flowing out of it there.
// `reactive` picks Q (quarter-cycle-shifted product, same quadrature method
// as reactivePowerSeries) instead of P — an AC line genuinely carries both
// simultaneously (they can even point OPPOSITE ways, e.g. a capacitive
// branch), so this is a second, independent flow value per branch, not a
// variant of the same one. Never called with reactive=true for a DC branch.
function branchFlowValue(idx, term, reactive) {
  const cs = live.curSigs[idx], win = cycleWindow();
  if (cs.dc) {
    // DC branch: the exposed current IS already the physically-meaningful,
    // non-oscillating n1->n2 current (icmd/idc/etc) — average it directly;
    // callers interpret its sign per-terminal (see endFlowToward).
    const i = live.ic[idx][0], n = i.length, from = Math.max(0, n - win);
    let sum = 0, cnt = 0;
    for (let k = from; k < n; k++) { sum += i[k] || 0; cnt++; }
    return cnt ? sum / cnt : 0;
  }
  // AC branch: cycle-averaged v_terminal·i (through power at the queried
  // end) — same math as the plotted pin/pout series, collapsed to one
  // trailing-window scalar. Terminal 0's node voltage is recorded (live.tv);
  // terminal 1's is tv − bv (= a·v(n2), transformer scaling included).
  // Q's quadrature reference: avg(v(t−T/4)·i(t)) — the VOLTAGE is delayed,
  // not the current advanced, because this scalar is evaluated over the very
  // LAST window of the run where "future" current samples don't exist (the
  // plotted reactivePowerSeries advances i and clamps at the array end,
  // which is harmless mid-plot but here corrupted a quarter of the averaging
  // window with one stale sample — found when a resistive load showed ~17%
  // phantom Q). Both forms average to the same quantity for a periodic
  // waveform (substitute u = t − T/4).
  const shift = reactive ? Math.max(1, Math.round(win / 4)) : 0;
  let acc = 0;
  for (let ph = 0; ph < cs.np; ph++) {
    const vt = live.tv[idx] ? live.tv[idx][ph] : null, vb = live.bv[idx][ph], i = live.ic[idx][ph];
    if (!vt) return NaN; // no recorded terminal voltage (shouldn't happen for AC) — no arrow
    const n = Math.min(vt.length, i.length), from = Math.max(shift, n - win);
    let sum = 0, cnt = 0;
    for (let k = from; k < n; k++) {
      const kv = k - shift;
      const v = term === 0 ? (vt[kv] || 0) : (vt[kv] || 0) - (vb[kv] || 0);
      sum += v * (i[k] || 0); cnt++;
    }
    if (cnt) acc += sum / cnt;
  }
  // Same FLOW_REVERSED polarity flip as the plotted pin/pout signals; then
  // negate the term-1 reading so BOTH terminals mean "positive = into the
  // element here" (raw 'out' means positive = exiting at term 1).
  const v = FLOW_REVERSED[cs.kind] ? -acc : acc;
  return term === 0 ? v : -v;
}
// Whether flow points TOWARD the given (block, terminal) endpoint — null if
// that endpoint isn't a current-carrying branch terminal, its flow is below
// the noise floor, OR (found via browser testing) this exact terminal fans
// out to more than one wire — e.g. a line's output terminal wired to BOTH
// its load AND a measurement probe, or several converters sharing one DC
// node with no explicit Bus block. In that case the terminal's one branch
// current doesn't belong to any single wire (a probe carries none of it at
// all; a shared node splits it by real KCL apportionment this feature
// doesn't attempt) — so a fanned-out terminal is never trusted as a
// direction SOURCE, though a wire touching it can still get an arrow from
// its OTHER (non-fanned-out) endpoint, same as any other wire.
function endFlowToward(blkId, term, byId, termCount, reactive) {
  const m = byId[blkId];
  if (!m) return null;
  if ((termCount[blkId + ':' + term] || 0) > 1) return null;
  if (reactive && m.cs.dc) return null; // Q doesn't apply to a DC branch
  if (m.cs.kind === 'gfm' && term === 2) { // DC port: single terminal, ground-return implicit
    if (reactive) return null; // DC port — no Q concept
    const aux = live.aux[m.ci];
    const idc = aux && aux.length ? aux[aux.length - 1] : 0;
    if (Math.abs(idc) < FLOW_FLOOR_A) return null;
    return idc > 0; // normal/sink-role wiring (I[dc] -= idc)
  }
  if (term !== 0 && term !== 1) return null; // xfmr's non-branch terminals etc. — not modeled
  const val = branchFlowValue(m.ci, term, reactive);
  let floor = m.cs.dc ? FLOW_FLOOR_A : (reactive ? FLOW_FLOOR_VAR : FLOW_FLOOR_W);
  // Q's quadrature shift rounds to whole samples, leaking ~0.5% of P into the
  // measured Q — enough to clear a fixed floor on a heavily-loaded branch and
  // draw a spurious Q arrow on a purely resistive path. Scale the Q floor
  // with the branch's own P so leakage-sized Q never draws an arrow.
  if (reactive && !m.cs.dc) {
    const pval = branchFlowValue(m.ci, term, false);
    if (isFinite(pval)) floor = Math.max(floor, 0.02 * Math.abs(pval));
  }
  if (!isFinite(val) || Math.abs(val) < floor) return null;
  // DC: val is the branch's n1->n2 current, one number for both ends —
  // interpret per terminal. AC: val is through power at THIS terminal,
  // already normalized to "positive = into the element here" for either end.
  return m.cs.dc ? (term === 0 ? val > 0 : val < 0) : val > 0;
}
// wire index -> true (flow toward wire.a) / false (flow toward wire.b), one
// map for active power (wireFlow) and a separate one for reactive
// (wireFlowQ) — a branch's P and Q can point opposite ways (e.g. a
// capacitive load exports Q while still importing P), so these are two
// independent per-wire results, not one value with a Q variant. Recomputed
// once per data update (chunk/done/sync draw), not per canvas frame —
// render() just reads the cached result, so dragging/rotating a block
// doesn't touch this.
let wireFlow = {}, wireFlowQ = {};
function computeFlowDirs() {
  wireFlow = {}; wireFlowQ = {};
  if (!live || !live.curSigs) return;
  const byId = {};
  live.curSigs.forEach((cs, ci) => { byId[cs.id] = { cs, ci }; });
  const termCount = {};
  S.wires.forEach(w => {
    const ka = w.a[0] + ':' + w.a[1], kb = w.b[0] + ':' + w.b[1];
    termCount[ka] = (termCount[ka] || 0) + 1;
    termCount[kb] = (termCount[kb] || 0) + 1;
  });
  const resolve = reactive => {
    const out = {};
    S.wires.forEach((w, wi) => {
      let towardA = endFlowToward(w.a[0], w.a[1], byId, termCount, reactive);
      if (towardA === null) {
        const towardB = endFlowToward(w.b[0], w.b[1], byId, termCount, reactive);
        if (towardB !== null) towardA = !towardB;
      }
      if (towardA !== null) out[wi] = towardA;
    });
    return out;
  };
  wireFlow = resolve(false);
  wireFlowQ = resolve(true);
}

function initPlots() {
  if (!S.plots) S.plots = [
    { id: nextPlotId++, title: 'Voltages', auto: 'V', sigs: [] }
  ];
}
// Fresh empty buffers + signal registry from a run's meta descriptor.
function ingestMeta(meta) {
  live = {
    rev: modelRev, // the circuit these samples describe (see touchModel)
    nph: meta.nph,
    Tms: meta.Tms || 0, // the run's true eventual duration — see fullRange()
    freqHz: meta.freqHz || 60,
    probeIds: meta.probes.map(p => p.id),
    curSigs: meta.curMeta,
    t: [],
    vp: meta.probes.map(() => Array.from({ length: meta.nph }, () => [])),
    ic: meta.curMeta.map(cs => Array.from({ length: cs.np }, () => [])),
    bv: meta.curMeta.map(cs => Array.from({ length: cs.np }, () => [])),
    tv: meta.curMeta.map(cs => (cs.thru ? Array.from({ length: cs.np }, () => []) : null)), // terminal-0 node voltage (through-power)
    aux: meta.curMeta.map(cs => (cs.aux ? [] : null)), // scalar state (battery SOC)
    fp: meta.probes.map(p => (p.hasF ? [] : null))    // node frequency (3-ph AC nodes)
  };
  sigIndex = {};
  // A node on the DC side reads identically on every phase (SPEC §3) — expose
  // ONE signal labeled "DC" instead of three duplicate A/B/C entries.
  live.probeIds.forEach((id, pi) => {
    const pm = meta.probes[pi] || {};
    const dc = !!pm.dc;
    // Buses ride the probe pipeline (SPEC §3): group under the bus's own name.
    const group = pm.type === 'bus' ? (pm.name || 'Bus #' + id) : 'Probe #' + id;
    // A node on a single-phase lateral (SPEC §2 phase tap) likewise has ONE
    // real reading — the solver repeats it across the phase slots exactly as
    // it does for DC — so expose one signal, labeled with its actual phase.
    const lat = pm.ph1 == null ? null : pm.ph1;
    const nphSig = (dc || lat !== null) ? 1 : live.nph;
    for (let ph = 0; ph < nphSig; ph++) {
      const key = 'v:' + id + ':' + ph;
      const lbl = lat !== null ? lat : ph;
      sigIndex[key] = { key, group, groupKey: 'v:' + id, quantity: 'V', unit: 'V', phase: lbl, dc, get: () => live.vp[pi][ph] };
      if (!dc) { // RMS is an AC concept — see SPEC §3
        const rkey = 'rv:' + id + ':' + ph;
        sigIndex[rkey] = { key: rkey, group, groupKey: 'v:' + id, quantity: 'RMSV', unit: 'V rms', phase: lbl, dc, get: () => rmsSeries(live.vp[pi][ph]) };
      }
    }
    // Node frequency: ONE signal per node, not per phase — a positive-sequence
    // PLL has a single output. Present only where the solver could measure it
    // (3-ph AC), so a DC node or a 1-ph lateral simply has no frequency entry
    // rather than a misleading flat 50/60.
    if (pm.hasF) {
      const fkey = 'f:' + id;
      sigIndex[fkey] = { key: fkey, group, groupKey: 'v:' + id, quantity: 'F', unit: 'Hz', phase: null, dc: true, get: () => live.fp[pi] || [] };
    }
  });
  live.curSigs.forEach((cs, ci) => {
    const label = (DEFS[cs.type] ? DEFS[cs.type].label : cs.type) + ' #' + cs.id;
    const gk = 'i:' + cs.id;
    // ph0 (SPEC §2 phase tap): a branch on a single-phase lateral records one
    // trace that is not necessarily phase A. 0 for everything else, so every
    // ordinary 3-phase and DC branch labels exactly as before.
    const ph0 = cs.ph0 || 0;
    for (let ph = 0; ph < cs.np; ph++) {
      const key = 'i:' + cs.id + ':' + ph;
      sigIndex[key] = { key, group: label, groupKey: gk, quantity: 'I', unit: 'A', phase: ph0 + ph, dc: !!cs.dc, get: () => live.ic[ci][ph] };
      if (!cs.dc) { // RMS current is an AC-only concept, stays per-phase — imbalance is still visible here
        const rkey = 'ri:' + cs.id + ':' + ph;
        sigIndex[rkey] = { key: rkey, group: label, groupKey: gk, quantity: 'RMSI', unit: 'A rms', phase: ph0 + ph, dc: false, get: () => rmsSeries(live.ic[ci][ph]) };
      }
    }
    // Active/reactive power: v·i, ONE convention for every block, no
    // per-role exception — positive = ABSORBING (power flows INTO the
    // block at its terminal 0), negative = DELIVERING, always, whether
    // it's a load, a line, a battery, or a source. Verified by energy
    // balance (Tellegen: total P across a circuit sums to ~0 under this
    // exact convention — see smoke_test.js). The only correction applied
    // is `FLOW_REVERSED` (declared above, shared with the flow-arrow
    // code) — NOT a "generator reads positive" choice, but the one
    // correction physics actually requires: `src` and `gfm`'s AC pair
    // inject their EMF/Norton current at terminal 0 with the STAMP
    // physically reversed relative to every passive branch (traced
    // directly from inject() in blocks.js), so their raw v·i needs that
    // flip just to mean the same thing as everyone else's. `batt`/`pv`
    // have the ordinary passive terminal wiring — despite being
    // generator-role blocks, they need NO flip; their raw v·i is already
    // consistent with the rest of the circuit (previously flipped anyway,
    // purely for a "generators read positive" UX nicety — removed July
    // 2026 after that inconsistency was flagged as confusing to read
    // across mixed generator/load circuits). A discharging battery and a
    // generating PV panel now both read NEGATIVE, same as any other
    // source of power; a charging battery reads POSITIVE, same as any
    // other absorbing load.
    const sign = FLOW_REVERSED[cs.kind] ? -1 : 1;
    // Two DISTINCT power quantities per branch (SPEC §3, separated July 2026
    // after a user rightly noticed a chain of series elements plotted wildly
    // different "P" values — because absorbed and through power are different
    // things):
    //  * ABSORBED ('p:'/'q:', unit "W"/"VAR"): vb·i, what the element itself
    //    consumes (+) or generates (−) — a closed breaker reads ~0, a line
    //    only its own I²R loss. Tellegen: these sum to ~0 over the circuit.
    //  * THROUGH ('pin:'/'pout:'/'qin:'/'qout:', unit "W in/out"): v_node·i
    //    at each terminal — the power actually flowing through the branch.
    //    in = at terminal 0 (v = live.tv), out = at terminal 1
    //    (v = tv − vb, which equals a·v(n2) — transformer scaling included).
    //    in − out = absorbed, exactly. Along a series chain, one element's
    //    "out" equals the next one's "in" — this is the value that IS the
    //    same all the way down a feeder (minus each element's own losses).
    //    A terminal sitting on ground reads 0 (no power flows through a
    //    node at 0 V) — e.g. a source's grounded return: look at its OTHER
    //    terminal for the power it pushes into the circuit.
    //    Not offered for pfc/dcdc (cs.thru false) — power converters, not
    //    series branches; their two sides carry different currents so the
    //    identity doesn't hold.
    const vIn = ph => live.tv[ci][ph];
    const vOut = ph => { const t = live.tv[ci][ph], b = live.bv[ci][ph]; return t.map((v, i) => v - (b[i] || 0)); };
    const addPQ = (prefix, unitSuffix, seriesFn, vGetter) => {
      if (cs.np === 3) {
        // one aggregate 3-phase value, same convention as absorbed P/Q above
        const key = prefix + ':' + cs.id + ':0';
        const unit = (prefix[0] === 'q' ? 'VAR' : 'W') + unitSuffix;
        sigIndex[key] = { key, group: label, groupKey: gk, quantity: prefix.toUpperCase(), unit, phase: null, dc: false, get: () => sumSeries([0, 1, 2].map(ph => seriesFn(vGetter(ph), live.ic[ci][ph]))).map(v => v * sign) };
      } else {
        for (let ph = 0; ph < cs.np; ph++) {
          if (cs.dc && prefix[0] === 'q') continue; // Q is AC-only
          const key = prefix + ':' + cs.id + ':' + ph;
          const unit = (prefix[0] === 'q' ? 'VAR' : 'W') + unitSuffix;
          sigIndex[key] = { key, group: label, groupKey: gk, quantity: prefix.toUpperCase(), unit, phase: ph0 + ph, dc: !!cs.dc, get: () => seriesFn(vGetter(ph), live.ic[ci][ph]).map(v => v * sign) };
        }
      }
    };
    addPQ('p', '', activePowerSeries, ph => live.bv[ci][ph]);
    if (!cs.dc || cs.np === 3) addPQ('q', '', reactivePowerSeries, ph => live.bv[ci][ph]);
    if (cs.thru) {
      addPQ('pin', ' in', activePowerSeries, vIn);
      addPQ('pout', ' out', activePowerSeries, vOut);
      if (!cs.dc || cs.np === 3) {
        addPQ('qin', ' in', reactivePowerSeries, vIn);
        addPQ('qout', ' out', reactivePowerSeries, vOut);
      }
    }
    if (cs.aux) { // per-element scalar state — battery SOC (%), gfm DC current
                  // (A) — always DC/1-phase; key prefix keeps each kind's aux
                  // signal in its own namespace (no collision with i:/v: keys)
      const skey = cs.aux.toLowerCase() + ':' + cs.id + ':0';
      sigIndex[skey] = { key: skey, group: label, groupKey: gk, quantity: cs.aux, unit: cs.auxUnit, phase: 0, dc: true, get: () => live.aux[ci] };
    }
  });
  S.plots.forEach(pl => { if (!pl.auto) pl.sigs = pl.sigs.filter(s => sigIndex[s.key]); }); // prune stale
}
// An auto plot expands from the live registry, so on a large imported case it
// used to mean EVERY node voltage on every phase — over a hundred series
// redrawn on every streamed chunk, which is slow and unreadable besides. The
// expansion is capped (July 2026); the plot says so in its legend, and the
// picker still offers every signal for anyone who wants more. Registry order is
// block order, so the cap keeps the first few nodes of the circuit, which are
// the source end.
const AUTO_MAX = 6;
function autoKeysAll(auto) {
  return Object.keys(sigIndex).filter(k => auto === 'V' ? sigIndex[k].quantity === 'V'
    : auto === 'IA' ? (sigIndex[k].quantity === 'I' && sigIndex[k].phase === 0) : false);
}
function autoKeys(auto) { return autoKeysAll(auto).slice(0, AUTO_MAX); }
// The concrete {key,axis} list a plot currently shows (auto plots expand live).
function plotSelection(pl) {
  return pl.auto ? autoKeys(pl.auto).map(key => ({ key, axis: 'L' })) : pl.sigs;
}

// ---- shared time-axis zoom (SPEC §3): one window applies to every plot, so
// zooming into a transient on one signal lines up the same window on all of
// them — that's the whole point of viewing several plots together. Drag on
// a plot to box-zoom; Shift+drag to pan; scroll to zoom at the cursor; or use
// the +/−/Reset controls. Y-axis auto-rescales to whatever's in the window.
let tZoom = null; // { t0, t1 } in ms, or null = full range
// The "full range" is the run's TRUE eventual duration (live.Tms), not just
// however much of live.t has streamed in so far — using the latter would
// clamp/collapse a persisted zoom against a moving target while a worker
// run is still streaming (fixed July 2026: zoom was getting lost mid-stream).
function fullRange() {
  const t = live && live.t;
  if (!t) return { t0: 0, t1: 1 };
  const t0 = t.length ? t[0] : 0;
  const t1 = Math.max(live.Tms || 0, t.length ? t[t.length - 1] : 0) || 1;
  return { t0, t1 };
}
function clampZoom() {
  if (!tZoom || !live) return;
  const fr = fullRange();
  const t0 = Math.max(fr.t0, Math.min(tZoom.t0, fr.t1)), t1 = Math.max(fr.t0, Math.min(tZoom.t1, fr.t1));
  tZoom = (t1 - t0 < (fr.t1 - fr.t0) * 0.002 || t1 <= t0) ? null : { t0, t1 };
}
function currentWindow() { clampZoom(); return tZoom || fullRange(); }
function setZoom(t0, t1) {
  const fr = fullRange();
  if (t1 < t0) { const s = t0; t0 = t1; t1 = s; }
  if (t1 - t0 < (fr.t1 - fr.t0) * 0.002) return; // ignore a near-zero-width select (likely just a click)
  tZoom = { t0: Math.max(fr.t0, t0), t1: Math.min(fr.t1, t1) };
  updateZoomInfo(); drawAllPlots();
}
function panZoom(t0, t1) { // like setZoom but clamps-by-shifting instead of dropping (used while dragging to pan)
  const fr = fullRange(); const width = t1 - t0;
  if (t0 < fr.t0) { t0 = fr.t0; t1 = t0 + width; }
  if (t1 > fr.t1) { t1 = fr.t1; t0 = t1 - width; }
  tZoom = { t0: Math.max(fr.t0, t0), t1: Math.min(fr.t1, t1) };
  updateZoomInfo(); drawAllPlots();
}
function resetPlotZoom() { tZoom = null; yZoom = {}; updateZoomInfo(); drawAllPlots(); }
function plotZoomBy(factor) {
  if (zoomMode !== 'y') {
    const w = currentWindow(), mid = (w.t0 + w.t1) / 2, half = (w.t1 - w.t0) / 2 / factor;
    setZoom(mid - half, mid + half);
  }
  if (zoomMode !== 'x') { S.plots.forEach(pl => scaleYZoom(pl, factor)); updateZoomInfo(); drawAllPlots(); }
}

// ---- vertical (value-axis) zoom, per plot ----
// The time window is deliberately SHARED (correlating events across signals is
// the point of stacked plots), but a value window is NOT: plots hold different
// quantities in different units, so "the same" vertical window across them is
// meaningless. yZoom is therefore keyed by plot id and holds an explicit range
// per axis side; a null side means "auto-fit to what's in the time window", the
// original behavior. It is view state, not circuit state — like tZoom it lives
// here and is never written into S.plots, which is serialized by saveCircuit().
let yZoom = {}; // { [plotId]: { L: {mn,mx}|null, R: {mn,mx}|null } }
// What a drag/scroll on a plot acts on: 'x' time only (shared), 'y' value only
// (this plot), 'box' both. Persisted like the other layout preferences.
let zoomMode = 'x';
function setZoomMode(m) {
  zoomMode = (m === 'y' || m === 'box') ? m : 'x';
  localStorage.setItem('emt_zoommode', zoomMode);
  syncZoomModeUI();
}
function syncZoomModeUI() {
  const box = document.getElementById('zoommode');
  if (!box) return;
  box.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.m === zoomMode));
}
function hasYZoom() { return Object.keys(yZoom).some(k => yZoom[k] && (yZoom[k].L || yZoom[k].R)); }
function setYSide(pl, side, r) {
  const z = yZoom[pl.id] || (yZoom[pl.id] = { L: null, R: null });
  z[side] = r;
}
// Both axis sides move together under one gesture: the drag selects a REGION
// OF SCREEN, and each side maps that same pixel band through its own current
// range, so a left-axis kV trace and a right-axis A trace stay visually where
// the user put them. `geom.rl`/`geom.rr` are the ranges actually drawn last
// frame, so gestures compose (zoom, then zoom again) instead of each one
// re-deriving from the auto-fit range.
function pxToVal(r, yPix, g) { return r.mx - (r.mx - r.mn) * (yPix - g.yTop) / g.yH; }
function setYZoomFromPixels(pl, g, yA, yB) {
  const y0 = Math.min(yA, yB), y1 = Math.max(yA, yB);
  if (y1 - y0 < 4) return false; // a click, not a drag
  if (g.rl) setYSide(pl, 'L', { mn: pxToVal(g.rl, y1, g), mx: pxToVal(g.rl, y0, g) });
  if (g.rr) setYSide(pl, 'R', { mn: pxToVal(g.rr, y1, g), mx: pxToVal(g.rr, y0, g) });
  return true;
}
function zoomYAt(pl, g, yPix, factor) {
  const one = r => { const v = pxToVal(r, yPix, g); return { mn: v - (v - r.mn) / factor, mx: v + (r.mx - v) / factor }; };
  if (g.rl) setYSide(pl, 'L', one(g.rl));
  if (g.rr) setYSide(pl, 'R', one(g.rr));
}
function scaleYZoom(pl, factor) { // toolbar +/−: zoom about the plot's own center
  const c = document.getElementById('pcv-' + pl.id), g = c && c._geom;
  if (g) zoomYAt(pl, g, g.yTop + g.yH / 2, factor);
}
// dPix = pixels the pointer moved DOWN. The window moves UP in value so the
// trace follows the pointer (direct manipulation), matching how the time pan
// drags the waveform along with the cursor.
function panYBy(pl, g, dPix) {
  const one = r => { const d = (r.mx - r.mn) * dPix / g.yH; return { mn: r.mn + d, mx: r.mx + d }; };
  if (g.rl) setYSide(pl, 'L', one(g.rl));
  if (g.rr) setYSide(pl, 'R', one(g.rr));
}
function clearYZoom(pl) {
  if (!yZoom[pl.id]) return false;
  delete yZoom[pl.id];
  return true;
}
function updateZoomInfo() {
  const el = document.getElementById('zoominfo'), btn = document.getElementById('zoomresetbtn');
  const y = hasYZoom();
  if (el) el.textContent = (tZoom ? 'Zoomed: ' + tZoom.t0.toFixed(1) + ' to ' + tZoom.t1.toFixed(1) + ' ms' : '')
    + (y ? (tZoom ? ' + value' : 'Zoomed: value') : '');
  if (btn) btn.disabled = !tZoom && !y;
}
// Show the plot spacing actually used by the last run, next to the Plot step
// field. The field can be blank (auto) or hold an explicit value that the
// solver rounds to an integer decimation (dec = max(1, round(plotUs/dt))), so
// the effective spacing can differ from what was typed — surfacing it tells the
// user the real sample interval of the current plot data. Tagged "(auto)" when
// the field was blank/0. Cleared until a run produces >=2 output samples.
function updatePlotStepInfo() {
  const el = document.getElementById('plotstepinfo');
  if (!el) return;
  if (!live || !live.t || live.t.length < 2) { el.textContent = ''; return; }
  const us = (live.t[1] - live.t[0]) * 1000;
  const field = document.getElementById('plotus');
  const isAuto = !field || +field.value <= 0;
  const rounded = Math.round(us * 10) / 10;
  el.textContent = '→ ' + rounded + ' µs' + (isAuto ? ' (auto)' : '');
}

// ---- plot card DOM (rebuilt only when the plot set changes) ----
function renderPlots() {
  const cont = document.getElementById('plots');
  if (!cont) return;
  let h = '';
  S.plots.forEach(pl => {
    h += '<div class="chartcard" data-plot="' + pl.id + '">'
      + '<div class="plothead">'
      + '<input class="plottitle" value="' + escAttr(pl.title) + '" onchange="renamePlot(' + pl.id + ',this.value)">'
      + '<span class="flexpad"></span>'
      + '<button onclick="exportPlotPNG(' + pl.id + ')" title="Save this plot as a PNG image (title, legend and the current zoom included)">PNG</button>'
      + '<button onclick="exportPlotCSV(' + pl.id + ')" title="Save the plotted samples in the current time window as CSV (one column per signal)">CSV</button>'
      + '<button onclick="openPicker(' + pl.id + ',this)">Signals</button>'
      + '<button class="xbtn" onclick="removePlot(' + pl.id + ')" title="Remove plot">&times;</button>'
      + '</div>'
      + '<div class="cnvwrap2"><canvas class="plot" id="pcv-' + pl.id + '" height="' + plotHeight(pl)
      + '" style="height:' + plotHeight(pl) + 'px"></canvas>'
      + '<div class="selbox" id="selbox-' + pl.id + '"></div>'
      // Data cursor: a hairline and a value readout, both plain DOM overlays
      // rather than anything drawn into the canvas. Drawing them on the canvas
      // would mean repainting every trace on every pointermove, which is the
      // cost that made canvas dragging stutter at 147 blocks.
      + '<div class="pcur" id="pcur-' + pl.id + '"></div>'
      + '<div class="pread" id="pread-' + pl.id + '"></div>'
      + '<div class="plotgrip" data-plot="' + pl.id + '" title="Drag to resize this plot (double-click to reset)"></div></div>'
      + '<div class="hint" id="pleg-' + pl.id + '"></div></div>';
  });
  h += '<button class="addplot" onclick="addPlot()">+ Add plot</button>';
  cont.innerHTML = h;
  bindPlotInteractions();
  updateZoomInfo();
  updatePlotStepInfo();
  drawAllPlots();
}
function drawAllPlots() {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  S.plots.forEach(pl => (live ? drawOnePlot(pl, dark) : drawEmptyPlot(pl, dark)));
}
// No run data at all (fresh page, New, or a circuit just loaded). Blanking the
// plots silently reads as a fault in the tool rather than as "there is nothing
// to show yet", which is what it actually is, so the card says so.
function drawEmptyPlot(pl, dark) {
  const c = document.getElementById('pcv-' + pl.id);
  const leg = document.getElementById('pleg-' + pl.id);
  if (leg) leg.textContent = '';
  if (!c || c.offsetWidth < 60) return;
  const H = plotHeight(pl), W = c.offsetWidth;
  c.width = W * 2; c.height = H * 2;
  const ctx = c.getContext('2d'); ctx.scale(2, 2);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#898781'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('No results yet. Press Run.', W / 2, H / 2 + 4);
  ctx.textAlign = 'left';
  c._geom = null; // no axes to invert a pointer gesture against
}
// Per-plot height in CSS px (pl.h, set by the card's grip; saved with the
// circuit alongside title/signals). PLOT_H0 is the historical fixed height, so
// a plot with no stored h looks exactly as before.
const PLOT_H0 = 150, PLOT_H_MIN = 70, PLOT_H_MAX = 900;
function plotHeight(pl) {
  const h = +pl.h;
  return (h >= PLOT_H_MIN && h <= PLOT_H_MAX) ? Math.round(h) : PLOT_H0;
}
// SI prefixes for axis tick labels (issue #6). Power systems live at 400 kV
// and 3 GW, and printing those raw gives five labels of the form "399982.4"
// that are slow to read, hard to compare against each other, and wide enough
// that the axis gutter grows to fit them and steals plot width.
const SI_STEPS = [[1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p']];
function siScale(mag) {
  if (!isFinite(mag) || mag === 0) return { div: 1, sfx: '' };
  const hit = SI_STEPS.find(([f]) => mag >= f);
  return hit ? { div: hit[0], sfx: hit[1] } : { div: 1e-12, sfx: 'p' };
}
// The 5 y-axis tick labels for a range, with the decimal count driven by the
// tick STEP: on a 0.04 Hz-wide window every tick would otherwise round to the
// same integer. Falls back to exponential when a label would run wider than
// the axis gutter can reasonably grow (very large values at a fine step).
function tickLabels(r) {
  const span = r.mx - r.mn, step = Math.abs(span / 4) || 1;
  const vals = [0, 1, 2, 3, 4].map(i => r.mx - span * i / 4);
  // ONE prefix for the whole axis, chosen from the largest tick, so the five
  // labels stay directly comparable: 400k / 300k / 200k, never
  // 400k / 300000 / 200000. The prefix rides the number rather than being
  // promoted to an axis unit label, because one axis can legitimately carry a
  // V series and an A series at the same time and there is no single correct
  // unit to print there; the legend already names each series' unit.
  const { div, sfx } = siScale(Math.max(...vals.map(v => Math.abs(v))));
  const sv = vals.map(v => v / div), sstep = step / div;
  // One more decimal than the step's own magnitude, so neighbouring ticks
  // always differ in the last-but-one digit, then drop any trailing-zero
  // column ALL five labels share (0.01 steps want "60.02", not "60.020").
  let dec = Math.max(0, Math.min(9, 1 - Math.floor(Math.log10(sstep))));
  let out = sv.map(v => v.toFixed(dec));
  while (dec > 0 && out.every(s => s.endsWith('0'))) { dec--; out = sv.map(v => v.toFixed(dec)); }
  // Fixed notation ran out of resolution (a nano-scale axis): every tick would
  // print the same string, so switch the whole axis to exponential. The prefix
  // is dropped there rather than combined, since "1.23e-5k" reads as nonsense.
  if (out[0] === out[4]) return vals.map(v => v.toExponential(2));
  // A tick that has rounded to zero carries no magnitude, so it takes neither
  // decimals nor a prefix: "566k / 283k / 0 / -283k / -566k" rather than the
  // "0k" a blanket suffix produces. This also kills the "-0" that an axis
  // straddling zero asymmetrically used to print (a 454.295 to -454.702 range
  // puts a tick at -0.2035, and toFixed(0) renders that as "-0").
  return out.map((s, i) => (parseFloat(s) === 0 ? '0' : s.length > 11 ? vals[i].toExponential(2) : s + sfx));
}
// The drawable form of a plot's selection: samples + style + axis side. Shared
// by the renderer, the legend and the PNG/CSV exporters so an exported figure
// can never disagree with the one on screen.
function plotSeries(pl) {
  return plotSelection(pl).filter(s => sigIndex[s.key]).map(s => {
    const d = sigIndex[s.key];
    return { samples: d.get() || [], color: colorForGroup(d.groupKey + ':' + d.quantity), dash: DASH[d.phase] || [], axis: s.axis || 'L', meta: d };
  });
}
function seriesLabel(s) {
  return s.meta.group + (live.nph > 1 && phaseLabel(s.meta) ? ' ' + phaseLabel(s.meta) : '')
    + ' (' + s.meta.unit + (s.axis === 'R' ? ', R' : '') + ')';
}
// Index bounds of the samples inside the current time window (the same slice
// drawOnePlot draws), falling back to the whole series if the window has
// drifted off the data.
function windowBounds(win) {
  const t = live.t;
  let i0 = 0; while (i0 < t.length && t[i0] < win.t0) i0++;
  let i1 = t.length - 1; while (i1 >= 0 && t[i1] > win.t1) i1--;
  if (i1 < i0) { i0 = 0; i1 = Math.max(0, t.length - 1); }
  return { i0, i1 };
}
// Vertical auto-fit for one axis, over the samples in the visible time window.
// Seeded from the DATA, not from zero (issue #5). Anchoring the axis at zero
// spent its whole height on the empty space below a large mean: a 60 Hz trace
// was drawn on a -4.8 to 64.8 axis, where a real 60.00 to 60.05 Hz excursion is
// about a third of a pixel and reads as a dead flat line. Same for a battery
// SOC moving 70.0 to 70.5 percent on a 0 to 100 axis, and for any DC bus
// voltage. An AC waveform straddles zero by itself, so voltage and current
// traces are unaffected by the change; what gains is exactly the class of
// signal whose information lives in a small excursion about a large value.
function axisRange(series, side, i0, i1) {
  let mn = Infinity, mx = -Infinity, any = false;
  series.forEach(s => {
    if (s.axis !== side) return;
    for (let i = i0; i <= i1; i++) { const v = s.samples[i]; if (v === undefined) continue; any = true; if (v < mn) mn = v; if (v > mx) mx = v; }
  });
  if (!any) return null;
  // Flat, or flat to within solver noise. Fitting to the data would otherwise
  // magnify 1e-12 numerical dust into a mountain range that looks like real
  // dynamics, so anything below a relative floor is treated as constant and
  // given a modest window (0.1% of the value) around it instead. A trace that
  // is flat at exactly zero has no scale to work from and keeps the old +/- 1.
  const scale = Math.max(Math.abs(mn), Math.abs(mx));
  if (mx - mn <= 1e-9 * scale) { const p = scale ? scale * 1e-3 : 1; mx += p; mn -= p; }
  const pad = (mx - mn) * 0.08; return { mn: mn - pad, mx: mx + pad };
}
function drawOnePlot(pl, dark) {
  const c = document.getElementById('pcv-' + pl.id);
  const leg = document.getElementById('pleg-' + pl.id);
  if (!c) return;
  // Nothing to draw into a zero/near-zero-width canvas (panel collapsed or not
  // yet laid out). Bail before the per-pixel bucketing below allocates an array
  // sized by (width - padding), which would be negative and throw.
  if (c.offsetWidth < 60) return;
  const t = live.t;
  const win = currentWindow();
  const { i0, i1 } = windowBounds(win);
  const series = plotSeries(pl);
  const H = plotHeight(pl);
  c.width = c.offsetWidth * 2; c.height = H * 2;
  const ctx = c.getContext('2d'); ctx.scale(2, 2);
  const W = c.offsetWidth;
  // Auto-fit each axis to the visible time window, then let an explicit
  // vertical zoom override it. The override is applied only to a side that
  // HAS series (auto-fit non-null), so a stale range can never conjure the
  // right-axis gutter onto a plot with no right-axis signal.
  let rl = axisRange(series, 'L', i0, i1), rr = axisRange(series, 'R', i0, i1);
  const yz = yZoom[pl.id];
  if (yz) { if (rl && yz.L) rl = yz.L; if (rr && yz.R) rr = yz.R; }
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = dark ? 'rgba(255,255,255,.12)' : 'rgba(0,0,0,.09)';
  ctx.fillStyle = '#898781'; ctx.font = '10px sans-serif';
  // Tick labels are formatted from the axis SPAN, not the values: zoomed into
  // 59.98–60.02 Hz, a fixed .toFixed(0) printed "60" five times over. The pads
  // then follow the widest label so a 6-decimal or 400000-size label isn't
  // clipped by a hardcoded gutter.
  const labL = rl ? tickLabels(rl) : null, labR = rr ? tickLabels(rr) : null;
  const widest = ls => ls.reduce((m, s) => Math.max(m, ctx.measureText(s).width), 0);
  const leftPad = labL ? Math.max(46, Math.ceil(widest(labL)) + 6) : 46;
  const rightPad = labR ? Math.max(44, Math.ceil(widest(labR)) + 8) : 6;
  const t0 = win.t0, t1w = win.t1, tspan = (t1w - t0) || 1;
  for (let i = 0; i <= 4; i++) {
    const y = 6 + (H - 26) * i / 4;
    ctx.beginPath(); ctx.moveTo(leftPad, y); ctx.lineTo(W - rightPad, y); ctx.stroke();
    if (labL) ctx.fillText(labL[i], 2, y + 3);
    if (labR) ctx.fillText(labR[i], W - rightPad + 3, y + 3);
  }
  for (let i = 0; i <= 6; i++) { const x = leftPad + (W - leftPad - rightPad) * i / 6; ctx.fillText((t0 + tspan * i / 6).toFixed(1) + 'ms', x - 12, H - 3); }
  series.forEach(s => {
    const r = s.axis === 'R' ? rr : rl;
    if (!r) return;
    ctx.strokeStyle = s.color; ctx.lineWidth = 1.3; ctx.setLineDash(s.dash);
    ctx.beginPath();
    const plotW = W - leftPad - rightPad;
    const yval = v => 6 + (H - 26) * (1 - (v - r.mn) / (r.mx - r.mn));
    if (i1 - i0 + 1 <= plotW) {
      // Zoomed in, or the visible window holds fewer samples than pixels:
      // draw every stored sample at full resolution.
      let started = false;
      for (let i = i0; i <= i1; i++) {
        const v = s.samples[i]; if (v === undefined) continue;
        const x = leftPad + plotW * (t[i] - t0) / tspan;
        if (!started) { ctx.moveTo(x, yval(v)); started = true; } else ctx.lineTo(x, yval(v));
      }
    } else {
      // Zoomed out: more samples than pixels. Per-pixel min/max downsampling
      // — for each output pixel column, draw the min-to-max range of the
      // samples that fall in it. A narrow spike inside a bucket shows up as a
      // vertical line at its true amplitude instead of being stepped over by
      // strided decimation. One pass to find each bucket's min/max, one pass
      // to stroke vertical segments connected across columns.
      const nBk = plotW;
      const mn = new Array(nBk), mx = new Array(nBk);
      for (let i = i0; i <= i1; i++) {
        const v = s.samples[i]; if (v === undefined) continue;
        let px = Math.floor((t[i] - t0) / tspan * nBk);
        if (px < 0) px = 0; else if (px >= nBk) px = nBk - 1;
        if (mn[px] === undefined) { mn[px] = v; mx[px] = v; }
        else { if (v < mn[px]) mn[px] = v; if (v > mx[px]) mx[px] = v; }
      }
      let started = false;
      for (let px = 0; px < nBk; px++) {
        if (mn[px] === undefined) continue;
        const x = leftPad + px + 0.5;
        if (!started) { ctx.moveTo(x, yval(mn[px])); ctx.lineTo(x, yval(mx[px])); started = true; }
        else { ctx.lineTo(x, yval(mn[px])); ctx.lineTo(x, yval(mx[px])); }
      }
    }
    ctx.stroke();
  });
  ctx.setLineDash([]);
  // The circuit has been edited since these samples were produced, so they
  // describe a model that no longer exists. Say so on the plot rather than
  // clearing it: while tuning a parameter the previous trace is exactly what
  // you want to see, it just must not be mistaken for the current answer.
  if (resultsStale()) {
    ctx.fillStyle = dark ? 'rgba(17,17,17,.62)' : 'rgba(255,255,255,.66)';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#898781'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('Circuit changed since this run. Press Run to update.', W / 2, H / 2 + 4);
    ctx.textAlign = 'left';
  }
  // Geometry snapshot so pointer/wheel handlers can invert screen -> time and
  // screen -> value. yTop/yH mirror the yval() mapping above, and rl/rr are the
  // ranges actually drawn (auto-fit or zoomed), which is what a gesture must
  // compose against.
  c._geom = { leftPad, rightPad, W, H, t0, t1: t1w, yTop: 6, yH: H - 26, rl, rr };
  if (!leg) return;
  // An auto plot that hit AUTO_MAX says so rather than silently dropping the
  // rest — the picker is where you go to choose which ones you actually want.
  const hidden = pl.auto ? autoKeysAll(pl.auto).length - series.length : 0;
  leg.innerHTML = series.length
    ? series.map(s => '<span style="color:' + s.color + '">■</span> ' + escAttr(seriesLabel(s))).join(' &nbsp; ')
      + (hidden > 0 ? ' &nbsp; <span style="opacity:.75">+ ' + hidden + ' more not shown (auto plots cap at '
        + AUTO_MAX + ': use “Signals” to pick)</span>' : '')
    : 'No signals: click “Signals” to add some.';
}
// '' (not 'A'/'B'/'C'/'DC') for a signal that isn't tied to any one phase —
// a 3-phase branch's total P/Q (SPEC §3): reported as one aggregate value,
// the conventional way 3-phase power is quoted, not per-phase like current.
function phaseLabel(d) { return d.dc ? 'DC' : (d.phase == null ? '' : PH_LBL[d.phase]); }

// The neutral channel: progress, solve summaries, confirmations. Anything that
// is a problem goes to showError/showWarn below instead, which is a band that
// wraps and persists rather than a one-line strip that ellipsises.
function setStatus(msg) {
  const el = document.getElementById('stat');
  if (el) el.textContent = msg;
}

// ---- notice band (errors and warnings) ----
// The solver's diagnostics are the best writing in this project: they name the
// offending block by id, explain the physical cause, and give the fix. They
// used to be assigned to #stat, the same one-line strip that carries
// "Running... 40%" and the solve summary, so a modelling mistake arrived in the
// same 12px of grey as routine progress and, once that line became single-line,
// was truncated with an ellipsis.
//
// showError/showWarn put the FULL text in a wrapping, colour-coded band that
// stays until it is dismissed or replaced. Never truncate here: the second half
// of "...set Fov and Fuv to 0, or place this relay on a full 3-phase node" is
// the half that tells you what to do.
// `sticky` marks a notice that a later successful run must NOT retract, because
// it is not a claim about whether the circuit runs. The case that forced this:
// a bad ?example= link complains and then lands on the working landing case, so
// the run that follows would clear the very message explaining the redirect.
// Only an explicit dismiss clears a sticky notice.
function setNotice(msg, level, sticky) {
  const box = document.getElementById('notice');
  const lab = document.getElementById('noticelab');
  const txt = document.getElementById('noticemsg');
  if (!box || !txt) return;
  txt.textContent = msg;
  if (lab) lab.textContent = level === 'warn' ? 'Warning' : 'Cannot run this circuit';
  box.className = 'notice on ' + (level === 'warn' ? 'warn' : 'err');
  box.dataset.sticky = sticky ? '1' : '';
  syncCanvasHeight(); onCanvasResize(); // the band changes the canvas top
}
function showError(msg, sticky) { setNotice(msg, 'err', sticky); }
function showWarn(msg, sticky) { setNotice(msg, 'warn', sticky); }
// force=true is the Dismiss button and anything else the user drove directly.
// force=false (the default, used at the start of a run) leaves sticky notices.
function clearNotice(force) {
  const box = document.getElementById('notice');
  if (!box || !box.classList.contains('on')) return;
  if (!force && box.dataset.sticky === '1') return;
  box.className = 'notice';
  box.dataset.sticky = '';
  syncCanvasHeight(); onCanvasResize();
}

// ---- data cursor ----
// "What is the voltage at t = 34 ms" is the question a transient simulator
// exists to answer, and until this the only way to get it was to export CSV and
// open a spreadsheet. A hairline at the nearest stored sample plus a readout of
// every visible series at that instant answers it in place.
//
// Snapped to a real sample, never interpolated: the value shown is one the
// solver actually produced, so it agrees with the CSV export to the last digit.
// At a coarse plot step the hairline visibly steps between samples, which is
// honest about the resolution rather than inventing points between them.
function hideCursor(pl) {
  const cur = document.getElementById('pcur-' + pl.id);
  const rd = document.getElementById('pread-' + pl.id);
  if (cur) cur.style.display = 'none';
  if (rd) rd.style.display = 'none';
}
function showCursor(pl, c, xCss) {
  const cur = document.getElementById('pcur-' + pl.id);
  const rd = document.getElementById('pread-' + pl.id);
  const g = c && c._geom;
  if (!cur || !rd) return;
  // No geometry means no axes (empty plot); no live.t means nothing was run.
  if (!g || !live || !live.t || !live.t.length) { hideCursor(pl); return; }
  const plotW = g.W - g.leftPad - g.rightPad;
  if (plotW <= 0 || xCss < g.leftPad || xCss > g.W - g.rightPad) { hideCursor(pl); return; }
  const t = g.t0 + (xCss - g.leftPad) / plotW * (g.t1 - g.t0);
  // Nearest sample within the drawn window. Linear scan over the window bounds
  // rather than a binary search: the window is already index-bounded and this
  // runs once per pointermove, not per frame of an animation.
  const { i0, i1 } = windowBounds({ t0: g.t0, t1: g.t1 });
  let bi = i0, bd = Infinity;
  for (let i = i0; i <= i1; i++) { const d = Math.abs(live.t[i] - t); if (d < bd) { bd = d; bi = i; } }
  const ts = live.t[bi];
  const x = g.leftPad + plotW * (ts - g.t0) / ((g.t1 - g.t0) || 1);
  cur.style.display = 'block';
  cur.style.left = Math.round(x) + 'px';
  cur.style.height = g.H + 'px';
  const series = plotSeries(pl);
  let h = '<span class="pr-t">t = ' + ts.toFixed(3) + ' ms</span>';
  if (!series.length) h += '<span class="pr-s">No signals on this plot.</span>';
  series.forEach(s => {
    const v = s.samples[bi];
    h += '<span class="pr-s"><span class="pr-sw" style="background:' + s.color + '"></span>'
      + escAttr(seriesLabel(s)) + ' <b>' + (v === undefined ? 'n/a' : sciNum(v, 4)) + '</b></span>';
  });
  rd.innerHTML = h;
  rd.style.display = 'block';
  // Flip to the left of the hairline when it would otherwise run off the card,
  // and clamp to the top so a tall readout on a short plot stays readable.
  const w = rd.offsetWidth, hh = rd.offsetHeight;
  rd.style.left = Math.round(x + 12 + w > g.W ? Math.max(0, x - 12 - w) : x + 12) + 'px';
  rd.style.top = Math.round(Math.max(0, Math.min(8, g.H - hh))) + 'px';
}

// Drag = box-select a time range to zoom into (rubber-band overlay, all
// plots share one time window — SPEC §3). Shift+drag = pan the current
// window. Wheel = zoom in/out centered on the cursor's time, like the
// schematic canvas. Rebinds after every renderPlots() since innerHTML
// replaces the canvases (drawAllPlots() alone does not, so no rebind needed
// between data updates within one plot-card layout).
function bindPlotInteractions() {
  document.querySelectorAll('#plots .cnvwrap2').forEach(wrap => {
    const c = wrap.querySelector('canvas.plot');
    const sel = wrap.querySelector('.selbox');
    const pl = S.plots.find(p => p.id === +c.id.slice(4));
    if (!pl) return;
    let drag = null; // {mode:'select'|'pan', x0,y0 (css px), startWin}
    const xToTime = clientX => {
      const g = c._geom; if (!g) return 0;
      const r = c.getBoundingClientRect();
      const frac = (clientX - r.left - g.leftPad) / (g.W - g.leftPad - g.rightPad);
      return g.t0 + frac * (g.t1 - g.t0);
    };
    const local = e => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    // The band drawn while dragging shows exactly which axes the release will
    // act on, so the mode is visible in the gesture itself rather than only in
    // the toolbar.
    const showBand = (a, b) => {
      const g = c._geom;
      const x0 = zoomMode === 'y' ? 0 : Math.min(a.x, b.x), x1 = zoomMode === 'y' ? g.W : Math.max(a.x, b.x);
      const y0 = zoomMode === 'x' ? 0 : Math.min(a.y, b.y), y1 = zoomMode === 'x' ? g.H : Math.max(a.y, b.y);
      sel.className = 'selbox ' + (zoomMode === 'x' ? 'sx' : zoomMode === 'y' ? 'sy' : '');
      sel.style.display = 'block';
      sel.style.left = x0 + 'px'; sel.style.width = (x1 - x0) + 'px';
      sel.style.top = y0 + 'px'; sel.style.height = (y1 - y0) + 'px';
    };
    c.addEventListener('pointerdown', e => {
      // Primary button only: a right-click is the browser's own context menu
      // ("Save image as…" on a canvas), and capturing the pointer for a zoom
      // drag that can never be completed would leave dangling drag state.
      if (e.button > 0) return;
      if (!c._geom) return;
      try { c.setPointerCapture(e.pointerId); } catch (err) { /* no active pointer session — drag still tracked via listeners */ }
      const p = local(e);
      if (e.shiftKey) {
        drag = { mode: 'pan', x0: p.x, y0: p.y, lastY: p.y, startWin: currentWindow() };
      } else {
        drag = { mode: 'select', x0: p.x, y0: p.y };
        showBand(p, p);
      }
    });
    c.addEventListener('pointermove', e => {
      if (!drag) return;
      const p = local(e), g = c._geom;
      if (drag.mode === 'pan') {
        if (zoomMode !== 'y') {
          const pxToMs = (g.t1 - g.t0) / (g.W - g.leftPad - g.rightPad);
          panZoom(drag.startWin.t0 - (p.x - drag.x0) * pxToMs, drag.startWin.t1 - (p.x - drag.x0) * pxToMs);
        }
        if (zoomMode !== 'x') {
          // Incremental (last frame -> this one) rather than from the drag
          // origin: panYBy composes onto g.rl/g.rr, which the redraw it
          // triggers has already moved.
          panYBy(pl, g, p.y - drag.lastY); updateZoomInfo(); drawAllPlots();
        }
        drag.lastY = p.y;
      } else showBand({ x: drag.x0, y: drag.y0 }, p);
    });
    // Data cursor. Separate listener from the drag one above so the two stay
    // independent: the drag handler returns early when there is no drag, which
    // is exactly when the cursor should be live.
    c.addEventListener('pointermove', e => {
      if (drag) { hideCursor(pl); return; } // the zoom band owns the pointer
      showCursor(pl, c, local(e).x);
    });
    c.addEventListener('pointerleave', () => hideCursor(pl));
    // A touch drag is a pan/zoom gesture, not a hover; leaving a cursor stuck
    // on screen after the finger lifts is worse than not showing one.
    c.addEventListener('pointerdown', e => { if (e.pointerType === 'touch') hideCursor(pl); });
    const endDrag = e => {
      if (!drag) return;
      const wasSelect = drag.mode === 'select', a = drag;
      drag = null;
      if (!wasSelect) return;
      sel.style.display = 'none';
      const p = local(e), g = c._geom; if (!g) return;
      let changed = false;
      if (zoomMode !== 'y' && Math.abs(p.x - a.x0) > 4) {
        const r = c.getBoundingClientRect();
        setZoom(xToTime(r.left + Math.min(a.x0, p.x)), xToTime(r.left + Math.max(a.x0, p.x)));
        changed = true;
      }
      if (zoomMode !== 'x' && setYZoomFromPixels(pl, g, a.y0, p.y)) changed = true;
      if (changed) { updateZoomInfo(); drawAllPlots(); }
    };
    c.addEventListener('pointerup', endDrag);
    c.addEventListener('pointercancel', endDrag);
    // Double-click clears this plot's vertical zoom — the per-plot counterpart
    // to the toolbar's Reset (which clears the shared time window too).
    c.addEventListener('dblclick', () => { if (clearYZoom(pl)) { updateZoomInfo(); drawAllPlots(); } });
    c.addEventListener('wheel', e => {
      const g = c._geom; if (!g) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
      if (zoomMode !== 'x') {
        zoomYAt(pl, g, e.clientY - c.getBoundingClientRect().top, factor);
        updateZoomInfo(); drawAllPlots();
      }
      if (zoomMode !== 'y') {
        const tAtCursor = xToTime(e.clientX), w = currentWindow();
        setZoom(tAtCursor - (tAtCursor - w.t0) / factor, tAtCursor + (w.t1 - tAtCursor) / factor);
      }
    }, { passive: false });
    bindPlotResizer(wrap.querySelector('.plotgrip'), pl, c);
  });
}
// Per-plot height grip, same gesture as the schematic canvas's: drag the tab
// under the plot, double-click to reset. Writes pl.h (persisted with the
// circuit) and resizes the canvas element directly so the redraw picks up the
// new height without rebuilding the card DOM (which would drop these bindings).
function bindPlotResizer(grip, pl, c) {
  if (!grip) return;
  let drag = null;
  grip.addEventListener('pointerdown', e => {
    e.preventDefault();
    try { grip.setPointerCapture(e.pointerId); } catch (err) { /* no active pointer session */ }
    drag = { y: e.clientY, h: plotHeight(pl) };
  });
  grip.addEventListener('pointermove', e => {
    if (!drag) return;
    pl.h = Math.max(PLOT_H_MIN, Math.min(PLOT_H_MAX, Math.round(drag.h + e.clientY - drag.y)));
    c.style.height = pl.h + 'px';
    if (live) drawOnePlot(pl, matchMedia('(prefers-color-scheme: dark)').matches);
  });
  const end = () => { drag = null; };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
  grip.addEventListener('dblclick', () => {
    delete pl.h;
    c.style.height = PLOT_H0 + 'px';
    if (live) drawOnePlot(pl, matchMedia('(prefers-color-scheme: dark)').matches);
  });
}

// ---- plot export: PNG figure / CSV data (SPEC §3) ----
// The browser's own "Save image as…" on a canvas hands back the RAW BITMAP:
// transparent background (drawOnePlot clears rather than fills, so the plot
// inherits the page's theme), no title, no legend — and it isn't offered at all
// in every embedded viewer. These write a finished figure instead, and a CSV of
// exactly the samples currently on screen, which right-click could never give.
function downloadBlob(blob, fname) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fname;
  a.click();
  URL.revokeObjectURL(a.href);
}
function exportName(pl, ext) {
  const base = (projName || 'openemt').replace(/\.json$/i, '') + '-' + (pl.title || 'plot');
  return base.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) + ext;
}
// Guard shared by both exporters: there is nothing to write before a run, or
// from a plot with no signals selected.
function exportable(id) {
  const pl = S.plots.find(p => p.id === id);
  const c = document.getElementById('pcv-' + id);
  const stat = document.getElementById('stat');
  if (!pl || !c) return null;
  if (!live || !live.t.length || !c._geom) { showWarn('Nothing to export yet: run the simulation first.'); return null; }
  const series = plotSeries(pl);
  if (!series.length) { showWarn('Plot “' + pl.title + '” has no signals to export: pick some with “Signals”.'); return null; }
  return { pl, c, series };
}
// PNG: the on-screen canvas composited onto an opaque themed background with a
// title, the plotted time window and a wrapped legend. drawImage of the live
// bitmap (rather than re-plotting into a second context) is what guarantees the
// figure is pixel-identical to what the user is looking at, zoom included.
function exportPlotPNG(id) {
  const ex = exportable(id); if (!ex) return;
  const { pl, c, series } = ex;
  const W = c.offsetWidth, H = plotHeight(pl), pad = 10, headH = 26, lineH = 15;
  const meas = document.createElement('canvas').getContext('2d');
  meas.font = '11px sans-serif';
  const lines = [[]];
  let lw = 0;
  series.forEach(s => {
    const e = { color: s.color, text: seriesLabel(s) };
    const w = meas.measureText(e.text).width + 24;
    if (lw + w > W - 2 * pad && lines[lines.length - 1].length) { lines.push([]); lw = 0; }
    lines[lines.length - 1].push(e); lw += w;
  });
  const legH = lines[0].length ? lines.length * lineH + 4 : 0;
  const totalH = headH + H + legH + pad;
  const out = document.createElement('canvas');
  out.width = W * 2; out.height = Math.round(totalH) * 2;
  const ctx = out.getContext('2d'); ctx.scale(2, 2);
  ctx.fillStyle = css('--sfc') || '#fff'; ctx.fillRect(0, 0, W, totalH);
  // Window text first: the title is a free-text field, so it gets whatever
  // width is left over and is ellipsized rather than allowed to run under it.
  const win = currentWindow();
  ctx.font = '11px sans-serif'; ctx.fillStyle = css('--tx3') || '#888';
  const wtxt = win.t0.toFixed(2) + ' to ' + win.t1.toFixed(2) + ' ms' + (tZoom ? ' (zoomed)' : '');
  const wtxtW = ctx.measureText(wtxt).width;
  ctx.fillText(wtxt, W - pad - wtxtW, 17);
  ctx.fillStyle = css('--tx') || '#000'; ctx.font = '600 13px system-ui,sans-serif';
  let title = pl.title || 'Plot';
  const maxTitleW = W - 2 * pad - wtxtW - 12;
  while (title.length > 1 && ctx.measureText(title).width > maxTitleW) title = title.slice(0, -2) + '…';
  ctx.fillText(title, pad, 17);
  ctx.drawImage(c, 0, headH, W, H);
  let y = headH + H + lineH;
  lines.forEach(row => {
    let x = pad;
    row.forEach(e => {
      ctx.fillStyle = e.color; ctx.fillRect(x, y - 8, 9, 9);
      ctx.fillStyle = css('--tx2') || '#444';
      ctx.fillText(e.text, x + 13, y);
      x += meas.measureText(e.text).width + 24;
    });
    y += lineH;
  });
  out.toBlob(b => downloadBlob(b, exportName(pl, '.png')), 'image/png');
}
// CSV: one row per stored sample inside the current TIME window (the vertical
// zoom is a display range, so it never filters data out), one column per
// plotted signal. Values go out at full precision — this is the raw solver
// output, not the pixel-bucketed form the plot draws when zoomed out.
function exportPlotCSV(id) {
  const ex = exportable(id); if (!ex) return;
  const { pl, series } = ex;
  const t = live.t, { i0, i1 } = windowBounds(currentWindow());
  const q = v => (/[",\n]/.test(v) ? '"' + String(v).replace(/"/g, '""') + '"' : v);
  const rows = ['t_ms,' + series.map(s => q(seriesLabel(s))).join(',')];
  for (let i = i0; i <= i1; i++) {
    // t is an accumulated multiple of dt, so it carries float noise
    // (119.94999999999999 for 119.95). 9 decimals is far finer than the 1 µs
    // minimum step and prints the intended value.
    let line = String(+t[i].toFixed(9));
    for (let k = 0; k < series.length; k++) { const v = series[k].samples[i]; line += ',' + (v === undefined ? '' : v); }
    rows.push(line);
  }
  downloadBlob(new Blob([rows.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' }), exportName(pl, '.csv'));
  const stat = document.getElementById('stat');
  if (stat) stat.textContent = 'Exported ' + (i1 - i0 + 1).toLocaleString() + ' samples × ' + series.length
    + ' signal(s) from “' + pl.title + '” (' + currentWindow().t0.toFixed(2) + ' to ' + currentWindow().t1.toFixed(2) + ' ms).';
}

// ---- plot management ----
function addPlot() { S.plots.push({ id: nextPlotId++, title: 'Plot ' + nextPlotId, auto: null, sigs: [] }); renderPlots(); }
function removePlot(id) { S.plots = S.plots.filter(p => p.id !== id); delete yZoom[id]; if (pickerPlot === id) closePicker(); renderPlots(); }
function renamePlot(id, title) { const pl = S.plots.find(p => p.id === id); if (pl) pl.title = title; }

// ---- signal picker (grouped tree + filter + per-signal L/R axis) ----
let pickerPlot = null, pickerBtn = null, pickerFilter = '';
function ensureExplicit(pl) { if (pl.auto) { pl.sigs = autoKeys(pl.auto).map(key => ({ key, axis: 'L' })); pl.auto = null; } }
function openPicker(plotId, btn) {
  pickerPlot = plotId; pickerBtn = btn || pickerBtn;
  const pl = S.plots.find(p => p.id === plotId);
  const pop = document.getElementById('picker');
  const sel = new Map(plotSelection(pl).map(s => [s.key, s.axis || 'L']));
  const groups = {};
  Object.values(sigIndex).forEach(s => (groups[s.groupKey] || (groups[s.groupKey] = { label: s.group, sigs: [] })).sigs.push(s));
  let h = '<div class="pickhead"><input id="pickfilter" placeholder="filter blocks…" value="' + escAttr(pickerFilter)
    + '" oninput="filterPicker(this.value)"><button onclick="closePicker()">Done</button></div><div class="picktree">';
  if (!Object.keys(groups).length) h += '<div class="hint" style="padding:8px">Run the simulation to list signals.</div>';
  Object.keys(groups).forEach(gk => {
    const g = groups[gk], allOn = g.sigs.every(s => sel.has(s.key));
    h += '<div class="pgroup" data-g="' + escAttr(g.label.toLowerCase()) + '">'
      + '<label class="pgrouphd"><input type="checkbox"' + (allOn ? ' checked' : '')
      + ' onchange="toggleGroup(' + plotId + ',\'' + gk + '\',this.checked)"> <b>' + g.label + '</b></label>';
    g.sigs.forEach(s => {
      const on = sel.has(s.key);
      h += '<div class="prow"><label><input type="checkbox"' + (on ? ' checked' : '')
        + ' onchange="toggleSig(' + plotId + ',\'' + s.key + '\',this.checked)"> '
        + (live && live.nph > 1 && phaseLabel(s) ? phaseLabel(s) + ' · ' : '') + s.unit + '</label>'
        + '<span class="axtog"' + (on ? '' : ' style="visibility:hidden"') + '>'
        + '<button class="' + (sel.get(s.key) !== 'R' ? 'on' : '') + '" onclick="setAxis(' + plotId + ',\'' + s.key + '\',\'L\')">L</button>'
        + '<button class="' + (sel.get(s.key) === 'R' ? 'on' : '') + '" onclick="setAxis(' + plotId + ',\'' + s.key + '\',\'R\')">R</button>'
        + '</span></div>';
    });
    h += '</div>';
  });
  h += '</div>';
  pop.innerHTML = h;
  const r = pickerBtn.getBoundingClientRect(), er = document.querySelector('.emt').getBoundingClientRect();
  pop.style.display = 'block';
  pop.style.left = Math.max(0, r.right - er.left - 240) + 'px';
  pop.style.top = (r.bottom - er.top + 4) + 'px';
  filterPicker(pickerFilter);
}
function reopenPicker() { if (pickerPlot != null) openPicker(pickerPlot, pickerBtn); }
function filterPicker(v) {
  pickerFilter = v;
  const q = v.toLowerCase();
  document.querySelectorAll('#picker .pgroup').forEach(g => { g.style.display = g.dataset.g.includes(q) ? '' : 'none'; });
}
function toggleSig(plotId, key, on) {
  const pl = S.plots.find(p => p.id === plotId); ensureExplicit(pl);
  pl.sigs = pl.sigs.filter(s => s.key !== key);
  if (on) pl.sigs.push({ key, axis: 'L' });
  drawAllPlots(); reopenPicker();
}
function toggleGroup(plotId, gk, on) {
  const pl = S.plots.find(p => p.id === plotId); ensureExplicit(pl);
  const keys = Object.values(sigIndex).filter(s => s.groupKey === gk).map(s => s.key);
  pl.sigs = pl.sigs.filter(s => !keys.includes(s.key));
  if (on) keys.forEach(key => pl.sigs.push({ key, axis: 'L' }));
  drawAllPlots(); reopenPicker();
}
function setAxis(plotId, key, axis) {
  const pl = S.plots.find(p => p.id === plotId); ensureExplicit(pl);
  const s = pl.sigs.find(x => x.key === key); if (s) { s.axis = axis; drawAllPlots(); reopenPicker(); }
}
function closePicker() { const p = document.getElementById('picker'); if (p) p.style.display = 'none'; pickerPlot = null; }

// sync entry point (solver.js runEMT / headless test hook): full-array result.
// probeMeta/curMeta (with the DC flag — SPEC §3) are passed through from
// simulate()'s return value when available; fall back to deriving a
// (non-DC-aware) shape so this still works if ever called without them.
function drawPlots(t, probes, vp, curEls, ic, nph, probeMeta, curMeta, Tms, bv, freqHz, aux, tv, fp) {
  const pMeta = probeMeta || probes.map(p => ({ id: p.b.id, dc: false }));
  const cMeta = curMeta || curEls.map((e, i) => ({ id: e.b.id, type: e.b.type, kind: e.kind, np: ic[i].length, dc: false }));
  ingestMeta({ probes: pMeta, curMeta: cMeta, nph, Tms: Tms || (t[t.length - 1] || 0), freqHz });
  live.t = t; live.vp = vp; live.ic = ic;
  if (bv) live.bv = bv;
  if (aux) live.aux = aux;
  if (fp) live.fp = fp;
  if (tv) live.tv = tv;
  computeFlowDirs(); render();
  renderPlots();
}

// ---- live (Worker-backed) run: streams plot data as it's computed so the
// UI stays responsive and long durations don't freeze the tab. Falls back
// to the synchronous runEMT() (solver.js) if Workers aren't available. ----
let simWorker = null;
function getWorker() {
  if (!simWorker) {
    const blob = new Blob([WORKER_SRC], { type: 'application/javascript' });
    simWorker = new Worker(URL.createObjectURL(blob));
  }
  return simWorker;
}
function setRunning(running) {
  const runBtn = document.getElementById('runbtn'), stopBtn = document.getElementById('stopbtn');
  if (runBtn) runBtn.disabled = running;
  if (stopBtn) stopBtn.disabled = !running;
  syncFab(running); // the sticky control mirrors whichever action is live
}
// Solve the steady-state power flow and annotate the canvas. Standalone action
// (the ⚖ Power flow button); Run uses the same solve to initialize when "Init
// from PF" is checked (see runEMTLive).
function solvePF() {
  const stat = document.getElementById('stat');
  clearNotice(); // a new attempt supersedes the previous complaint
  const r = solvePowerFlow();
  if (r.err) { showError('Power flow: ' + r.err); return; }
  window.pfResult = r; window.pfShow = true;
  // Summarize busBlocks, NOT r.buses: every pu in r.buses is divided by the
  // single slack-derived Vnom, so on a multi-voltage circuit (which is every
  // imported transmission case) the status line used to read something like
  // "0.059 to 1.000 pu" and invent a count of buses outside the band, while the
  // canvas annotations beside it — which use each bus's own Vbase — were right.
  const live = r.busBlocks.filter(b => !b.dead);
  const vs = live.map(b => b.Vpu);
  const out = live.filter(b => b.Vpu < b.Vlo || b.Vpu > b.Vhi).length;
  let totP = 0, totQ = 0; r.genInit.forEach(g => { totP += g.pf.P; totQ += g.pf.Q; });
  stat.textContent = 'Power flow ' + (r.converged ? 'converged' : 'did NOT converge') +
    ' (' + (r.method || 'gs').toUpperCase() + ', ' + r.iters + ' iters, mismatch ' +
    r.maxMismatch.toExponential(1) + ' ' + (r.unit || 'pu') + '). Gen ' +
    (totP / 1e6).toFixed(0) + ' MW / ' + (totQ / 1e6).toFixed(0) + ' Mvar' +
    (vs.length ? '; bus V ' + Math.min(...vs).toFixed(3) + ' to ' + Math.max(...vs).toFixed(3) + ' pu' +
      (out ? '; ' + out + ' bus(es) outside their Vhi/Vlo band' : '; all within band') : '') +
    '.' + (r.note ? ' ' + r.note : '');
  render();
}

function runEMTLive() {
  if (typeof Worker === 'undefined') { runEMT(); return; } // no Worker support: synchronous fallback
  clearNotice(); // a new attempt supersedes the previous complaint

  const stat = document.getElementById('stat');
  const nph = +document.getElementById('phmode').value;
  const durEl = document.getElementById('duration');
  const Tms = (durEl && +durEl.value > 0) ? +durEl.value : 120;
  const dtEl = document.getElementById('dtus');
  const dtUs = (dtEl && +dtEl.value > 0) ? +dtEl.value : 50;
  const plotEl = document.getElementById('plotus');
  const plotUs = (plotEl && +plotEl.value > 0) ? +plotEl.value : 0;

  // Initialize from power flow so the run starts at the operating point instead
  // of swinging in from a cold start. solvePowerFlow() writes pfInit onto the
  // blocks, which ride along in the postMessage below; the worker's machine
  // factories honor it. Unchecked (or on failure) clears any stale init so it's
  // a clean cold start.
  const pfEl = document.getElementById('pfinit');
  if (pfEl && pfEl.checked) {
    const pr = solvePowerFlow();
    if (pr.err || !pr.converged) { clearPowerFlowInit(); window.pfShow = false; }
    else { window.pfResult = pr; window.pfShow = true; }
  } else { clearPowerFlowInit(); }

  let w;
  try { w = getWorker(); } catch (e) { runEMT(); return; } // e.g. blocked by CSP: fall back

  setRunning(true);
  stat.textContent = 'Running…';

  w.onmessage = ev => {
    const m = ev.data;
    if (m.type === 'chunk') {
      const c = m.chunk;
      if (c.meta) { ingestMeta(c.meta); renderPlots(); return; } // rebuild registry + cards once
      if (!live) return;
      live.t.push(...c.t);
      c.vp.forEach((pr, pi) => pr.forEach((ph, p) => live.vp[pi][p].push(...ph)));
      c.ic.forEach((sig, ci) => sig.forEach((ph, p) => live.ic[ci][p].push(...ph)));
      c.bv.forEach((sig, ci) => sig.forEach((ph, p) => live.bv[ci][p].push(...ph)));
      if (c.tv) c.tv.forEach((sig, ci) => { if (sig && live.tv[ci]) sig.forEach((ph, p) => live.tv[ci][p].push(...ph)); });
      if (c.aux) c.aux.forEach((a, ci) => { if (a && live.aux[ci]) live.aux[ci].push(...a); });
      if (c.fp) c.fp.forEach((a, pi) => { if (a && live.fp[pi]) live.fp[pi].push(...a); });
      stat.textContent = 'Running… ' + Math.round((c.progress || 0) * 100) + '%';
      computeFlowDirs(); render();
      drawAllPlots();
      updatePlotStepInfo();
    } else if (m.type === 'done') {
      computeFlowDirs(); render();
      updatePlotStepInfo();
      stat.textContent = m.stat; setRunning(false);
      revealPlots();
    } else if (m.type === 'error') {
      // The status line is left mid-progress ("Running… 40%") when the worker
      // reports a failure, so it has to be retired explicitly. Leaving it is
      // worse than blank: it says the run is still going while the band below
      // says it cannot run at all.
      showError(m.message); stat.textContent = 'Run stopped: see the message above.';
      setRunning(false);
    }
  };
  w.onerror = ev => { showError('Worker error: ' + ev.message); setRunning(false); };


  w.postMessage({ blocks: S.blocks, wires: S.wires, vconv: S.vconv, nph, Tms, dtUs, plotUs });
}
function stopSim() {
  if (simWorker) { simWorker.terminate(); simWorker = null; }
  setRunning(false);
  document.getElementById('stat').textContent = 'Stopped.';
}

// After a run finishes, make sure some waveform is actually on screen. The
// canvas is sized (autoCanvasHeight) so this is usually already true; this is
// the backstop for the cases sizing cannot cover, such as a persisted grip
// height, a very short window, or the user having scrolled up mid-run.
//
// Deliberately conservative: it only scrolls when LESS THAN a readable strip of
// the first plot is showing, and it scrolls the minimum distance rather than
// centring the plot. Yanking the viewport out from under someone who is looking
// at the schematic is worse than the problem being solved.
const PLOT_VISIBLE_MIN = 120; // px of WAVEFORM that counts as "you can see it"
function revealPlots() {
  // Measure the plot canvas, not the card. The card's top 35px or so is its
  // title row and its bottom is the legend, so aiming at the card left only
  // 55px of actual trace on a phone: technically visible, not actually useful.
  const card = document.querySelector('#plots canvas.plot')
    || document.querySelector('#plots .chartcard');
  if (!card || typeof card.getBoundingClientRect !== 'function') return;
  const r = card.getBoundingClientRect();
  if (!r.height) return;
  const shown = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
  if (shown >= Math.min(PLOT_VISIBLE_MIN, r.height)) return; // enough already
  const want = Math.min(PLOT_VISIBLE_MIN, r.height);
  const by = Math.round(r.top - (window.innerHeight - want));
  if (by <= 0) return;
  // Smooth only when motion is welcome. Two reasons, one of which is not
  // accessibility: a smooth scroll is driven by the compositor, so in any
  // context that is not painting (a hidden tab, an automated browser) it is
  // silently a no-op and the backstop quietly does nothing. An instant scroll
  // always lands.
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.scrollBy({ top: by, behavior: reduce ? 'auto' : 'smooth' });
}

// ---- demo circuit ----
// autorun=false is used when arriving from a bad ?example= link: the demo's
// auto-run finishes ~400 ms later and overwrites the status line, so the
// explanation of why the link did not work would vanish before it was read.
function loadDemo(autorun = true) {
  const s1 = addBlock('src', 30, 120);
  const bk = addBlock('brk', 160, 126);
  const l1 = addBlock('line', 280, 126);
  const ld = addBlock('rlc', 430, 124);
  ld.params.R = 12; ld.params.L = -1; ld.params.C = -1;
  const g1 = addBlock('gnd', 78, 230);
  const g2 = addBlock('gnd', 478, 230);
  const p1 = addBlock('probe', 380, 40);
  S.wires.push({ a: [s1.id, 1], b: [bk.id, 0] });
  S.wires.push({ a: [bk.id, 1], b: [l1.id, 0] });
  S.wires.push({ a: [l1.id, 1], b: [ld.id, 0] });
  S.wires.push({ a: [s1.id, 0], b: [g1.id, 0] });
  S.wires.push({ a: [ld.id, 1], b: [g2.id, 0] });
  S.wires.push({ a: [p1.id, 0], b: [l1.id, 1] });
  history = []; future = []; updateUndoButtons(); // bootstrap circuit, not a user action — start with a clean undo stack
  setProj('Demo', false);
  render();
  if (autorun) setTimeout(runEMTLive, 400);
}
initPlots();
zoomMode = ['x', 'y', 'box'].includes(localStorage.getItem('emt_zoommode')) ? localStorage.getItem('emt_zoommode') : 'x';
syncZoomModeUI();
renderPlots();
syncWideUI(); // apply persisted Wide (fluid-width) preference before first layout
syncCanvasHeight(); // apply persisted canvas height before the first aspect sync below
bindCanvasResizer();
buildLibrary(); // populate the left Library drawer once (DEFS is static)
syncLibraryUI(); // apply persisted Library (left sidebar) preference before first layout
syncParamsUI(); // apply persisted Params-rail visibility preference
syncScienceUI(); // apply persisted Science-rail visibility preference
syncAboutUI(); // show the description unless this visitor dismissed it before
syncFab(false); // sticky Run starts in its Run state
bindFab(); // ...and appears only once the real Run button scrolls away
buildExamplesMenu(); // populate the Examples picker from the embedded set
bootFromUrl(); // ?example=<name> if present and known, else the Demo circuit
onCanvasResize(); // sync the camera to the element's real aspect (VIEW0's 680:340 is only nominal)
