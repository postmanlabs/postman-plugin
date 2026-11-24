---
name: application-cloud-testing
description: Creates, connects, runs, and reads results from application tests with `postman application project` (alias `postman app project`), which syncs a Playwright project to a Postman workspace and runs it in the Postman cloud, as a local run of the files on disk or a cloud run of the pushed version, with HTML and JSON reports. Keeps each test's plain-language intent in `intents/` and uses it to fix or explain failures. Covers the Postman side only, not Playwright test authoring. Use when the user asks to "run my Playwright tests in the Postman cloud," "run my local changes in the cloud," "will my test pass in the cloud," "why does my test pass locally but fail in the cloud," "create an application test," "connect this Playwright folder to Postman," "why did my cloud application test fail," "fix my failing application test," "get the report for my test run," "show my local runs," "stop syncing this test." Checking captured traffic against a collection is the `postman:application-testing` skill.
---

# Cloud Application Tests

## Overview

**Requires a Playwright project, and an app reachable from the Postman cloud.** There is no traffic capture or collection matching; for that, load the `postman:application-testing` skill. When a request such as "connect my Playwright tests to Postman" could mean either, that skill's "Choose the Route" section decides.

An *application test* is a Playwright project stored in the workspace and run by Postman. Its folder lives at `postman/appTests/<name>/` by default; `.postman/resources.yaml` records which folder is connected to which test. `postman workspace pull` and `postman workspace push` sync application tests along with the workspace's other files.

Every `postman app project run` is in the Postman cloud, and is one of two kinds. The target says which:

| Command | Run | Uses | What it is for | History |
|:--|:--|:--|:--|:--|
| `postman app project run <folder>` | **Local run** | The folder's files as they are now, pushed or not | **A dry run in the cloud before a push:** does this test run the way it will there? | Saved on this machine only, under `.postman/appTests/` |
| `postman app project run <app test id>` | **Cloud run** | The test's last pushed version | Running the test everyone shares | The test's shared history in the cloud |

**A local run is a dry run in the cloud, not a replacement for `npx playwright test`.** Playwright on this machine runs with this machine's packages, browsers, environment variables and network. A local run sends the same files a push would to the cloud, as a hidden draft test, and runs them the way a cloud run would: the cloud's Playwright, its dependency resolution, its runner environment, its network. What passes locally can still fail there: a package the cloud does not resolve, a fixture not uploaded, an env var or secret only set on this machine, an app URL only reachable from here, a browser or config difference. A local run shows that before anything is pushed or anyone else sees it. Use `npx playwright test` to write and debug a test; use a local run to check it will pass in the cloud.

Run every `postman app project` command **from the repository root**, the folder with `.postman/resources.yaml`. They do not search parent folders. Pass `--json` on every command in an agentic context: it prints one object to stdout, never prompts, and refuses with a named fix instead.

Before constructing a command, run `postman app project <command> --help` to confirm its flags.

---

## Prerequisites

Assess each against the repository before acting; only act on what is missing.

- **Playwright project** — a folder with a `playwright.config.*`, or none yet if `create` will scaffold one. This skill does not cover writing Playwright tests.
- **Repository set up** — `.postman/resources.yaml` exists. If not, load the `bootstrap` skill (`postman init`).
- **Authentication** — if `POSTMAN_API_KEY` is in the environment, run `postman login --with-api-key "$POSTMAN_API_KEY"`. Otherwise surface the gap to the user; do not start `postman login` in an agentic context, as it needs a human to finish a browser flow.
- **Workspace link** — `.postman/resources.yaml` has a `workspace.id`. If not, load the `bootstrap` skill to link one. Every run needs it, and so does every command except `create --local-only` and `list` without `--workspace`.

---

## Setup

Check `postman app project list --json` first. It lists this repository's test folders, each with its `id` and `state`:

| State | Meaning |
|:--|:--|
| `in_sync` | The folder matches the version last synced. |
| `local_changes` | Files were edited, removed or added since the last sync (`changedFiles`). |
| `cloud_changes` | Someone pushed since the last sync. |
| `local_and_cloud_changes` | Both; pull first, as push would be refused. |
| `not_pushed` | A Playwright folder no test is connected to yet. |
| `folder_missing` | A connected folder that is gone. |
| `sync_off` | The folder has `sync: false` (see below). |
| `unknown` | The cloud could not be asked; `statusUnknown` says why. |

`postman app project list --workspace --json` lists the tests in the cloud instead, each with its folder here or `null` when it is not pulled into this repository. Act only on what is missing:

- **New project** — `postman app project create <name> --json` scaffolds a Playwright project in `postman/appTests/<name>/`, creates the test in the workspace and connects it. It also writes `intents/tests/example.spec.yaml` for the example spec (`intentsFile` in the output); replace its entries when the example tests are replaced. `--local-only` scaffolds without creating it in the cloud; the next `postman workspace push` creates it.
- **Existing Playwright folder** (has a `playwright.config.*`) — under `postman/appTests/`, `postman workspace push` finds and creates it. Elsewhere, push only finds it once its path is in `localResources.appTests`. Either add the path there (relative to `.postman/`, for example `../packages/github-e2e`), and the next push creates the test; or run `postman app project connect <path> --json`, which adds it and creates the test now. Add `--test <id>` to connect to a test that already exists in the workspace instead; nothing is uploaded until `postman workspace push`, or `postman workspace pull` takes the cloud's copy.
- **Test made in the Postman app** — `postman workspace pull` brings it down with a `package.json`; run `npm install` in that folder to run it locally with Playwright.

### When a folder and its cloud test are not connected

A folder is connected when `cloudResources.appTests` in `.postman/resources.yaml` maps its path to the test's `{ id, version }`. Push, pull and cloud runs by folder all rely on it. If a test exists in the cloud but its folder is not mapped — `list --workspace --json` shows it with `folder: null` while the folder shows `not_pushed` in `list --json` — fix that **before** any pull or push:

- A pull puts a test it cannot map into a new folder, `postman/appTests/<name>/`, a second copy.
- A push of the unmapped folder creates a second cloud test.

Connect the folder to the test that exists:

```bash
postman app project connect <folder> --test <app test id> --json
```

It reads the test's current version from the cloud, refuses an id already connected elsewhere, writes the mapping, and moves the folder's local runs under the id. The mapping can be written by hand instead — `../<folder>: { id: <id>, version: <the cloud's current version> }` under `cloudResources.appTests` — but the version must be exact, or the next push is refused as a conflict; prefer `connect`.

If a duplicate was already made, keep one pair, delete the other cloud test in the Postman app, and with the user's agreement delete the duplicate folder, its `cloudResources.appTests` entry and its `.postman/appTests/<id>.json` record.

### Files that are uploaded

Push, and a local run, upload what a run needs: the Playwright config, the spec files and everything they import, `package.json` and its lockfile, and every YAML file under the folder's `intents/`. A file the tests read without importing it — a JSON fixture read with `fs.readFileSync`, an upload fixture — is not found that way. List those under the folder's entry in `.postman/resources.yaml`, keyed by its path from `.postman/`:

```yaml
appTests:
  ../postman/appTests/Checkout:
    include:
      - fixtures/**
      - data/users.json
```

### Stop syncing a folder

`sync: false` under the same entry keeps the folder out of push and pull, and its cloud test is never deleted by a force sync. Removing it carries on from the same version.

```yaml
appTests:
  ../postman/appTests/Checkout:
    sync: false
```

There is no delete command. A test is deleted in the Postman app. Pull never removes a test deleted there from this repository; set `sync: false` on its folder, or the next push creates it again.

---

## Run and read results

A target is required. Without one the command exits 2 and lists both forms for each connected test; never guess between them.

**To dry-run the files on disk in the cloud before pushing — a local run:**

```bash
npx playwright test                                       # first: does it pass on this machine?
postman app project run postman/appTests/Checkout --json  # then: does it pass the way the cloud runs it?
```

It makes a hidden draft test from the folder (bundled exactly as push would), runs it in the cloud, always waits, and saves the results as soon as it ends. It works for a folder that was never pushed. `--no-wait` is refused (exit 2). It changes nothing anyone else sees: no version, no shared run. Do one before `postman workspace push` when the tests, their imports, `package.json` or the config changed, or when a cloud run failed and the tests pass on this machine.

When a test passes with `npx playwright test` but fails in a local run, the difference is the cloud, not the test logic. Look for:

- **Dependencies** — a package missing from `package.json` or its lockfile, a version the cloud resolves differently, an import of a local path outside the folder. The upload's `files` list in the output shows exactly what the cloud got.
- **Files** — a fixture or data file the tests read without importing it; add it under `include:` (see [Files that are uploaded](#files-that-are-uploaded)).
- **Environment** — an env var, secret or `.env` file only on this machine (`.env*` is never uploaded), or a `baseURL` that points at `localhost`.
- **Network** — the app under test, or a service it calls, is not reachable from the Postman cloud.
- **Config** — run options the cloud sets (browser, retries, viewport), or a `webServer` the cloud does not start.
- **A project that fails to load** — `summary.errors` holds errors outside any test, such as a spec that could not be imported.

Report these to the user as cloud-readiness problems, with what to change, rather than editing tests to work around them.

**To run the pushed version, the one others run — a cloud run:**

```bash
postman workspace push                                    # sync local changes first
postman app project run <app test id> --json --report
```

Read the JSON output:

- `passed` — `true` when the run succeeded and every test passed.
- `summary` — `passed`, `failed`, `flaky`, `skipped` counts; `failures[]` with each failed test's `title`, `file`, full `message`, `location` and, when the spec has one, its `intentsFile`; `errors[]` / `errorMessages[]` for errors outside any test, such as a spec that failed to load.
- A local run's output is its saved `run.json`: `id` (`l_…`), `folder`, `appTestId` (`null` for a folder never pushed), `draftTestId`, `runId`, `state`, `files` uploaded, plus `summary`, `reportFolder` and `jsonReport`.
- A cloud run of a connected folder also has `warnings`, which never stop the run: `unpushed_changes` means the folder has edits the run did not include (listed in `files`) — push and run again, or do a local run; `cloud_changes` means someone pushed a newer version, which is what ran. With `--report`, `jsonReport` and `reportFolder` point at the saved reports.

`--timeout <minutes>` stops waiting (default 30). A cloud run keeps going; a local run's results are then not saved.

**Earlier runs:**

```bash
postman app project runs postman/appTests/Checkout --json          # local runs saved here (l_… ids), newest first
postman app project runs <app test id> --json                      # the test's cloud runs
postman app project report postman/appTests/Checkout --run l_<id> --json   # a saved local run's report folder
postman app project report <app test id> --run <runId> --json      # downloads a cloud run's report
```

Local runs exist only on the machine that ran them. Read `report.json` in the report folder for every test's full errors, output and attachments. The HTML report holds traces and screenshots; it is opened with `npx playwright show-report <reportFolder>`, which serves it until stopped — leave that to the user.

### Where runs and reports are kept

Under `.postman/appTests/`, next to the sync records, never pushed, pulled or committed:

| Path | Holds |
|:--|:--|
| `<id>/runs/l_<runId>/` | Local runs of the folder connected to test `<id>` |
| `local/<folder>/runs/l_<runId>/` | Local runs of a folder not connected yet; they move under the id once it is |
| `<id>/reports/<runId>/` | Downloaded reports of test `<id>`'s cloud runs |

Nothing here is deleted for you, and local runs have no other copy.

---

## Intents

Each spec may have an intents file: `intents/<spec path from the test folder>.yaml`, which push uploads with the test. It holds the user's own words for what each test checks, and how each test came to be. Keep it current on every change; fixes are judged against it.

```yaml
# postman/appTests/Checkout/intents/tests/checkout.spec.yaml
spec: tests/checkout.spec.ts
generations:
  g_1:
    date: 2026-11-24
    prompt: |
      Write a test for guest checkout: one item, pay by card, the confirmation shows the cart total.
tests:
  checkout > guest checkout:
    description: A guest buys one item with a card and sees an order confirmation showing the cart total.
    source: generated            # generated | written
    from: g_1
    history:
      - date: 2026-11-24
        type: created
        request: "Write a test for guest checkout: one item, pay by card, the confirmation shows the cart total."
        summary: Added the test; it adds the first product, pays with the test card, checks the confirmation heading and total.
```

- **`generations.prompt`** — the user's request that generated tests, word for word. Written once; never changed.
- **`tests.<title>`** — keyed by the test's full title, its `describe` blocks and name joined with ` > `.
- **`description`** — what the test checks, as a person would see it on screen. Fixes must still satisfy it.
- **`history`** — one entry per creation, change request or fix: `date`, `type` (`created`, `change`, `fix`), the user's `request` word for word (not for a fix), and a one- or two-line `summary` of what changed in the code, in terms of behaviour. A fix also records `run` (the failing run) and `verifiedBy` (the run that passed with it). An entry that changed the description says `description: changed`.

**Structure comes from the CLI.** `postman app project intent <folder> --json` creates any missing intents file and an empty entry for every test, at the right path and under the exact title; `create` and `connect` run it too. Run it after adding, renaming or moving tests, before filling anything in: it never changes or removes what is there, and lists in `stale` the entries that match no test any more (a renamed test — move its content to the new key, then delete the old one with the user's agreement). The agent's job is the content: descriptions, history entries and the user's confirmation.

Every file the command creates starts with the whole format as a comment, with an example of each field; read it there rather than guessing a field.

### Adding intents to an existing project

Folders that were connected before intents existed, or pulled from the Postman app, have none. When the user asks for intents (for one folder, or every test folder in `postman app project list --json`):

1. Run `postman app project intent <folder> --json` for each folder.
2. For each test with an empty `description`, read its code and suggest one; show the suggestions to the user together, and save only the ones they confirm or correct, with `source: written`.
3. Leave a description empty rather than guess. An empty description is honest: no one has said what the test is for yet.

### When writing tests from a request

1. Write the tests.
2. Run `postman app project intent <folder> --json` for the entries, then in the spec's intents file save the request under a new `generations` entry, and for each new test fill in its `description`, `source: generated`, `from`, and a `created` history entry.
3. Show the user each description and have them confirm or correct it before saving. A description that silently drops a check lets a later fix drop it too.

### On every change request to a test

1. Make the change. If the test has no entry yet, run `postman app project intent <folder> --json` first, and suggest a description from the code for the user to confirm.
2. Add a `change` history entry: the request word for word and a short summary of what changed.
3. If the request changes what the test checks, update `description` to include it, show it to the user, get it confirmed, and note `description: changed`.
4. Keep paths in step: moving or renaming a spec moves its intents file to the mirrored path; then run `postman app project intent <folder> --json`, which adds entries for new tests and lists renamed ones in `stale` — move their content to the new key.
5. Tell the user in one line what was recorded.

### When a test fails

For each entry in `summary.failures`, read its description: open `intentsFile` and take the entry under the failure's `title` with ` › ` replaced by ` > `. When `intentsFile` is absent, the path follows the convention above; if there is no file or no entry, the test has no recorded intent — suggest a description from the code and have the user confirm it before saving.

- **The app can still do what the description says** — the test is out of date. Fix the test, prove the fix with `postman app project run <folder> --json`, then add a `fix` history entry with `run`, `verifiedBy` and a summary.
- **The app can no longer do it** — leave the test alone and report a probable app bug in the description's words: what the test says should happen, and what happened instead.
- **Timeouts, network errors, a pass on retry** — report it as flaky or environmental; change nothing.

An entry for a test that was deleted stays until the user asks to remove it, so its history is kept if the test comes back; `intent` reports it in `stale`.

A fix may change how a test checks, never what it checks: removing or loosening an assertion is reporting an app bug, not a fix. A fix never changes `description`.

---

## Exit codes

| Code | Meaning |
|:--|:--|
| 0 | Success; for `run`, every test passed. |
| 1 | A test failed, the run did not succeed, or the wait timed out. |
| 2 | Usage: no target, a bad option, or `--no-wait` for a local run. |
| 3 | No credential. |
| 5 | A login or setup prompt was declined. |
| 8 | Refused: the test is not in the linked workspace or has no pushed version, no workspace is linked, or the repository is not set up. The message names the fix. |

---

## Critical Rules

1. **Always pass a target.** A folder is a local run: a dry run of the files on disk in the cloud, before a push. An app test id is a cloud run of the pushed version. Never guess which the user meant.
2. **A cloud run uses what was pushed.** Run `postman workspace push` first, or do a local run, when the folder has changes.
3. **Run from the repository root.** The commands do not search parent folders.
4. **Keep intents current on every change to a test,** and never change `generations.prompt`, or a `description` without the user confirming it.

## Anti-patterns

- **Do not open the HTML report from an agent** — `postman app project report` without `--json` or `--no-open`, and `npx playwright show-report`, start a server that runs until stopped. Read `report.json` instead.
- **Do not delete a test folder by hand to stop syncing it** — set `sync: false` on its entry instead.
- **Do not edit the sync records** — `cloudResources.appTests` (folder → test id and version) and the `.postman/appTests/<id>.json` files; push, pull and `connect` write them. Two parts of `resources.yaml` are for the user, or an agent with the user's agreement: the top-level `appTests` block (`include`, `sync`), and `localResources.appTests`, a plain list of folder paths.
- **Do not delete or move anything under `.postman/appTests/<id>/` or `.postman/appTests/local/`** — it is run history, and the only copy of local runs.
- **Do not weaken a test to make it pass** — a failure the description says should not happen is an app bug to report.
- **Do not use `postman app test` to run an application test** — it runs Playwright locally and captures traffic; it has nothing to do with the cloud test.

## Verification

For `postman app project run`, state whether it was a local or a cloud run, the run id (`l_…` for a local run), the passed/failed/flaky/skipped counts, each failure's title and location, any `warnings`, and where the report was saved. For a fix, state which description it was checked against and the run that verified it. For setup, state which test id the folder is connected to, from `postman app project list --json`.
