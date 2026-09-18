---
name: api-flows
description: Lists, runs, deploys, and debugs Postman Flows from the command line — resolving a flow name to its ID, triggering a deployed flow with inputs, running a flow file locally, deploying one so it becomes triggerable, and tracing a failed run to the block that broke. Use when the user asks "what flows do I have," "run the Checkout flow," "deploy this flow," "why did that flow run fail," or names a flow and an action. Covers `postman flows list`, `trigger`, `run`, `deploy`, `update`, `list-runs`, and `get-run`. Depends on bootstrap for anything cloud-bound; only `flows run` against a local file works without it.
---

# Postman Flows

## Overview

Two execution paths that are easy to confuse, so pick by *where the flow
lives*, not by the word the user used:

| Want | Use | Needs |
| --- | --- | --- |
| See what flows exist / get a flow's ID | `flows list` | workspace id |
| Fire a **deployed** flow over its webhook | `flows trigger <flowId>` | a deployed flow |
| Execute a **flow file** on this machine | `flows run <path>` | a `.json` flow file |
| Make a flow triggerable in the first place | `flows deploy <flowId>` | confirmation |
| Turn a deployed flow's trigger or auth on/off | `flows update <flowId>` | confirmation |
| Find a Run ID after the fact | `flows list-runs` | workspace id |
| Explain why a run failed | `flows get-run --run-id` | a Run ID |

`trigger` and `run` are not interchangeable. `trigger` calls a cloud webhook
and returns a Run ID that `get-run` can later explain; `run` executes locally,
prints its own results, and produces no cloud Run ID. A flow that was never
deployed cannot be triggered at all — see [Deploy](#deploy).

Every subcommand takes `--json`. Prefer it whenever the output is being parsed
rather than shown to the user.

## Step 1: Resolve the flow ID first

`trigger`, `deploy`, and `update` all take a flow ID, never a name. Resolve it
before anything else.

Given an ID already, use it. Given a name, list and match:

```bash
postman flows list --workspace <workspaceId>
postman flows list --workspace <workspaceId> --filter "Checkout"
```

`--workspace` is **required**, and the CLI has no default. Get it from
`workspace.id` in `.postman/resources.yaml` — the value `bootstrap` recorded.
Don't re-derive it and don't ask the user for something already on disk. Ask
only when that file has no workspace id (a `--no-cloud` bootstrap leaves it
empty) or when the user names a different workspace; never guess one.

`--filter` takes a name prefix or a regex; `--sort name|updated` (default
`updated`) and `--paginate` are there for long lists.

Then:

- **Single match** → use that ID.
- **Multiple matches** → show the candidates (name + ID + when updated) and
  **ask the user to choose**. Never guess.
- **No match** → say so, and offer to list every flow in the workspace.

```
Flows in workspace 12345-67890-abcdef:
  1. Checkout        — 6f1a2b3c4d5e6f7a8b9c0d1e   (updated 2h ago)
  2. Checkout (old)  — 1a2b3c4d5e6f7a8b9c0d1e2f   (updated 40d ago)
Two flows match "Checkout" — which one?
```

Use whatever ID `flows list` reports verbatim. Don't validate it against an
assumed length or character set.

This is also distinct from `postman search flows` in the `api-discovery`
skill: `search` finds flows by text across Postman, `flows list` enumerates one
workspace and is what the other flows subcommands need.

## Step 2: Trigger a deployed flow

Translate the request into flags, then **show the exact command before running
it**:

- "with amount=4200 and currency=USD" → `-i amount=4200 -i currency=USD`
- "the payload in inputs.json" → `-f ./inputs.json`
- "pass ?version=v2" → `-q version=v2`
- "send header X-API-Key 123" → `--headers X-API-Key=123`
- "use the Staging scenario" → `-s "Staging"`

```bash
postman flows trigger <flowId> -i amount=4200
```

`-n/--dry-run` prints the request URL and payload without sending — reach for
it when the user wants to preview, or when the payload is expensive to get
wrong. Secrets are masked unless `--show-secrets` is added. `-r/--result`
prints only the response body.

Report **all three**:

```
Triggered the Checkout flow.
  Run ID:  session-abc123
  Status:  200 OK
  Response: { "ok": true, "orderId": "ord_991" }
```

The Run ID is what [Step 5](#step-5-debug-a-run) needs. Always surface it, even
on success.

### The flow isn't deployed

A 404 with a hint like `To deploy it, run: postman flows deploy <flowId>` means
the flow exists but has no trigger. Explain that, **offer** to deploy it, and
proceed only on explicit confirmation (Critical Rule 2). After a successful
deploy, re-run the trigger and report Run ID + status + body as above.

### The trigger is disabled

Explain the trigger is off and offer to enable it — a state change, so confirm
first:

```bash
postman flows update <flowId> --trigger on
```

Then trigger.

## Step 3: Run a flow file locally

`flows run <path>` executes a flow from a file — the flows counterpart to
`collection run` in the `api-testing` skill, and the form that belongs in CI.

```bash
postman flows run ./path/to/flow.json -i name=John
postman flows run ./path/to/flow.json -e ./postman/environments/dev.json
```

- `-i`, `-f`, and `-s` build inputs exactly as on `trigger`.
- `-e/--environment` resolves `{{variables}}` from an environment file.
- `--workspace <workspaceId>` is **required if the flow contains connector
  blocks** — omitting it fails at the block, not at startup, so check the flow
  before blaming the command. Use the id from `.postman/resources.yaml`, as in
  Step 1.
- `--output json` and `--reporters html` write results to a file for CI.
- The exit code reflects failure by default; `-x` suppresses that, which
  defeats the purpose in a pipeline (Critical Rule 5).

Dataset-driven iteration (`--iteration-data-dataset`, `--iteration-data-view`,
`-m/--map-column`) is **BETA** — see
[reference/flow_cli_flags.md](reference/flow_cli_flags.md) before using it.

## Step 4: Deploy

Deploying makes a flow triggerable and returns its Trigger URL. It is
mutating: **confirm the path and the action** before running (Critical Rule 2).

Propose a path derived from the flow name rather than asking cold — "Checkout"
→ `/checkout`, "Nightly Report" → `/nightly-report` — and confirm that
proposal. Ask about authentication only if it's relevant to the request; add
`-a/--auth` only on a yes.

```bash
postman flows deploy <flowId> --path /checkout
```

`-t/--timeout` takes a value **with units** and a range of 5000ms–60000ms
(default `10000ms`) — `--timeout 5000ms`, not `--timeout 5000`.

Report the **Trigger URL** and whether the **trigger is enabled**:

```
Deployed the Checkout flow.
  Trigger URL: https://<host>/checkout
  Trigger:     enabled
```

If it came back disabled, offer `flows update <flowId> --trigger on` (confirm
first). If the deploy hit a path conflict, surface the CLI message and propose
an alternative path.

When the deploy was only a means to running the flow, continue straight into
[Step 2](#step-2-trigger-a-deployed-flow) and report the Run ID — deploy-then-trigger
is one job, not two conversations.

## Step 5: Debug a run

### Find the Run ID

If the trigger just reported one, use it. Otherwise look it up rather than
asking the user to remember it:

```bash
postman flows list-runs --workspace <workspaceId> --flow <flowId> --range 3d
```

The workspace id comes from `.postman/resources.yaml`, as in Step 1.

`--range` defaults to `1h`, which will hide anything older — widen it (`30m`,
`2h`, `3d`) before concluding a run doesn't exist.

### Explain the failure

```bash
postman flows get-run --run-id session-abc123
postman flows get-run --run-id session-abc123 --logs
postman flows get-run --run-id session-abc123 --logs --filter blockId1
```

Start with the summary and add `--logs` only when the summary doesn't explain
it. `--filter` matches a block ID **prefix** and is repeatable.

Parse and report — **don't dump raw logs** (Critical Rule 4):

```
Run session-abc123 — failed
  Failing block: "HTTP Request (Get Orders)"
  Reason:        downstream returned 504 after 10s timeout
  Status:        error
Suggestion: the upstream API timed out — retry, or raise the request timeout.
```

A Run ID that isn't found may simply be too new — confirm the ID with the user
before declaring the run missing.

## Critical Rules

1. **Never guess a flow ID or a workspace ID.** A name is not an ID, and
   `--workspace` has no CLI default. The workspace id is whatever `bootstrap`
   put in `.postman/resources.yaml`; ask the user only when it isn't there.
   Ambiguous flow name → present candidates and ask. Both are cheaper than
   acting on the wrong flow.
2. **`deploy` and `update` require explicit confirmation.** They change what a
   flow does for everyone who calls it — a deploy exposes a public trigger
   path, `--trigger on|off` starts or stops accepting calls, and `--auth
   on|off` **removes or adds authentication on a live trigger**. Propose,
   confirm, then run. `list`, `list-runs`, `get-run`, and triggering an
   already-deployed flow are not mutating and need no confirmation.
3. **`trigger` needs a deployed flow; `run` needs a file.** A "flow not
   deployed" 404 is not a reason to reach for `flows run`, and a local file is
   not something `trigger` can reach. Fix the actual mismatch.
4. **Report the failing block, not the log.** `get-run --logs` is input to your
   analysis, not output for the user. Name the block, the reason, and the run
   status.
5. **Don't suppress a failing exit code in CI.** `flows run -x` makes a failed
   flow look like a pass to the pipeline. Only use it when the user explicitly
   wants the run's result read from the report instead.
6. **Surface CLI errors verbatim** and never assert access the CLI didn't
   grant. A missing binary or an unauthenticated CLI is a `bootstrap` problem —
   route there rather than improvising an install or a second login.

## Verification

State which subcommand actually answered, and the identifiers that make the
result checkable: the flow ID acted on, the Run ID for a trigger, the Trigger
URL for a deploy, and the pass/fail plus exit code for a local `run`. "The flow
ran" without a Run ID isn't a result anyone can follow up on.

## Reference

- [Flows CLI flags](reference/flow_cli_flags.md) — the full flag table per
  subcommand, including `run`'s BETA dataset-iteration flags and the
  units-and-range rule on `deploy --timeout`.
- `bootstrap` skill — CLI install, authentication, and the workspace id these
  commands need.
- `api-discovery` skill — `postman search flows` for finding a flow by text
  across Postman, as opposed to listing one workspace.
