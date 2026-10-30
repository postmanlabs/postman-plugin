# Importing a ReadyAPI / SoapUI project into Postman

> Reference for the `performance-testing` skill. Run the importer, translate the flagged Groovy, review the report, then the result is an ordinary performance run.

Turn a ReadyAPI (SoapUI) project `.xml` into three artifacts:

1. **Postman Collection v2.1** — REST + SOAP + HTTP requests, suites/cases → folders, headers, auth (incl. OAuth 2), properties → variables, assertions.
2. **Performance config** — VU count, duration, load profile, `--pass-if`, and the exact `postman performance run` command, derived from ReadyAPI `<con:loadTest>` definitions.
3. **Import report** — what imported exactly, what was approximated, what needs manual work, what is unsupported.

The files next to this one are the reference: `mapping-table.md` (what each element becomes), `postman-perf-capabilities.md` (the hard limits of the target), `script-translation.md` (ReadyAPI Groovy → JS rules), `loadtest-to-perf.md` (LoadTest → perf config), `import-report.md` (the report's shape).

## Preferred path: the CLI importer

The deterministic conversion is the **same validated converter the hosted ReadyAPI migration service uses**, vendored into the Postman CLI — so the structure (REST/SOAP/HTTP, auth, DataSource loops, environment conversion, property transfers, assertions, variable-scope rewrites, large projects) converts identically on any model, with no tokens:

```bash
postman collection import --type readyapi <project>.xml -o <dir>
```

It writes a collection where **every Groovy script becomes a `[MANUAL TRANSLATION REQUIRED]` placeholder** (a `[Groovy] <name>` request, or a request's test script) with the **original Groovy preserved inline as comments**. The CLI does no LLM work — translating that Groovy is your job (next step). If the installed CLI predates `--type readyapi`, fall back to the by-hand path at the bottom.

## Workflow

### 1. Import

Run the command above. Read the output tree: `APIs/` (the interface request library) and `Tests/` (the suites/cases). The Groovy placeholders are the only thing left to finish.

### 2. Translate the Groovy placeholders (this is the model's job — your tokens)

Find every `[MANUAL TRANSLATION REQUIRED]` marker in the imported scripts. Each carries the original Groovy as inline comments. Translate each to Postman `pm.*` JavaScript using the exact rules in **`script-translation.md`** (those are the hosted service's own tuned translation rules). Two kinds:

- **Script steps / setup / teardown** — plain pre-request/test JS; do **not** wrap in `pm.test()`.
- **Script assertions** — wrap in `pm.test()` with `pm.expect()`.

Replace the placeholder body with the translation. Keep a `// REVIEW` line on anything you're unsure of and list it under "Needs manual work". For many scripts, translate in chunks and fan out to parallel subagents where the host supports it.

### 3. Validate

Confirm the collection is valid v2.1 and **every `event` script parses as JavaScript** (`node --check` each `exec`, or equivalent). A syntax error is invisible in the file and only surfaces mid-load when the perf run executes that request. If the CLI ships `postman collection lint --readyapi`, run it — it checks the schema, that every script parses, that scripts call only real `pm.*` APIs, and that no `[MANUAL TRANSLATION REQUIRED]` markers remain.

### 4. Performance config (LoadTest → perf run)

The CLI importer converts structure; it does **not** build the perf config. Derive it from the project's `<con:loadTest>` definitions using **`loadtest-to-perf.md`**: thread count → `--vu-count`, time limit → `--duration`, strategy → one of `fixed`/`ramp-up`/`spike`/`peak`, and the tightest LoadTest assertion → the single `--pass-if` (operator-first syntax, e.g. `less_than(p95, 500)`). Write the `postman performance run` command.

Each LoadTest targets exactly its parent TestCase, so **scope the run to that case** — publish a per-case collection (or a verified folder), never the whole imported collection, which also holds `APIs/` examples and unrelated cases (see `loadtest-to-perf.md`). And **keep placeholder requests out of the measured workload**: the Groovy/JDBC/DataSource/delay requests are sendable so a functional run won't break, but in a perf run each fires a real HTTP sample — fold their scripts into the following real request's `prerequest` and drop the placeholders (see `mapping-table.md`).

### 5. Report

Fill in `import-report.md`'s sections and counts so the report matches the collection you're handing off, including the Groovy you translated and anything still flagged.

### 6. Hand off the perf config

The command needs a collection UID, so the collection must be in a workspace first — and it must be the **per-case** collection (or verified folder) from step 4, not the whole import. The `--pass-if` value is a suggestion, and where it came from a per-step ReadyAPI gate it is an approximation of an aggregate — say so. Surface the VU/duration/profile/pass-if choices for the user to adjust.

### 7. (optional) Publish to a Postman workspace

Only on explicit user consent — and **never make the user paste a workspace ID**. Pick the destination like this:

- **If the current folder is already a connected workspace** (the usual headless case), use it — `postman workspace push` targets the workspace bound to this directory, no ID. Just tell the user which one.
- **If the user named a workspace** (by name), resolve it with `postman workspace list --json` and match.
- **Otherwise present a choice, don't demand an ID.** Run `postman workspace list --json`, show the **names**, and ask the user to pick one *or* create a new one:
  - **pick existing** → `postman workspace pull <id>` (ID from the list), then push.
  - **create new** → the CLI has no `create`; make it via MCP `createWorkspace` (or the Postman app), then `pull` and push.
- **Get the imported collection into the bound workspace before pushing.** A pulled workspace is a git-native v3 tree; bring the import in with `postman collection migrate` (check `-h`) into the workspace's collections directory, then `postman workspace push`.
- **Push through the CLI, not MCP.** MCP `createCollection` drops each request's URL (requests land blank); use MCP only if the `postman` binary genuinely can't be installed, and repair URLs afterward.
- Interrogate `postman <cmd> -h` for exact flags — the help is authoritative, this file is not.

Smoke-test with `postman collection run` — the **same runtime that executes the perf test** — then wire the returned UID into the perf command.

## Fallback: by-hand (no CLI, or an older CLI without `--type readyapi`)

Read the project XML and build the three artifacts yourself, following the references. ReadyAPI's structural rule: a project holds `<con:interface>` definitions + `<con:testSuite>`s; each suite holds `<con:testCase>`s; each case holds ordered `<con:testStep>`s (`restrequest` / `request` (SOAP) / `httprequest` / `properties` / `transfer` / `groovy` / `jdbc` / `datasource`) and optional `<con:loadTest>`s. Use `mapping-table.md` for every element, `script-translation.md` for Groovy, `loadtest-to-perf.md` for load. State clearly that this was a by-hand conversion (no deterministic importer), so it's best-effort.

## Scope limits (hard facts, verified against the CLI/engine code)

- Performance runs execute **one collection repeated across VUs**. Multiple LoadTests cannot run concurrently in a single run — each becomes its own `postman performance run`.
- Runs are **time-based**, not run-count-based. ReadyAPI "Total Runs" limits become a duration.
- `--pass-if` is a **single, non-repeatable** condition. Extra LoadTest assertions stay as notes.
- **No think time / no DB connectivity.** ReadyAPI test delays and JDBC steps are not reproduced; they're reported (JDBC → a `[JDBC - To Do]` placeholder to repoint at a read-only query API).
- **No XPath/XQuery engine** in the sandbox; those assertions need a JSON rewrite or a `require()`'d parser.
