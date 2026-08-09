#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Hiva Nasiri. Commercial licensing: see LICENSING.md
// api/mcp-server.js - stateful MCP server exposing OpenEMT to AI agents.
//
// Speaks JSON-RPC over stdio per the Model Context Protocol (Anthropic's open
// spec). One OpenEMT instance is held per connection as "the current
// circuit", so an agent builds and refines a case across many tool calls the
// same way a user does in the UI, then runs power flow / simulation and
// queries results by block ID.
//
// Register with a client (Claude Code, Cursor, ...) by adding to its MCP
// config, e.g. .claude/mcp.json:
//   { "mcpServers": { "openemt": { "command": "node",
//       "args": ["C:/dev/OpenEMT/api/mcp-server.js"] } } }
//
// Tool schemas for block parameters are generated from DEFS in src/blocks.js,
// so the agent always sees the real param names, defaults, and labels with no
// hand-maintained duplication.

'use strict';

const { Server } = require('@modelcontextprotocol/sdk/server');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { OpenEMT } = require('./core.js');

const em = new OpenEMT();

// Compact JSON text content (token-cheap for the agent).
function ok(obj) { return { content: [{ type: 'text', text: JSON.stringify(obj) }] }; }
function err(msg) { return { isError: true, content: [{ type: 'text', text: String(msg) }] }; }

// Build a human-readable param spec for an add_block schema description, so
// the agent learns each block's params without a separate call.
function paramSpec() {
  return em.catalog().map(b => ({
    type: b.type, label: b.label, terms: b.terms,
    params: b.params,
  }));
}
const BLOCK_TYPES = () => em.catalog().map(b => b.type);

const TOOLS = [
  {
    name: 'list_blocks',
    description: 'List every OpenEMT block type with its parameters (name, default, label) and terminal count. Call this first to learn what blocks exist and what params each accepts.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_examples',
    description: 'List the shipped example circuits (examples/*.json) by name.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'load_example',
    description: 'Load a shipped example circuit as the current circuit. Replaces any current circuit.',
    inputSchema: {
      type: 'object', required: ['name'],
      properties: { name: { type: 'string', description: 'Example name from list_examples (with or without .json).' } },
    },
  },
  {
    name: 'load_circuit',
    description: 'Load a circuit as the current circuit, replacing any current circuit. Accepts either a full circuit object ({webemt:1, blocks, wires}) or a path to a .json file. Unknown block types are rejected; missing params are backfilled with defaults.',
    inputSchema: {
      type: 'object',
      properties: {
        circuit: { type: 'object', description: 'A full circuit object {webemt:1, blocks:[{id,type,x,y,rot,params}], wires:[{a:[blockId,termIdx],b:[blockId,termIdx]}]}.' },
        file: { type: 'string', description: 'Path to a circuit .json file.' },
      },
    },
  },
  {
    name: 'import_case',
    description: 'Import an external power-system case (currently PSS/E RAW, revisions 30-36) and load it as the current circuit, replacing any current circuit. Buses/loads/generators/branches/2-winding transformers/fixed shunts are converted to OpenEMT blocks; generators become synchronous machines with GENERIC placeholder dynamics (a RAW file carries no dynamic data). Returns block/wire counts, conversion metadata, and a warnings array. Three-winding transformers, switched shunts, and DYR data are not imported.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path to a PSS/E .raw file.' },
        text: { type: 'string', description: 'Raw .raw file contents (alternative to file).' },
      },
    },
  },
  {
    name: 'get_circuit',
    description: 'Return the current circuit {webemt:1, blocks, wires}.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'reset_circuit',
    description: 'Clear the current circuit to empty.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'set_vconv',
    description: 'Set the voltage convention for AC source/bus params: "ph" (phase RMS, legacy, the default for a fresh circuit) or "ll" (line-to-line RMS). In LL the solver divides 3-ph source/bus voltages and UVLO thresholds by sqrt(3) internally; 1-ph is unaffected (line = phase). DC voltages, peak clamps, and currents are not affected. Setting this reinterprets existing param values, it does not convert them, so set it before entering voltages. Call get_circuit to see the active convention.',
    inputSchema: {
      type: 'object', required: ['vconv'],
      properties: { vconv: { type: 'string', enum: ['ph', 'll'], description: 'Phase RMS (legacy) or line-to-line RMS.' } },
    },
  },
  {
    name: 'add_block',
    description: 'Add a block to the current circuit. ID is auto-assigned and returned. Use list_blocks for the params each block type accepts; only pass the params you want to override (defaults are filled in).',
    inputSchema: {
      type: 'object', required: ['type'],
      properties: {
        type: { type: 'string', enum: BLOCK_TYPES, description: 'Block type (see list_blocks).' },
        params: { type: 'object', additionalProperties: true, description: 'Parameter overrides; defaults are filled for anything omitted.' },
        x: { type: 'number' }, y: { type: 'number' }, rot: { type: 'number' },
      },
    },
  },
  {
    name: 'add_wire',
    description: 'Wire two block terminals together. Each endpoint is [blockId, terminalIndex]. Terminal indices match the order in list_blocks (terms count).',
    inputSchema: {
      type: 'object', required: ['aBlockId', 'aTerm', 'bBlockId', 'bTerm'],
      properties: {
        aBlockId: { type: 'integer' }, aTerm: { type: 'integer' },
        bBlockId: { type: 'integer' }, bTerm: { type: 'integer' },
      },
    },
  },
  {
    name: 'remove_block',
    description: 'Remove a block (and any wires touching it) from the current circuit by ID.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
  },
  {
    name: 'run_power_flow',
    description: 'Solve the positive-sequence power flow of the current circuit. Returns bus table (node, Vmag, Vpu, ang, type) and per-machine pfInit. Optionally override bus types by block ID.',
    inputSchema: {
      type: 'object',
      properties: {
        busType: { type: 'object', additionalProperties: { type: 'string', enum: ['slack', 'PV', 'PQ'] }, description: 'Optional {blockId: "slack"|"PV"|"PQ"} overrides of block pfType.' },
      },
    },
  },
  {
    name: 'run_simulation',
    description: 'Run a time-domain simulation of the current circuit. Returns a runId and the list of queryable signals (by block ID, with V and/or I available). Keep the result and call query_results with the runId to read voltages/currents/powers. Every option below defaults to the loaded circuit file\'s own saved run settings, so a shipped example runs its intended study without being told the duration; pass an option only to override it. For machine initialization, call run_power_flow first so the run starts at the operating point instead of swinging in cold: this tool never solves it for you, and warns when the file asks for it and you have not.',
    inputSchema: {
      type: 'object',
      properties: {
        nph: { type: 'integer', description: 'Phase count: 3 for AC machines/converters, 1 for simple DC/1-ph. Default: the file\'s saved setting, else 3.' },
        Tms: { type: 'number', description: 'Duration in ms. Default: the file\'s saved setting, else 120.' },
        dtUs: { type: 'number', description: 'Solver time step in microseconds. Default: the file\'s saved setting, else 50.' },
        plotUs: { type: 'number', description: 'Plot decimation in microseconds (0 = auto). Default: the file\'s saved setting, else 0.' },
      },
    },
  },
  {
    name: 'query_results',
    description: 'Query a signal from a simulation run by BLOCK ID (never positional index). Signals: V (instantaneous voltage, probe/bus), Vrms, I (instantaneous branch current), Irms, P, Q. By default returns only the steady-state (last-cycle average) per phase to keep output small; set tail=false to get the full per-phase time series.',
    inputSchema: {
      type: 'object', required: ['blockId', 'signal'],
      properties: {
        blockId: { type: 'integer', description: 'Block ID to query (see the signals list from run_simulation).' },
        signal: { type: 'string', enum: ['V', 'Vrms', 'I', 'Irms', 'P', 'Q'] },
        runId: { type: 'integer', description: 'Run ID from run_simulation. Defaults to the most recent run.' },
        tail: { type: 'boolean', default: true, description: 'If true (default), return only steady-state per phase; if false, return full per-phase series.' },
      },
    },
  },
];

async function handleCall(req) {
  const a = req.params.arguments || {};
  let r;
  try {
    switch (req.params.name) {
      case 'list_blocks': r = ok(em.catalog()); break;
      case 'list_examples': r = ok(em.listExamples()); break;
      case 'load_example': {
        const lr = em.loadExample(a.name);
        if (lr && lr.err) r = err(lr.err); else r = ok(lr);
        break;
      }
      case 'load_circuit': {
        if (!a.circuit && !a.file) { r = err('Provide either "circuit" (object) or "file" (path).'); break; }
        const lr = em.loadCircuit(a.circuit || a.file);
        if (lr && lr.err) r = err(lr.err); else r = ok(lr);
        break;
      }
      case 'import_case': {
        if (!a.file && !a.text) { r = err('Provide either "file" (path to a .raw) or "text" (raw contents).'); break; }
        const ir = em.importCase(a.file || a.text);
        if (ir && ir.err) r = err(ir.err); else r = ok(ir);
        break;
      }
      case 'get_circuit': r = ok(em.getCircuit()); break;
      case 'reset_circuit': em.reset(); r = ok({ reset: true }); break;
      case 'set_vconv': r = ok({ vconv: em.setVconv(a.vconv) }); break;
      case 'add_block': {
        try {
          const id = em.addBlock(a.type, a.params, { x: a.x, y: a.y, rot: a.rot });
          r = ok({ id });
        } catch (e) { r = err(e.message); }
        break;
      }
      case 'add_wire': {
        const n = em.addWire(a.aBlockId, a.aTerm, a.bBlockId, a.bTerm);
        r = ok({ wires: n });
        break;
      }
      case 'remove_block': em.removeBlock(a.id); r = ok({ removed: a.id }); break;
      case 'run_power_flow': {
        const pf = em.runPowerFlow({ busType: a.busType });
        if (pf && pf.err) r = err(pf.err); else r = ok(pf);
        break;
      }
      case 'run_simulation': {
        const sim = em.runSimulation({ nph: a.nph, Tms: a.Tms, dtUs: a.dtUs, plotUs: a.plotUs });
        if (sim && sim.err) r = err(sim.err);
        else r = ok({
          runId: sim.runId, stat: sim.stat, nph: sim.nph, Tms: sim.Tms, freqHz: sim.freqHz,
          nT: sim.nT, tStart: sim.tStart, tEnd: sim.tEnd,
          settingsFrom: sim.settingsFrom, warnings: sim.warnings,
          signals: sim.signals.map(s => ({ blockId: s.blockId, hasV: !!s.hasV, hasI: !!s.hasI, kind: s.kind || null, np: s.np || null })),
        });
        break;
      }
      case 'query_results': {
        const q = em.query(a.blockId, a.signal, { runId: a.runId });
        if (q && q.err) { r = err(q.err); break; }
        if (a.tail === false) r = ok(q);
        else r = ok({ blockId: q.blockId, signal: q.signal, kind: q.kind || null, phases: q.phases, steadyState: q.steadyState });
        break;
      }
      default: r = err('Unknown tool: ' + req.params.name);
    }
  } catch (e) {
    r = err(e && (e.stack || e.message) || String(e));
  }
  return r;
}

async function main() {
  const server = new Server(
    { name: 'openemt', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, handleCall);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(e => { console.error('openemt MCP server failed:', e); process.exit(1); });