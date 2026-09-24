---
name: bootstrap
description: Resolves the Postman CLI, authenticates, links the workspace, and records this repo's spec path, collections directory and workspace id. Also owns the decision table for what to do with a workspace afterward — create vs. connect an existing one vs. push vs. pull — so read this before running any `postman workspace` command, not just at first setup. Use when the user asks to "set up Postman here", "connect this repo to Postman", "link this workspace", "authenticate with Postman", "postman login", "run postman init", "share this workspace with my team", or "connect an existing workspace" — and before the api-mocking, api-testing, api-monitoring, flows, performance-testing, api-discovery, or ci-integration skills only when the CLI, the linked workspace or the spec path has not already been confirmed in this session. Those skills stop and point back here if it has not completed; they never re-derive these values themselves.
---

# Bootstrap Postman for This Repo

## Overview

One-time and idempotent: every other Postman skill in this plugin reads the
values this one records and re-derives none of them. Finding an existing
`postman/` tree or an OpenAPI file is a signal to inspect, not to assume this
repo is already set up.

## Rules

- Make HTTP calls with `postman request`, never `curl` or another client — it
  reuses saved auth and env vars, syncs to the workspace, and runs test
  assertions.
- Never invent a subcommand or a flag. Run `-h` first and believe it.
- Lint specs with `postman spec lint`, never `postman api …` — the API Builder
  is deprecated in v12+ and the CLI prints no warning.
- Local commands need no login; only commands reaching the Postman cloud do.
  Don't force a login the task doesn't need.
- A missing `postman` binary means install it. Route to `postman-mcp-server`
  only after an install has been attempted and actually failed.
- Never fabricate a workspace id, spec path, or collections directory. Report
  the gap and stop.
- Never echo an API key or session token into output, logs, or summaries.
- "Present" is not "current": check the version and existing links before
  setting anything up.
- Wire up an existing repo only. Never scaffold a new API or a starter spec.
- Write no host-specific paths — the same `skills/` directory loads on every
  route.
- Hit a genuine CLI gap along the way — a missing flag, a confusing default,
  something that took more steps than it should have? Say so instead of just
  working around it: `postman feedback --type cli_gap --context "<command>"
  "<what happened>"`. `--type` also takes `bug_report`, `feature_request`, and
  `improvement_suggestion`. Nobody on the CLI team sees a workaround; this is
  the channel that reaches them.

## Ask the CLI: `-h`

The CLI is self-describing at different levels. Walk down only as far as the
question needs:

```bash
postman -h                      # resources: collection, spec, mock, monitor, workspace, api, flows…
postman <resource> -h           # that resource's actions
postman <resource> <action> -h  # real flags, defaults, and worked `Eg.` lines
```

Read the third level before writing any command that carries a flag — it is the
only place defaults are stated, and a wrong default fails silently. Live output
is authoritative over any summary, including this file. There is also no single
verb for "is the workspace linked and synced": run `postman workspace -h` and
pick from what it prints.

---

# Process

Four steps, in order. Stop at the first that fails and report which one.

## 1. Resolve the CLI

### 1.1 Check what is already there

**Present, and at which version?**

```bash
command -v postman && postman --version
```

**Current?** Never blocking — no network is a normal answer. But don't call a
feature missing without having made this comparison.

```bash
npm view postman-cli version
```

### 1.2 Install only if missing

**Preferred — npm, all platforms:**

```bash
npm install -g postman-cli
```

**Windows, or avoiding a global npm install:** use the platform installers in
[reference/cli_installation.md](reference/cli_installation.md). Every route puts
`postman` on `PATH`.

**Updating a copy that already exists:** use the same route that installed it.
curl-installed binaries don't take `npm install -g` cleanly.

**If every route fails:** name what blocked you — no Node, no shell, no write
access, or a hosted session that cannot install — then hand off to the
`postman-mcp-server` skill. An attempted install that actually failed is the
only thing that qualifies.

## 2. Authenticate, if the task needs it

### 2.1 Decide whether auth is required

Local commands need no login, and `postman init` is among them — its own help
says *"No authentication, and safe in CI."* Skip to step 3 unless something in
the task reaches the Postman cloud.

### 2.2 Sign in

**With an API key — preferred, non-interactive:**

```bash
[ -n "$POSTMAN_API_KEY" ] && postman login --with-api-key "$POSTMAN_API_KEY"
```

**Browser flow, when that variable is unset:**

```bash
postman login
```

**Never echo the key or token.** Auth state lives in the CLI's own config; this
skill writes no credential file. Report that authentication succeeded, nothing
more.

## 3. Record the bindings

### 3.1 Check for an existing record

Read `.postman/resources.yaml` for `localResources` and `workspace.id`.
Populated → go to step 4. Absent or empty → run init.

### 3.2 Run init

`postman init --json` is the agent-facing form. It writes
`.postman/resources.yaml` and scaffolds `postman/` for specs, collections and
environments. Downstream skills read that file and nothing else.

```bash
postman init --json --no-cloud               # local only, no workspace
postman init --json --visibility personal    # also create and bind a workspace
```

**The workspace step is interactive** without `--no-cloud` or `--visibility`.

**Read the payload, not stderr.** Take `bindings` and `exitCode` from the JSON.
Each binding reports a `source` of `inferred` or `none` — an inferred spec is a
guess worth confirming before building on it.

**Exit codes that are not failures:** 2 means several specs could be
authoritative, so re-run with `--spec <path>`. 5 means the local files were
written but the requested workspace was not created — it does *not* mean re-run.

## 4. Verify and report

### 4.1 Checkpoints

- `postman --version` returned a real version.
- Auth is confirmed, or established as not required for this task.
- `.postman/resources.yaml` names a spec or a collections directory.
- `workspace.id` is set, or the run was deliberately local-only — `--no-cloud`
  leaves it empty and still exits 0, which is a pass, not a gap.

"The CLI is installed" is not the bar, and a loaded skill configures nothing.

### 4.2 Summary format

```md
## Postman bootstrap
- **CLI**: <version> (latest: <version> | not checked)
- **Auth**: <api-key | browser | not required for this task>
- **Workspace**: <id | none — local only>
- **Spec path**: <path (inferred | explicit) | none — user must create>
- **Collections dir**: <path | none — user must create>
```

---

# Workspace Lifecycle

The four steps above run once, but a workspace decision comes up again any
time a later task touches `postman workspace`. `create` is the command
that's easiest to reach for by reflex — it's the first verb, and it's the
one that "just works" standalone — but it's the wrong answer whenever a
workspace for this repo already exists somewhere, local or cloud. Check
`.postman/resources.yaml`'s `workspace.id` (step 3) and, if still unsure,
`postman workspace list` before picking a row below.

| Situation | Command | Why |
| --- | --- | --- |
| "Share this workspace with my team" and `workspace.id` is already set | `postman workspace push` | The workspace already exists — sharing means getting local work into it. Who else can *see* it is a team/role setting in Postman itself, not something the CLI creates. |
| A Postman workspace already exists (made in the UI, or turned up in `workspace list`) but this repo isn't bound to it | `postman workspace connect-git <workspaceId>`, then `postman workspace pull` | Binds the repo to the workspace that already exists and pulls its entities into the git-native `postman/` folders — the filesystem workflow the rest of this plugin reads — without pushing anything or touching the cloud copy. |
| Nothing exists yet — no `workspace.id`, and `workspace list` doesn't show one for this project | `postman workspace create --visibility <personal\|team\|...>` | Only now is there actually nothing to reuse. |
| Not sure what a push or pull would actually change | `postman workspace diff` | Read-only preview of both directions; run it before either. |

The underlying point: getting a repo onto the filesystem workflow doesn't
require any cloud-mutating operation at all when the workspace already
exists — `connect-git` + `pull` is entirely one-directional (cloud → disk).
Reaching for `create` on an already-shared workspace doesn't just fail to
share it, it produces a second, disconnected workspace that now competes
with the one the team actually uses.

---

# Reference Files

- `collection-schema-v3` skill — read when inspecting or writing the
  collection files this skill resolves.
- [CLI Installation](reference/cli_installation.md) — read for install, update
  and uninstall commands per platform.
