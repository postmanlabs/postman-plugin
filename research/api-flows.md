# Research: Postman Flows via the CLI

Working notes behind `skills/api-flows/`. Deliberately outside `skills/` —
`scripts/build-manifest.js` hashes and ships every file under a skill
directory, so a research doc placed there would be downloaded by every user
running `postman init`.

**Method:** `postman flows <cmd> -h` and live invocation on CLI **1.56.3**,
plus the official docs via Context7 (`/websites/learning_postman`). Claims
below are marked by how they were established. Nothing here is from memory.

---

## 1. Command surface

`postman flows -h` (verified) lists exactly seven subcommands:

| Subcommand | One-line purpose |
| --- | --- |
| `list` | List flows in a workspace |
| `trigger <flowId>` | Trigger a **deployed** flow |
| `deploy <flowId>` | Deploy a flow (required to trigger it) |
| `run <path>` | Run a single flow **from a file** |
| `update <flowId>` | Update settings for a deployed flow |
| `list-runs` | List run history for a deployed flow |
| `get-run` | Analyze a specific flow run |

`flows` aliases to `fl`. Every subcommand accepts `--verbose`, `--debug`,
`--json`.

**Two subcommands the DevRel plugin never covered:** `run` and `list-runs`.
DevRel had skills for list/trigger/deploy/get-run only.

## 2. Hard-required arguments (verified by invocation)

Commander enforces these; each exits **1** with the message shown. This
matters because "required" was guesswork in the DevRel docs.

```
postman flows list          → error: required option '-w, --workspace <workspaceId>' not specified
postman flows list-runs     → error: required option '-w, --workspace <workspaceId>' not specified
postman flows deploy abc123 → error: required option '-p, --path <path>' not specified
postman flows get-run       → error: required option '-r, --run-id <runId>' not specified
postman flows trigger       → error: missing required argument 'flowId'
postman flows update abc123 → Error: Invalid command parameters: trigger: At least one option is required: --trigger or --auth
postman flows run ./nope.json → Error: Flow file not found: ./nope.json
```

Notes:
- `deploy --path` **is** genuinely required — `-h` does not mark it so, only
  invocation reveals it.
- `update` requires at least one of `--trigger` / `--auth`; it is not a no-op
  when called bare.
- `trigger` takes the flow id **positionally**, not via a flag.

## 3. Where a local flow file comes from

This was the biggest gap in the first draft of the skill, which documented
`flows run ./path/to/flow.json` without saying where that file originates.

**Verified by invocation** — `postman init --json --no-cloud` in an empty dir
scaffolds `postman/flows/` alongside `postman/collections`,
`postman/environments`, `postman/globals`, `postman/sdks`, `postman/specs`:

```
"creates": [".postman/resources.yaml", "postman", "postman/collections",
            "postman/environments", "postman/flows", "postman/globals",
            "postman/sdks", "postman/skills", "postman/specs"]
```

**Confirmed by docs** — every `flows run` example uses exactly that path:
`postman flows run postman/flows/[flow-filename].json`.

So: `postman/flows/*.json` is the canonical location, it is part of the
git-native workspace layout, and `postman workspace pull` (which "pulls
workspace entities into the local git-native folder") is what populates it.

**Also verified:** `.postman/resources.yaml` has **no flows section**. After
`init --no-cloud` it contains only `workspace: id: ''`. There is no local
flow-id mapping, which is why `flows list` is the only way to resolve a flow
name to an id — unlike collections, which `resources.yaml` maps to cloud ids.

## 4. Plan and permission gating (verified — and it bites)

**Docs, `flows run`:** "It is available on Postman **Enterprise** plans and
requires signing in with `postman login`." Deploy likewise documents a
`postman login` prerequisite.

**Live:** `postman flows list --workspace <id>` was run against 14 distinct
workspaces on an authenticated account that `postman workspace list` shows
full access to. Every single one returned the same thing, exit 1:

```
Failed to list flows: Access denied. Please check your permissions for the specified resource.
```

The uniformity is the finding. An access error on *every* workspace points at
the credential's scope or the org's plan, not at a wrong workspace id — so
the skill must not send the agent hunting for a better workspace id, and must
never read this as "this workspace has no flows."

Consequence: **no successful `flows list` output shape was observed.** The
skill therefore describes *what to report* rather than inventing an exact
column layout it cannot verify.

## 5. Deploy has flow-shape preconditions (docs)

Not a CLI concern, but the reason a deploy fails for a flow that looks fine:

> "To deploy a flow, you must configure the Start block with an API request
> trigger and add a Response block to the canvas. During the deployment
> process, you define a specific path that is appended to an automatically
> generated base URL."

So `--path` is a suffix on a generated base URL, and a flow with no API
request trigger on its Start block, or no Response block, is not deployable
regardless of CLI flags. The CLI cannot fix either — they are canvas edits.

**What deploying buys you (docs):** "Flows can be deployed and run in the
Postman cloud, enabling them to be triggered by schedules, webhooks,
third-party apps, or other APIs… useful for running automations and exposing
functionality as an API or an AI tool."

## 6. What a scenario actually is (docs)

> "Adding an input creates a corresponding output port on the block and
> generates a **Start Trigger scenario** where you can define key-value
> pairs. These values are sent when the flow is run locally, and you can
> choose between standard string inputs or **secret** inputs for sensitive
> data like API keys."

So a scenario is a named input set that lives **in the flow definition**, not
on the command line — which is why `-s` is reusable across invocations and
people, while `-i` is per-invocation. Inputs may be declared secret, which is
what `--show-secrets` unmasks in dry-run output.

Precedence, from `-h`: `-s` builds payload, headers and query; `--headers`
and `--query` **override** it; `-i`/`-f` override scenario values.

## 7. `trigger` vs `run` — the distinction to teach

| | `trigger <flowId>` | `run <path>` |
| --- | --- | --- |
| Executes | cloud-deployed flow via its webhook | local file, on this machine |
| Needs a deploy | yes | no |
| Reads | the deployed artifact | working-tree file, including uncommitted edits |
| Produces | Run ID + HTTP status + body | status, output, test results, exit code |
| Observability | `get-run` per-block logs | its own stdout / `--output` / `--reporters` |
| Environment file | not supported | `-e/--environment` |
| Plan | — | Enterprise (docs) |

Docs call `run` "suitable for CI/CD"; it "returns status, output, and test
results." `-x/--suppress-exit-code` overrides the exit code, which is what
makes it a gate.

## 8. Why `get-run` rather than reading the trigger's response

A flow is a graph of blocks; the HTTP response a trigger returns is the output
of the **Response block** only. A flow can return 200 while an intermediate
block failed, and a 500 tells you nothing about which block produced it.
`get-run --logs` is per-block, which is the only way to name the failing
block.

Docs troubleshooting guidance corroborates the block-level framing: "inspect
run logs and the Console… Place Display or Log blocks at key points… Test one
potential cause at a time to isolate issues to specific blocks."

**Run ID format — do not assume one.** Two different shapes appear in
authoritative sources: DevRel used `session-abc123`; the official docs show
`postman flows get-run main/1a123ab1`. Use verbatim whatever `trigger`
reported or `list-runs` printed.

## 9. Observed gotchas worth encoding

| Gotcha | Source |
| --- | --- |
| `deploy --timeout` carries units and a range: `5000ms`–`60000ms`, default `"10000ms"` | `-h` |
| `get-run --filter` matches a block-id **prefix**, repeatable | `-h` |
| `list-runs --range` defaults to **`1h`** — silently hides older runs | `-h` |
| `run --workspace` required **only** for flows with connector blocks | `-h` + docs |
| `deploy --auth` is a bare boolean; `update --auth` takes `on\|off` | `-h` |
| Short flags are unstable across subcommands: `-f` = `--filter` (list), `--input-file` (trigger/run), `--flow` (list-runs); `-r` = `--result` (trigger), `--range` (list-runs), `--run-id` (get-run); `-t` = `--timeout` (deploy), `--trigger` (update) | `-h` |
| Dataset iteration flags on `run` are marked `[BETA]` | `-h` |
| Cloud datasets need a paid plan + login; local ones are `.dataset.yaml` | `postman dataset -h` |

## 10. Adjacent surfaces deliberately left out

- `postman webhook` — separate resource (`webhook create/start/pause/forward`,
  `https://<webhook-id>.webhook.pstmn.io`). A flow trigger is not a Postman
  webhook entity; conflating them would be wrong.
- `postman dataset` — its own command tree; `api-flows` only needs the three
  `run` flags that consume a dataset.
- `postman search flows` — text search across Postman, a different dataset
  from `flows list`'s workspace enumeration. Belongs to `api-discovery`.

## 11. Open questions

- Success output shape of `list` / `trigger` / `get-run` — unobserved, blocked
  by the access-denied above. Worth re-running once a Flows-enabled credential
  is available, and tightening the report guidance if the shape suggests it.
- Whether `workspace pull` populates `postman/flows/` in practice (inferred
  from the scaffold plus the docs' canonical path; not directly observed).
- Whether `deploy` surfaces a distinct error for the missing-Response-block
  precondition, or a generic one.
