---
name: gatling-to-postman
description: Convert an existing Gatling load-test project (Java, Kotlin, Scala or JS/TS simulations) into a Postman collection plus a `postman performance run` configuration, with a gap report listing everything that could not be carried over exactly. Use when the user wants to "migrate from Gatling," "import a Gatling simulation," "convert Gatling to Postman," or move Gatling load tests into Postman Performance Testing. Verification sends one iteration of real requests against the target, so confirm the target first — the same way any action with effects outside this session gets confirmed.
---

# Gatling → Postman migration

## Overview
A Gatling simulation is code: a scenario of `http()` requests, checks, feeders,
pauses and flow control, plus a `setUp` that injects load and asserts on
results. Postman splits the same thing in two:
- the **collection** (requests, test scripts, variables, data file), and
- the **run config** (`postman performance run` flags: VUs, duration, load profile, pass criteria).

You do the translation. Two bundled scripts keep you honest:
`scripts/inventory.py` lists every construct in the source (your checklist), and
`scripts/verify.py` checks that every one of them landed somewhere or is
explained in the gap report, and that the collection actually runs.

A conversion that runs but silently drops a check, or quietly changes the load
model, is worse than no conversion, because the user will trust the numbers.
**The gap report is a first-class output, not an apology.**

## Workflow
Below, `<skill-dir>` means this skill's directory and `<out>` means `out/<simulation-slug>/`. **Write them out as literal paths in every command.** Don't set shell variables (`export X=…`, `$X`) or chain commands with `&&`: pre-approved commands containing expansions or several operations trigger permission prompts.

1. **Discover.** Find the simulation(s): classes that `extends Simulation`,
   Kotlin `: Simulation()`, or JS/TS `simulation((setUp) => …)`. Note the language
   and build tool. If there is more than one simulation, ask which to convert.
   Convert one simulation per `OUT` directory.
2. **Inventory.** Run `python3 <skill-dir>/scripts/inventory.py <project> -o <out>/inventory.json`.
   Read the whole inventory. Then read the source and look for anything the
   script missed (requests built in loops or helper methods, dynamic names).
   Add those to `manifest.json` → `found_by_model`, each with a new id.
3. **Translate** each item using the references:
   - `references/mapping.md`: requests, EL, checks, protocol settings, groups, flow control, custom code
   - `references/feeders.md`: feeders → data file + distribution
   - `references/injection.md`: injection profiles, throttle, assertions → run flags
   - `references/unsupported.md`: what becomes a gap, and how to word it
4. **Write outputs** to `<out>` (formats below).
5. **Verify.** The full run `python3 <skill-dir>/scripts/verify.py <out>` includes a
   **smoke** step that sends **one iteration** of the converted requests to the target
   host(s). Before running it, name the host(s) and wait for a yes for any host that is
   not local. If the user declines, can't reach the target, or you have no CLI login /
   network, run `python3 <skill-dir>/scripts/verify.py <out> --no-smoke` instead — this
   runs all the static checks (accounting, targets, collection, variables, secrets, run.sh)
   but **does not execute any request**. Fix every `FAIL` and re-run, up to 3 rounds.
   `WARN` lines (test failures) need an explanation in MIGRATION.md if they come from the
   conversion; if they come from the target, say so. A `--no-smoke` PASS means the
   artifacts are well-formed and accounted for, **not** that any request ran — say so when
   you report, and recommend the user run the smoke (or `run.sh`) against an authorized target.
6. **Report** to the user: counts (mapped / approximated / gap), the verify
   result, and the top 3 things they must do by hand. Point them to MIGRATION.md.

## Output formats
### `collection.json`: Postman collection v2.1
- `info.schema` = `https://schema.getpostman.com/json/collection/v2.1.0/collection.json`
- `info.description` is a plain string whose first line is exactly `imported-from: gatling` followed by two lines `source: <relative source path>` and `class: <simulation class/name>`. Example: `"imported-from: gatling\nsource: src/test/java/poc/BasicSimulation.java\nclass: BasicSimulation"`. (`verify.py` substring-checks `imported-from: gatling`; keep this format so two conversions read the same.)
- One collection per simulation. One folder per Gatling `group`; with **no** groups, requests sit at the collection root (that is valid — a bare request name with no folder prefix). Requests keep their Gatling names exactly (they drive per-request metrics), and **request leaf names must be unique** (`verify.py` fails duplicate request paths — see `repeat` in mapping.md).
- Base URL → collection variable `baseUrl`. Requests use `{{baseUrl}}/path`.
- Each request's test script ends with the translated checks. Mark translated custom code with `// REVIEW: translated from Gatling custom code (<inventory id>)`.

### `environment.json`: Postman environment
`{"name": "<simulation> (from Gatling)", "values": [{"key": "...", "value": "...", "enabled": true}]}`.
Secrets become keys with an **empty value** and `"type": "secret"`. Never copy a
secret literal from the source (see Critical rules). This file holds **secrets and
externalised config only** — `baseUrl` and correlation values are collection variables, not
environment keys. **Always write the file**, even when there is nothing to put in it: a
simulation with no secrets and no externalised config gets `"values": []`. (An empty
environment is correct and expected, not a defect.)

### `data/<name>.csv`
Copy feeder files that the simulation uses. Convert JSON array feeders to CSV if they are flat. If the simulation has **no feeder**, don't create a `data/` directory at all (and omit `--data-file` from run.sh).

### `run.sh`
```bash
#!/usr/bin/env bash
# Converted from <Simulation>. Replace <collection-uid> after pushing the collection to a workspace.
postman performance run "<collection-uid>" \
  --vu-count 20 --duration 5 --load-profile ramp-up \
  --data-file data/users.csv \
  --pass-if "less_than(error_rate, 1)"
```
Only flags that exist in `postman performance run --help` (check the user's installed
version; don't assume a flag from a newer CLI). Duration is in whole minutes, rounded up.
- `--data-file` only if the simulation has a feeder; **omit the line entirely** when there is none (don't invent a data file).
- `--pass-if`: **at most one**, chosen by the strict priority in `injection.md` (error-rate, then latency percentile, then mean/rps) — this overrides source order. If **no** source assertion matches any category, **omit `--pass-if` entirely**. Every non-chosen assertion goes to the gap report.

### `MIGRATION.md`: gap report
Sections, in order:
1. **Summary**: source, counts (mapped / approximated / gap), verify result. The counts here **must equal** the manifest tally (count the `items` + `found_by_model` statuses); derive them from `manifest.json`, don't hand-write them. `verify.py` checks the manifest tally but not this prose, so a mismatch ships silently unless you reconcile.
2. **Load model**: the original injection profile, the chosen flags, and the working (see `injection.md`). This section is required even when the mapping is exact.
3. **Approximations**: one bullet per approximated id: `` `<id>` ``, what changed, why, what to check.
4. **Gaps**: one bullet per gap id: `` `<id>` ``, what was dropped, why, and the manual workaround if there is one.
5. **Secrets**: which environment keys the user must fill in.
6. **Next steps**: push the collection, fill secrets, run a short test, compare with a Gatling baseline.

Every `approximated` or `gap` id **must appear verbatim** in MIGRATION.md.

### `manifest.json`: accounting (read by `verify.py`)
```json
{
  "source": "src/test/java/poc/BasicSimulation.java",
  "simulation": "BasicSimulation",
  "items": {
    "scenario:browse":       {"status": "mapped", "target": "note:scenario → the collection itself"},
    "group:catalog":         {"status": "approximated", "target": "collection:catalog", "note": "folder; no folder-level timing"},
    "req:list-items":        {"status": "mapped", "target": "collection:catalog/list items"},
    "check:list-items#2":    {"status": "mapped", "target": "collection:catalog/list items › test: args.page is 1"},
    "check:login#1":         {"status": "approximated", "target": "collection:login › test: saveAs token", "note": "saveAs: soft test, not Gatling hard-fail"},
    "proto:baseurl":         {"status": "mapped", "target": "collection-variable:baseUrl"},
    "proto:header:accept":   {"status": "mapped", "target": "collection:catalog/list items › header: Accept; collection:login › header: Accept", "note": "protocol header on every request"},
    "inj#1":                 {"status": "mapped", "target": "run:--vu-count; run:--load-profile; run:--duration"},
    "assert#2":              {"status": "gap", "note": "lost the --pass-if priority tie-break; the CLI takes one --pass-if"},
    "secret#1":              {"status": "mapped", "target": "environment:apiKey", "note": "placeholder, value not copied"}
  },
  "found_by_model": [],
  "run": {"data_file": null}
}
```
- `status`: `mapped` (same behaviour), `approximated` (close but different: explain), `gap` (not carried over).
- `target` (required unless `gap`): one or more of `collection:<folder>/<request>[ › detail]`, `collection-variable:<key>`, `environment:<key>`, `data:<path>`, `run:<flag>`, `note:<text>`, separated by `; `. Idioms for items that aren't a single request:
  - **scenario** → `note:scenario → the collection itself` (there is no "whole collection" target kind; `note:` is correct).
  - **group** → `collection:<folder>` (the folder name; `verify.py` resolves a folder by prefix match).
  - **protocol setting on every request** (e.g. `acceptHeader`) → list each request it lands on, joined by `; ` (`collection:a › header: Accept; collection:b › header: Accept`). There is no wildcard; name them.
  - **`saveAs` correlation** → `collection:<req> › test: saveAs <var>` — the script sets it at run time, so it is **not** a `collection-variable:` (that kind only resolves variables declared in the collection's `variable` array, and the target check will fail).
  - **`note:` free text must not contain `; `** — targets are split on `; `, so a semicolon inside a note is read as a second (broken) target. Use commas or dashes inside note text. Keep notes short; put the prose in MIGRATION.md.
- `run.data_file`: the data file verify should pass to the smoke run, or `null`.

## Critical rules
1. **Never copy a secret literal into any output.** That covers the collection, environment, run.sh, MIGRATION.md and manifest notes. Items of kind `secret` become an environment key with an empty value, and MIGRATION.md tells the user to fill it in. Don't put secrets in descriptions or metadata either.
2. **Never drop an item silently.** Every inventory id gets a manifest entry. If you aren't sure, choose `approximated` or `gap` and explain. Don't choose `mapped`.
3. **Never change the load model silently.** Open-model (arrival-rate) injection has no exact equivalent. Always show the conversion arithmetic in MIGRATION.md → Load model.
4. **Confirm before sending traffic.** Verification sends one iteration to the target. Get a yes for any non-local host first. Never run `postman performance run` yourself; the user runs `run.sh`.
5. **Keep request names identical** to the Gatling `http("…")` names, so results can be compared with old Gatling reports.
6. **Don't claim done until `verify.py` prints `RESULT: PASS`.** If you can't get it to pass in 3 rounds, stop and report what is still failing.
