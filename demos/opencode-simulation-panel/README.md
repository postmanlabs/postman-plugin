# OpenCode simulation panel (demo)

An OpenCode TUI plugin that opens a live panel beside the agent session showing
what a running `postman simulate run` is doing: each mock, its configured
faults, and every request with its status, latency and the fault that most
likely explains it.

The panel attaches by itself. When the agent starts a simulation as a
background shell command, the panel opens on the right, keeps the prompt
focused, and streams traffic as the agent's code calls the mocks.

This is a demo, not part of the shipped plugin. It uses OpenCode's v2 panel
API (`ui.panel.open` and the `session.panel` slot), which exists in the v2
source but is not documented on opencode.ai yet.

## Requirements

- OpenCode v2: `npm i -g @opencode/cli` (tested on 2.0.18). OpenCode v1
  (`opencode-ai`) has no session panel.
- Postman CLI with `postman simulate run` (tested on 1.63.0).

## Install

Link `plugin/` into an OpenCode plugin directory as its own folder. The
folder name is free; OpenCode loads its `tui.tsx`.

```bash
ln -s "$PWD/plugin" /path/to/your-api/.opencode/plugins/postman-simulation
```

Use `~/.config/opencode/plugins/postman-simulation` instead to load it in
every project. OpenCode picks up the plugin and later edits to it without a
restart.

## Run the demo

1. In the project, create the mocks and a simulation:

   ```bash
   postman mock generate -n cart --port 4611
   postman mock generate -n payments --port 4612
   ```

   ```yaml
   # postman/simulations/checkout-degraded.sim.yaml
   simulation: checkout-degraded
   mocks:
     - file: ../mocks/cart/config.yaml
       scenarios:
         - type: latency
           config: { delay_ms: 300 }
     - file: ../mocks/payments/config.yaml
       scenarios:
         - type: chaos
           config: { failure_rate: 40 }
         - type: rate_limit
           config: { requests_per_minute: 5 }
   ```

2. Start `opencode` in the project and ask the agent to work against the
   simulation, for example: "Start postman/simulations/checkout-degraded.sim.yaml
   in the background, then build a checkout client that retries payments
   failures, and exercise it against the simulation."
3. The panel opens when the agent's background shell starts the simulation.

To drive it without the agent, run `/simulation` in a session. It starts the
only `*.sim.yaml` under `postman/simulations/`, or asks which one when there
are several.

| Command | Does |
| --- | --- |
| `/simulation` (alias `/sim`) | Opens the panel, attaching to a running simulation or starting one. |
| `/simulation <file>` | Starts `postman simulate run <file>` as an OpenCode background shell. |
| `/simulation stop` | Stops every running simulation in the project. |

The panel lives in a session. Started from the home screen, the simulation
runs and the panel opens as soon as you enter a session.

Opening the panel leaves focus on the prompt. To use its keys, click it or
press `ctrl+x →` (OpenCode's default); `ctrl+x ←` goes back.

| Key (panel focused) | Does |
| --- | --- |
| `s` | Stops every running simulation in the project. |
| `f` | Toggles fullscreen. |
| `c` | Clears the request list. |

Terminals narrower than 80 columns show the panel fullscreen.

## How it works

- The plugin watches OpenCode's shell inventory (`shell.created`,
  `shell.exited`, `shell.deleted`) for a shell in this project that runs
  `postman simulate run`. A command that only mentions it, such as
  `rg "postman simulate run"`, is ignored. The agent's background shell tool
  and `/simulation` both create shells there, so the server owns the
  simulation process and the panel never spawns one.
- It pages the shell's captured output with `client.shell.output`, the same
  call OpenCode's own shell-output viewer uses, and parses each line in
  [`plugin/simulation-log.ts`](plugin/simulation-log.ts).
- State lives in `storage.memory`, so a plugin hot reload resumes from the
  last read offset instead of replaying or duplicating rows.

## Limits

- `postman simulate run` logs each mock's configured faults, not which fault
  fired on a given request. The panel infers the cause from the status: 429
  is rate limiting, a configured error status is an injected error, a 5xx on
  a chaos mock is chaos, and latency mocks tag their delay. A JSON-lines
  output mode in the CLI would remove the guesswork.
- `/simulation` with no argument reads `postman/simulations/` from the disk
  the TUI runs on, so it lists nothing when the TUI is attached to a remote
  server.
- When a second simulation starts and fails (for example on a port already
  in use), the panel switches to it and shows the error. `/simulation`
  switches back to the one still running.

## Tests

The log parser is tested against captured `simulate run` output:

```bash
node --test test/*.test.ts
```

Node runs the TypeScript test file directly through type stripping (tested on
Node 24).
