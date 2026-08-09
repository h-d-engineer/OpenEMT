#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Hiva Nasiri. Commercial licensing: see LICENSING.md
"""Assemble standalone index.html from src/. Run: python3 build.py"""
import json
import pathlib
root = pathlib.Path(__file__).parent
src = root / 'src'
shell = (src / 'shell.html').read_text(encoding='utf-8')
blocks_js = (src / 'blocks.js').read_text(encoding='utf-8')
solver_js = (src / 'solver.js').read_text(encoding='utf-8')
import_js = (src / 'import.js').read_text(encoding='utf-8')

# Worker script = blocks.js + solver.js (both pure, no DOM refs) + a small
# bootstrap. `simulate()` in solver.js is the shared numeric core: this is
# the ONLY place its output is streamed cross-thread, so the bootstrap must
# only postMessage plain data (never live element objects, which hold
# closures postMessage cannot clone). See SPEC.md section 1.
worker_bootstrap = """
var S = { blocks: [], wires: [] };
self.onmessage = function (ev) {
  try {
    var d = ev.data;
    S.blocks = d.blocks; S.wires = d.wires; S.vconv = (d.vconv === 'll') ? 'll' : 'ph';
    var r = simulate(d.nph, d.Tms, function (chunk) { self.postMessage({ type: 'chunk', chunk: chunk }); }, d.dtUs, d.plotUs);
    if (r && r.err) { self.postMessage({ type: 'error', message: r.err }); return; }
    self.postMessage({ type: 'done', stat: r.stat });
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.stack) || err) });
  }
};
"""
worker_src = blocks_js + '\n' + solver_js + '\n' + worker_bootstrap

out = (shell
       .replace('/*__BLOCKS_JS__*/', blocks_js)
       .replace('/*__SOLVER_JS__*/', solver_js)
       .replace('/*__IMPORT_JS__*/', import_js)
       .replace('/*__UI_JS__*/', (src / 'ui.js').read_text(encoding='utf-8'))
       .replace('/*__WORKER_SRC__*/', json.dumps(worker_src)))
# newline='\n' is deliberate: write_text() defaults to text mode, which on
# Windows translates '\n' to '\r\n'. That made every build emit CRLF while the
# repo stores LF (.gitattributes), so a rebuild always showed index.html as
# modified with a phantom line-ending-only diff. Writing LF explicitly keeps
# the build byte-identical on Windows, macOS, and Linux.
# index.html is the artifact users actually receive: a single file, often saved
# and passed around detached from the repository. If it ships without the
# licence notice, the thing in the user's hands carries no licence at all. The
# notice lives in src/shell.html (so it cannot drift from an injected copy) and
# this guard fails the build loudly if it ever stops arriving.
#
# It deliberately checks the notice BLOCK, in the file's opening bytes, and not
# the bare SPDX tag. Every module under src/ carries its own SPDX header, so
# those tags are concatenated into the bundle regardless; a guard looking for
# one would pass even with the top-level notice deleted, which is exactly the
# failure it exists to catch. First version of this guard had that bug.
HEAD = out[:2000]
for required in ('SPDX-License-Identifier: AGPL-3.0-only',
                 'Copyright (C) 2026 Hiva Nasiri',
                 'GNU\n  Affero General Public License, version 3 only'):
    if required not in HEAD:
        raise SystemExit(
            f'BUILD ABORTED: {required!r} missing from the first 2000 bytes of index.html.\n'
            'The licence notice must survive into the distributed artifact and must be\n'
            'visible at the top of it. Restore the comment block after <!DOCTYPE html>\n'
            'in src/shell.html.')

with open(root / 'index.html', 'w', encoding='utf-8', newline='\n') as f:
    f.write(out)
print(f'index.html written ({len(out):,} bytes, licence notice present)')
