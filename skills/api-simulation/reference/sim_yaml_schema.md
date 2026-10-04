# `.sim.yaml` schema

The file `postman simulate run <filepath>` reads. Conventionally
`postman/simulations/NAME.sim.yaml`, beside the `postman/mocks/` folders whose
members it composes.

## Root

| Key | Required | Notes |
| --- | --- | --- |
| `simulation` | Yes | String. The simulation's name, printed in the run banner. Missing or non-string: `Simulation config missing required field: 'simulation'`. |
| `mocks` | Yes | Non-empty array of mock entries. Missing or empty: `Simulation config missing required field: 'mocks'`. |

Any other root key is ignored. Two show up in files written by the Postman
app and carry **no CLI behavior**:

- `id:` — the simulation's id in its Postman workspace. `simulate run` takes
  that id from `--simulation`, not from the file.
- `routing:` (e.g. `routing: header`) — not read. Members are reached on their
  own ports; there is no header-based routing in the CLI simulator.

## Mock entry

| Key | Required | Notes |
| --- | --- | --- |
| `path` | Yes¹ | Canonical reference: the mock's manifest, i.e. `config.yaml` in the folder-per-mock layout, or any `.json`/`.yaml` carrying `mockSrc`. May instead point straight at a `.js`/`.cjs`/`.mjs` handler. |
| `file` | Yes¹ | Legacy alias for `path`, still accepted. `path` wins when both are set. |
| `name` | No | Display name. Derived when omitted — see below. |
| `port` | No | Integer 1–65535. **Overrides the port the manifest declares.** |
| `scenarios` | No | Array. Attaches fault conditions — see below. |

¹ One of `path` or `file` is required: `Each mock must have a 'file' or 'path' (string)`.

### Name derivation

`name`, when given. Otherwise the referenced file's basename without its
extension — except that a file named `config` is named after its **parent
directory** instead, so `../mocks/acs-sim/config.yaml` becomes `acs-sim`
rather than every member collapsing to `config`.

Duplicate names are rejected: `Duplicate mock name: '<name>'`.

### Path resolution

Tried in order, first hit wins:

1. Relative to the directory holding the `.sim.yaml`.
2. Relative to the current working directory (so a path written from the repo
   root works even when the `.sim.yaml` sits in a subfolder).

Absolute paths and `~/`-prefixed paths are accepted as given. A miss reports
both paths it tried. The target must be a file, not a directory, and must be a
`.js`/`.cjs`/`.mjs` handler or a `.json`/`.yaml`/`.yml` manifest.

When the entry points at a handler and a sibling manifest declares that same
handler (via `mockSrc`, `handlerSrc`, or `mock.json` / `*.mock.json` naming),
the manifest is used instead, so port and name come from it.

### Port resolution

1. `port` on the `.sim.yaml` entry.
2. The `port` field of the referenced manifest.
3. For a bare `.js` handler, the integer in a `process.env.PORT || <N>`
   expression, found by text match.
4. `4500`.

Because `postman mock generate` writes `port: 4500` into every manifest it
creates, two generated mocks in one simulation collide. The run aborts before
binding anything:

```
Error: Duplicate mock port: 4500 (used by both 'acs-sim' and 'features-sim')
```

Set `port:` per entry to fix it without editing each mock's `config.yaml`.

A second, distinct port failure names the port rather than a pair of mocks:

```
Error: Port 4901 is already in use (needed by mock 'payments-sim')
```

That one is something outside this simulation holding the port — most often a
previous simulation that is still running. Note that the installed `postman` is
a wrapper that spawns a nested platform binary, so killing the shell job can
leave the mock servers bound and orphaned; Ctrl+C, or a signal that reaches the
whole process group, is what actually stops them. Confirm the ports are free
before blaming the file.

## `scenarios`

Must be an array (`'scenarios' must be an array`), and each element a mapping.
Two forms are accepted.

### Selection with condition overrides — the form to write

```yaml
scenarios:
  - path: ../mocks/acs-sim/default.js
    overrides:
      conditions:
        error:
          status_code: 503
        latency:
          delay_ms: 250
```

Recognized as a selection when the entry has `overrides`, `path`, or `id`. The
conditions drive the faults; **the selected handler itself is not served** —
the mock's default handler runs and the conditions are injected in front of it.
Extra metadata (`id`, `slug`, routing hints) is ignored. Unknown keys under
`conditions` are ignored for forward compatibility, so a misspelled condition
name fails silently — check the startup log for a `scenario applied` line.

`overrides.bypass` prints a warning and is ignored:

```
[simulate] Mock '<name>': 'overrides.bypass' route proxying is not supported by the CLI simulator — it will be ignored.
```

### Explicit typed fault — legacy, validated strictly

```yaml
scenarios:
  - type: error
    config:
      status_code: 503
```

`type` must be one of the four below, or:
`Invalid scenario type '<type>'. Must be one of: latency, error, rate_limit, chaos`.
Unlike the overrides form, a typo here throws rather than passing silently.

`type: disabled` and `type: undefined` are accepted placeholders that apply
nothing.

### An entry with neither form applies no fault

A bare `- path: ../mocks/acs-sim/config.yaml` under `scenarios:` is a valid
selection carrying no `overrides`, so it parses, starts, and injects nothing.
Omit `scenarios:` altogether for a healthy member rather than leaving an entry
that looks configured.

## Conditions

| Condition | Field | Validation | Observed behavior |
| --- | --- | --- | --- |
| `latency` | `delay_ms` | Positive number | Response held that long before returning its normal status and body. |
| `error` | `status_code` | Integer 400–599 | Every request returns that status with body `{"error":{"message":"<reason>","statusCode":<code>},"scenario":"error"}`. |
| `rate_limit` | `requests_per_minute` | Positive integer | First N requests in the window pass; the rest return 429 with `{"error":{"message":"Too Many Requests","statusCode":429},"scenario":"rate_limit"}`. |
| `chaos` | `failure_rate` | Number 0–100 | That percentage of requests fail. |

A condition applies to the **whole member**, not a single route. To fail one
endpoint while its siblings succeed, split that endpoint into its own mock.

Each fault's `config` is validated with a message naming the mock, e.g.
`Mock 'acs-sim': scenario type 'latency' requires config.delay_ms (positive number)`.

## Run output

Startup prints a banner, then one line per member:

```
▸ Setup
  12:00:33.643  mock started        acs-sim         Mock server "acs-sim" active on :4901
  12:00:33.644  scenario applied    acs-sim         simulation configured — error (503)
```

Each request adds `request sent`, `scenario applied` when a fault fires, and
`request completed` with status and elapsed time, all tagged with the member
that served it. `Press Ctrl+C to stop all mock servers` — one process owns
every member port, and SIGINT/SIGTERM stops them together.

## Worked example

Two files, one healthy and one degraded, over the same two members:

```yaml
# postman/simulations/checkout-sandbox.sim.yaml
simulation: checkout-sandbox
mocks:
  - path: ../mocks/payments-sim/config.yaml
    port: 4901
  - path: ../mocks/inventory-sim/config.yaml
    port: 4902
```

```yaml
# postman/simulations/checkout-payments-degraded.sim.yaml
simulation: checkout-payments-degraded
mocks:
  - path: ../mocks/payments-sim/config.yaml
    port: 4901
    scenarios:
      - path: ../mocks/payments-sim/default.js
        overrides:
          conditions:
            latency:
              delay_ms: 900
            rate_limit:
              requests_per_minute: 30
  - path: ../mocks/inventory-sim/config.yaml
    port: 4902
```

## `simulate run` flags

| Flag | Notes |
| --- | --- |
| `-w, --workspace <id>` | Workspace that owns the run, for start history. |
| `--simulation <id>` | Cloud simulation id to record against. A local `.sim.yaml` has only a name, so history needs **both** this and `-w`. |
| `--api-key <key>` | Defaults to the `postman login` session. |
| `--no-history` | Record nothing. Use in CI. |

History recording is best-effort and never blocks the servers. In CI the
pipeline and branch are captured automatically.
