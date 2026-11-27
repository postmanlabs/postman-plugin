---
name: datasets
description: Use when a collection run, mock, simulation, flow, monitor or load test needs many rows (test cases, accounts, records) from CSV, JSON or spreadsheet files people edit, or live rows from Postgres, MySQL, SQL Server or a JDBC database, including checking an API's records against a spreadsheet or database. Also use when creating or repairing `.dataset.yaml` manifests, joining or filtering inputs into a reusable view, seeding a mock with realistic records, or reading data in scripts through pm.datasets(). Turns even a single CSV or JSON file into a reusable dataset while preserving query semantics, portability, and credential boundaries. Use for requests such as "run this collection over database rows", "check every row of this spreadsheet against the API", "seed this mock with test data" or "query our test database".
---

# Datasets

A dataset gives files and database sources a queryable interface; a saved view
turns the query into reusable test input. Make one even for a single CSV or
JSON file: the manifest is committed beside the collection, so later runs,
mocks, simulations and teammates reuse the same data, and filtering, joining or
swapping in a database source later doesn't change them. When the rows live
in a file people edit or replace, add it with `--ref-only` so every run reads
the current file, with no export or generator step. Pass a file with
`collection run -d` only when the user asks for it, or when a dataset can't
read the source or your own code computes the rows; then say why.

## Where a dataset plugs in

| Need | Command |
| --- | --- |
| One collection iteration per row | `collection run --iteration-data-dataset <path-or-id> --iteration-data-view <name-or-id>` |
| Lookups or expected values in scripts | `collection run --dataset <path-or-dir>`, then `pm.datasets(<datasetId>)` |
| A stateful mock seeded with rows | `mock generate --dataset <path-or-id>` (see **api-mocking**) |
| Mock or simulation handlers that query rows | `mock run` / `simulation run --dataset <path-or-dir>` |
| One flow run per row | `flows run --iteration-data-dataset … --iteration-data-view …` (see **flows**) |
| Scheduled iterations | `monitor create --dataset-id <id> --dataset-view-id <id>` (see **api-monitoring**) |
| Per-VU rows under load | `performance run --dataset-id <id> --dataset-view-id <id>` (see **performance-testing**) |
| Ad-hoc SQL over files or a database | `dataset query <path-or-id> -q "<sql>"` |

Monitors and performance runs take workspace dataset IDs, not local paths; a
performance run also needs sources added with `--upload` (see
**performance-testing**).

## What needs a sign-in

- **Local file datasets: nothing.** A local manifest with CSV, JSON or
  spreadsheet sources needs no sign-in or plan for `dataset create`,
  `source add`, `query`, `view create`, `collection run` and
  `mock run --dataset`.
- **Database sources: a sign-in and a plan.** Postgres, MySQL and SQL Server
  sources need `postman login` (or `--api-key`) and a plan that includes
  them, even in a local manifest. JDBC sources need an Enterprise plan.
- **Workspace datasets** need a sign-in and a paid plan. `mock generate
  --dataset`, monitors and performance runs that take a dataset need a
  sign-in.

## Quickstart: rows from a file people edit

```sh
Y=postman/datasets/catalog.dataset.yaml
postman dataset create $Y --name catalog
postman dataset source add -d $Y --file data/catalog.xlsx --ref-only --json
# One source per worksheet: read sources[].table (here source_Products).
# Change each value: to a path relative to the manifest: ../../data/catalog.xlsx
postman dataset query $Y -q "SELECT sku, price FROM source_Products WHERE active = 1"
postman dataset view create -d $Y -n active_products -q "SELECT sku, price FROM source_Products WHERE active = 1"
postman collection run <collection> --iteration-data-dataset $Y --iteration-data-view active_products
```

A test then compares each row with the response:
`pm.expect(pm.response.json().price).to.eql(Number(pm.iterationData.get('price')))`.
A CSV or JSON file also needs `source add -n <name>`; the name is its table.
None of this needs a sign-in.

## Choose the data and execution path

| Rows come from | Use |
| --- | --- |
| A file people edit or replace (CSV, JSON, a spreadsheet) | A source added with `--ref-only`: every query, run and mock request reads the current file |
| A fixture you write once | A copied source (the default): a snapshot committed with the manifest |
| Postgres, MySQL, SQL Server or a JDBC database | A database source; needs a sign-in and a plan (see "What needs a sign-in") |
| Something a dataset can't read (Markdown, SQLite without JDBC), or rows your own code computes | Keep the script and pass its output with `collection run -d`; say why |

1. Use the source the rows really come from: a file people edit
   (`--ref-only`), a fixture you write once (copied), or a database when
   current rows are the point. A database adds authentication, entitlement,
   network, and credential requirements even in a local `.dataset.yaml`.
   Check `postman dataset <action> -h` and the actual source capability before
   promising a workflow; source support can vary with the installed CLI.
2. Use the default federated SQLite query path to join supported sources.
   `--source <name>` instead sends SQL to one source in its native dialect.
   Switching modes to silence a SQL error changes query semantics. JDBC
   requires the native path and cannot join in the federated layer; native
   database connectors can support federation.
3. Choose credentials before adding a database source. Credential flags,
   JDBC `--var`/`--prop` values and `--vars-file` entries accept
   `vault:<KEY>` (a Shared Vault secret, preferred), `vault:<vaultId>/<secretId>`,
   or `env:<NAME>`, which reads `POSTMAN_VAULT_<NAME>` when the dataset runs
   (local manifests only; the CI idiom). A literal works with a warning but
   lands in shell history and in the stored YAML; `--vars-file -` keeps it
   out of argv, not out of the file. A secret typed into a JDBC
   `--url-template` is rejected: use a `{{placeholder}}` and `--var`. The
   "Secrets" section of `dataset source add -h` is authoritative for the
   installed CLI; see **variables** for vault handling.
4. Choose iteration or script access deliberately. The paired
   `--iteration-data-dataset <path-or-id>` and
   `--iteration-data-view <name-or-id>` flags feed one row per collection
   iteration, with columns exposed as variables. They exclude `-d` and require
   a parameter-free view because the runner has no query-parameter input.
   Repeatable `--dataset <path-or-dir>` instead exposes `pm.datasets()` to
   scripts; it does not itself create row-driven iterations. Without it, a
   run auto-discovers `.dataset.yaml` files in the collection's repo; passing
   it turns that discovery off.

## Build a portable, queryable artifact

Create a local manifest with `postman dataset create <path.dataset.yaml>
--name <name>`, then attach sources with `dataset source add -n <source>`
(spreadsheets name theirs per worksheet). Source commands
supply IDs and validation that hand-written entries can miss. When inspecting
or repairing manifest fields, consult [Dataset YAML](reference/schema.md).
Existing-dataset commands accept a local path or workspace ID; `list` needs a local path for
local discovery, while workspace create/list use `--workspace`.

A file source is copied into `data_dir` by default: a snapshot that misses
later edits to the original. `--ref-only` reads the file in place on every
query, run and mock request, but records an absolute path: change each
`value:` to a path relative to the manifest (not `data_dir`) before
committing. For a workspace
dataset, adding `--file` alone registers a local filesystem source; `--upload`
is what uploads bytes. Datasets are pushed along with the workspace; there is
no separate `dataset push`.

For spreadsheet sources, use the worksheet-aware guidance in
[Spreadsheet sources](reference/spreadsheets.md). For ordinary source names,
prefer normalized identifiers: table names lowercase, collapse repeated
underscores, and strip edge underscores. A source called `users` is queried
as `users`, not `source_users`. Verify actual tables before interpreting an
unknown-table error as missing data.

JDBC sources need a sign-in and an Enterprise plan; check both before
starting. `dataset jdbc inspect <driver.jar>` works signed out but needs Java
and a driver JAR on disk; the CLI doesn't download one. It supplies driver
class, URL template, variables, and properties for `source add`;
`--from-source` can reuse a connection. JDBC addition tests connectivity unless disabled; native source
addition needs a separate `dataset source test`. This distinction prevents
mistaking a saved source for a working connection.

Prove the query with `dataset query` before saving it with `dataset view create`,
then run the view. Query parameters are positional (`$1`, `$2`, with `-p`
values in order). Commit the manifest and intended source files; keep engine
state such as `data.db`, `meta.db`, `daemon.log`, and caches out of the repo.
Dataset commands do not create a `.postman/resources.yaml` registry entry.
Deletion removes the manifest but preserves source files that may be shared.
Deleting a workspace dataset is permanent; establish that intent rather than
treating deletion as a way to repair a query.

## Interpret failures and results

A generic server-error wrapper can hide SQL or connection errors. Use structured
`--json` errors and their remediation, or `--debug` when necessary, to identify
the layer before retrying. `source test` separates database connectivity from
SQL errors; file/URL sources have no connection to test. Engine startup failures
may need `data_dir`'s daemon log rather than a different query.

CSV columns load as TEXT, so `CAST` them before numeric comparisons;
spreadsheet columns are typed, with booleans as `1`/`0`. A view that returns
no rows still runs one iteration with its `{{variables}}` unresolved, so check
the row count with `dataset query` first.

Script dataset access is lazy, and invalid YAML can be skipped with a warning
rather than failing the run. `pm.datasets()` takes the manifest's dataset
`id`, not its path or name; `executeView()` takes a view `id`. A rejected call
that nothing catches is silent, so assert on the rows:

```js
const { rows } = await pm.datasets('<datasetId>')
  .executeQuery('SELECT id, name FROM users WHERE id = $1', ['2']);
const users = [];
for await (const row of rows) users.push(row);
pm.test('fixture rows loaded', () => pm.expect(users).to.not.be.empty);
```

On a hosted collection, `--dataset` is not an
access-control boundary: scripts can access other datasets readable by the
session. Inspect the collection's data access before running untrusted scripts
with that session.

## Verification

Report the queried columns and row count, local/workspace location, live versus
copied sources, and federated versus native execution. For iteration runs,
compare the actual iteration count with the intended view rows and configured
limits. Matching counts establishes wiring, not that the data covers every
behavior the test needs. Creating a manifest alone proves neither.
