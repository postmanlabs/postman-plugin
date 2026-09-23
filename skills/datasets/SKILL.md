---
name: datasets
description: Turns CSV/JSON files and live databases into one queryable SQL surface, then drives collection runs from it — one iteration per row — or exposes it to scripts as `pm.datasets()`. Use when the user asks to "run this collection against my test data," "drive iterations from a CSV/database," "query my data with SQL," "join data across sources," or "use a Postman dataset." Covers `postman dataset` and the `--iteration-data-dataset`/`--dataset` flags on `collection run`. Needs nothing from bootstrap for file-backed datasets, which work fully offline; database-backed sources need `postman login` and a paid plan even when the dataset is a local file.
---

# Datasets

## Overview

A dataset is a `.dataset.yaml` manifest that names one or more *datasources*
and presents them as SQL tables. It is not a data file — it is a layer over
data files and databases, and the value is in that layer: heterogeneous
sources (a CSV and a Postgres table) become joinable in one query, and a
saved *view* turns a query into a named, reusable result set that a
collection run can iterate.

Local and cloud are the same commands. Every verb takes either a
`.dataset.yaml` path or a cloud dataset id and routes accordingly; `list`
and `create` use `-w <workspaceId>` for the cloud form. Nothing promotes a
local dataset to the cloud — unlike `mock push`, there is no push. A local
and a cloud dataset are separate things you create separately.

## Core knowledge

- **A datasource's `name` is its SQL table name.** `-n users` means
  `FROM users`. **The CLI's own `-h` examples say `FROM source_users`, and
  they are wrong** — there is no prefixing logic in the code, and
  `source_users` fails with `SQL_UNKNOWN_TABLE`. Trust the source name you
  passed, not the example text.
- **Federated vs native is the central query decision.** With no `--source`,
  the query runs through a federated SQLite layer that can join across every
  source in the dataset. With `--source <name>`, it is sent to that one
  datasource in *its own SQL dialect* — which is the only thing that works
  for JDBC sources, and what you want for dialect-specific SQL
  (`now() - interval '1 day'`). `dataset query -s` and
  `dataset view create -s` take the same reference. They are different
  execution paths, not fallbacks for each other — adding or dropping
  `--source` to make a failing query work changes what the query *means*.
- **Local does not mean free, and the plan gate keys off source type, not
  dataset location.** CSV/JSON sources run fully offline, logged out. Any
  *database* source — including one inside a purely local YAML — forces
  authentication and an entitlement check: MySQL and PostgreSQL need a paid
  plan, and **JDBC and SQL Server need Enterprise**
  (`… data sources require an Enterprise plan.`, HTTP 402).
- **A view's result set is iteration data.** `collection run
  --iteration-data-dataset <pathOrId> --iteration-data-view <nameOrId>`
  runs one iteration per row, with each column bound as a variable
  (`{{name}}`). Both flags are required together, and the pair is mutually
  exclusive with `-d/--iteration-data`. Both are marked BETA.
- **`--dataset <pathOrDir>` is the other consumption path** — repeatable,
  and it exposes datasets to scripts as `pm.datasets(<id>)` rather than
  driving iterations. Resolution is lazy: a run that never calls
  `pm.datasets` parses nothing and needs no auth. An unparseable YAML is
  skipped with a `[pm.datasets] skipped …` warning, not a failed run — so a
  silently absent dataset looks like a script bug.
- **Query parameters are positional.** `$1, $2` in the SQL, `-p` values in
  order. Views can be parameterized too, but a parameterized view **cannot**
  drive iteration data — `collection run` has nowhere to pass `-p`, and it
  fails as an opaque execution error. Keep iteration views parameter-free.
- **Dataset commands never touch `.postman/resources.yaml`.** Unlike mocks,
  there is no repo-level registry entry to commit or clean up — the
  `.dataset.yaml` and its `data_dir` are the whole artifact.
- **`data_dir` is not only your data.** The local engine writes its own state
  in there next to the copied files — `data.db`, `meta.db`, `daemon.log`,
  `config/`, and a uuid-named directory. Commit the manifest and the source
  files; ignore the rest, or the repo starts carrying a query cache and a log.
  `daemon.log` is also the first place to look when the engine itself, rather
  than a query, is what failed.

## Process

1. **Scaffold.** `postman dataset create ./postman/datasets/NAME/NAME.dataset.yaml
   --name "NAME"` writes a four-line manifest with a generated id and
   `data_dir: .resources`. The cloud form is `create --name "NAME" -w <workspaceId>`
   with no path.
2. **Attach sources.** `postman dataset source add -d <dataset> -n <table>
   --file ./users.csv` **copies** the file into `data_dir` — pass
   `--ref-only` to reference it in place instead — but note it records an
   **absolute** path, so a `--ref-only` dataset is machine-local and does not
   survive being committed and cloned elsewhere. Extensions
   pick the format only when `--format` is absent; contents are never
   sniffed, so a `.txt` holding JSON needs `--format json`. For a cloud
   dataset, `--file` alone registers a *local-filesystem* source read by the
   local engine; `--upload` is what actually puts the data in the cloud.
3. **For a database source, start from `jdbc inspect`.**
   `postman dataset jdbc inspect ./drivers/pg.jar` maps straight onto the
   `source add` flags: `suggestedUrlTemplate` → `--url-template`,
   `templateVariables` → `--var`, `connectionProperties` → `--prop`,
   `driverClass` → `--driver-class`. A second source on the same database
   reuses all of it with `--from-source <name>`. A connection test runs
   before the write, so a source that cannot connect is never persisted.
4. **Explore with ad-hoc SQL before saving anything.**
   `postman dataset query <dataset> -q "SELECT …"`. Get the query right
   here — a view is just a query you have already proven.
5. **Save the query as a view.** `postman dataset view create -d <dataset>
   -n "Active" -q "SELECT …"`, then `view run "Active" -d <dataset>` to
   confirm the rows. This is the step that makes the dataset usable by a
   run.
6. **Drive the run.** `postman collection run <collection>
   --iteration-data-dataset <dataset> --iteration-data-view "Active"`.
   Confirm the iteration count matches the row count — that is the only
   proof the wiring works.

## Critical rules

1. **Never put a literal secret in a flag.** `--user`, `--password`, and
   `--var` values land in `ps` output, shell history, **and in clear text in
   the dataset YAML** (or the cloud request body). Use
   `--var name=vault:<vaultId>/<secretId>` for a Shared Vault reference, or
   `--vars-file -` to read a JSON object from stdin and keep secrets out of
   argv entirely. Local Vault secrets are not supported by the CLI — Shared
   Vault only. A literal secret written into `--url-template` is rejected
   outright, because a literal has no `{{name}}` to route through `--var`
   and nothing would mask it.
2. **"The dataset operation failed with a server error. Please retry." is
   usually not a server error and retrying will not help.** It is the
   generic wrapper over engine errors, including your SQL being wrong.
   Re-run with `--debug` to get the real code — `engineCode=SQL_UNKNOWN_TABLE`
   for a bad table name, and so on. Read that before changing anything.
3. **When a query fails, isolate the layer with
   `postman dataset source test -d <dataset> -n <source>`.** It opens and
   closes a real connection using the stored config, resolving Vault
   references the way a query would, which separates "the source is broken"
   from "the SQL is wrong". File and URL sources have no connection and
   report `SOURCE_NOT_TESTABLE` — that is the expected answer, not a fault.
4. **`--dataset` on a cloud collection does not scope access.** A script can
   call `pm.datasets(<anyId>)` for any dataset the logged-in session can
   read. Only run collections you trust against a logged-in cloud session.
5. **`dataset delete` is permanent and deliberately asymmetric** — it
   removes the manifest but preserves the source files, because references
   can cross directory boundaries. An empty `data_dir` is removed unless
   `--keep-resources` is passed. Confirm before running it on a cloud id,
   where there is no file left behind to recover from.
6. **Pass `--json` when parsing.** Both success and failure go to stdout, so
   `--json 2>/dev/null | jq .` works either way, and failures carry a stable
   `error.code` (`CONNECTION_FAILED`, `DRIVER_CLASS_AMBIGUOUS`,
   `CONFIG_VALUE_MISSING`, …) plus `remediation`. Branch on the code, never
   on the prose.

## Anti-patterns

- **Don't add a database source to make a demo "more realistic."** It
  converts a zero-setup offline dataset into one that needs login, a paid
  plan, network reachability, and (for JDBC/SQL Server) Enterprise. Use CSV
  unless the live data is the point.
- **Don't run `postman dataset list` with no arguments** expecting the local
  datasets. Bare `list` is the *cloud* form and errors without `-w` outside
  a Postman-managed project; pass a path or directory for local ones.
- **Don't hand-edit `.dataset.yaml` to add a source.** `source add` runs the
  connection test, id generation, and secret validation that a hand-edited
  entry skips — and the resolver re-inspects every YAML precisely so a
  hand-edited file cannot bypass the source gate.

## Verification

A dataset is not working because `create` and `source add` exited 0 — those
only prove the manifest parses. Run an actual query and state the row count
and columns you got back. For a run, state the iteration count and confirm
it equals the view's row count; three rows producing one iteration means the
view, not the collection, is what to look at. Say which execution path ran
(federated or `--source` native) and whether the dataset was local or
cloud — that determines whether the numbers reflect live data or a copied
snapshot in `data_dir`.
