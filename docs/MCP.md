# Connecting an agent to the OpenEMT MCP server

OpenEMT ships an MCP server (`api/mcp-server.js`) that exposes the solver core
to AI agents over the Model Context Protocol. Once connected, an agent can
build a circuit block by block, wire terminals, run steady-state power flow and
time-domain simulations, and query voltages, currents, and powers by block ID,
the same operations the UI exposes. One OpenEMT instance is held per
connection as "the current circuit", so an agent refines a case across many
tool calls the way a user does in the canvas.

There are two ways to run it: **from npm**, which needs no clone and is what
most users want, or **from a clone**, which is what you want if you are editing
the solver. The npm route is below; everything from "Prerequisites" onward
describes the clone route.

## From npm (no clone)

The package publishes a second binary, `openemt-mcp`, so any MCP client can
spawn the server by name. There is nothing to install and no absolute path to
get wrong:

```json
{
  "mcpServers": {
    "openemt": {
      "command": "npx",
      "args": ["-y", "--package", "@openemt/openemt", "openemt-mcp"]
    }
  }
}
```

Both flags are load-bearing. `-y` skips the "install this package?" prompt,
which a client spawning a subprocess cannot answer. `--package` is required
because the package ships **two** binaries, `openemt` and `openemt-mcp`: with
more than one, npx runs only the bin whose name matches the package, so a plain
`npx -y @openemt/openemt` starts the CLI, and naming a bin without `--package`
fails with "could not determine executable to run".

The first launch downloads the package and takes a few seconds; later launches
use the npm cache. Pin a version with `@openemt/openemt@0.1.1` if you want a
client's behaviour frozen. To avoid the download entirely,
`npm install -g @openemt/openemt` once and then use
`"command": "openemt-mcp", "args": []`.

This works in every client below. Use it unless you are developing OpenEMT
itself, in which case the clone route runs your working tree instead of the
published release.

## Prerequisites

*(clone route only)*

1. **Node.js >= 18** on PATH. Verify with `node --version`.
2. **Install dependencies.** The repo tracks `package.json` and
   `package-lock.json` but not `node_modules/`, so after cloning run:
   ```
   npm install
   ```
   This pulls `@modelcontextprotocol/sdk` (the MCP runtime) and `commander`
   (the CLI). If you skip this step, `api/mcp-server.js` crashes on startup
   with a missing-module error.

The server is cwd-independent: `api/core.js` resolves `src/` via
`path.resolve(__dirname, '..', 'src')` and `api/mcp-server.js` loads core via
`require('./core.js')`, both relative to the module file location, not the
process working directory. So you can point any client at the absolute path
to `api/mcp-server.js` and it will run regardless of where the client spawns
it.

## Per-client setup (clone route)

Every client below can equally use the npm entry above; these snippets are for
running a clone.

### Claude Code (project-scoped, zero config)

The repo ships `.mcp.json` at the root:

```json
{
  "mcpServers": {
    "openemt": {
      "command": "node",
      "args": ["api/mcp-server.js"]
    }
  }
}
```

Claude Code reads this file automatically and spawns the server with cwd at
the repo root, so the relative `api/mcp-server.js` resolves. On first use you
get a one-time approval prompt; accept it and the `mcp__openemt__*` tools
appear after a client restart. No editing required. This is the recommended
path and the one the repo is set up for.

### Claude Desktop

Claude Desktop does not set cwd to the repo root and may not inherit PATH the
same way, so use absolute paths. Add an `openemt` entry to the Desktop config
file, replacing `<REPO>` with the absolute path to your clone:

```json
"openemt": {
  "command": "node",
  "args": ["<REPO>/api/mcp-server.js"]
}
```

If `node` is not on the client's PATH, use the absolute node path instead, for
example `C:\\Program Files\\nodejs\\node.exe` on Windows.

Config file locations:

- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

Claude Desktop reads its config only at startup, so fully quit and relaunch it
(not just close the window) for the new server to load.

### Cursor

Cursor supports project-scoped MCP config at `.cursor/mcp.json` in the repo.
Cursor spawns project servers with cwd at the project root, so the same
relative path as `.mcp.json` works:

```json
{
  "mcpServers": {
    "openemt": {
      "command": "node",
      "args": ["api/mcp-server.js"]
    }
  }
}
```

For a global (non-project) setup, use `~/.cursor/mcp.json` and an absolute
path to `api/mcp-server.js` as in the Claude Desktop section above.

### Other MCP clients

Any client that speaks MCP over stdio can host the server. The general recipe:
point the client's `command` at `node` (or the absolute node path) and pass the
absolute path to `api/mcp-server.js` as the sole argument. If the client sets
cwd to the repo root when spawning project servers, the relative path works
too. No environment variables are required.

## Verifying it came up

After restarting the client, call `list_blocks` (or `list_examples`). It
should return the block catalog with parameter names, defaults, labels, and
terminal counts. If the client reports a server error, in nearly every case
one of these is the cause:

- `npm install` was not run (the SDK is missing).
- The path in the config is wrong or not absolute on a client that does not
  set cwd to the repo root.
- `node` is not on the client's PATH (use the absolute node path).

## What the tools do

The server registers these tools (schemas for block parameters are generated
from `DEFS` in `src/blocks.js`, so the agent always sees the real param names
and defaults with no hand-maintained duplication):

- `list_blocks`: list every block type with its params and terminal count.
- `list_examples` / `load_example`: list and load the shipped example
  circuits in `examples/`.
- `load_circuit` / `get_circuit` / `reset_circuit`: load a circuit object or
  `.json` file, inspect the current one, or clear it.
- `add_block` / `add_wire` / `remove_block`: build a circuit. Block IDs are
  auto-assigned and returned; wire endpoints are `[blockId, terminalIndex]`.
- `run_power_flow`: solve the positive-sequence power flow; returns a bus
  table and per-machine initialization.
- `run_simulation`: run a time-domain simulation; returns a `runId` and the
  list of queryable signals by block ID. Duration, time step, plot step and
  phase mode all default to the loaded circuit file's own saved run settings
  (a shipped example therefore runs its intended study with no arguments);
  pass an argument only to override one. The result reports `settingsFrom`
  per option, so it is always clear which values were used and why.
- `query_results`: query a signal (`V`, `Vrms`, `I`, `Irms`, `P`, `Q`) for a
  block ID from a simulation run. By default returns only the steady-state
  last-cycle average per phase; set `tail=false` for the full time series.

Look up probe, bus, and branch signals by block ID, never positional index.
For machine initialization, call `run_power_flow` first so the simulation
starts at the operating point instead of swinging in cold (see the "machine
started cold" trap in `CLAUDE.md`). `run_simulation` never solves the power
flow for you: a hidden solve would make a scripted result depend on an
invisible step. When a circuit file is saved with "Init from PF" on and no
power flow has been solved, `run_simulation` says so in its `warnings`.

## Where this is configured

- `.mcp.json` at the repo root: the project-scoped, relative-path entry for
  Claude Code. Tracked in git, portable across machines for Claude Code.
- Per-machine client configs (Claude Desktop, Cursor global, others): live
  outside the repo in user profile directories and use absolute paths, since
  each clone lives at a different absolute path on each machine. These are
  not shared via git and must be set up per collaborator.