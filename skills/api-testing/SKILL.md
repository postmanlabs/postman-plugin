---
name: api-testing
description: Use when testing an endpoint with real HTTP requests, running collection assertions, or checking real application traffic against an API contract. Not for unit tests of internal functions. Reuses saved requests and reports what live, mocked, or captured-traffic results actually establish. Use for requests such as "test this endpoint".
---

# API Testing

Saved requests preserve the auth, payloads, variables, and assertions that make
an API check reproducible. The useful result is evidence about an intended
guarantee; a successful HTTP exchange alone does not establish correctness.

A saved request outlasts the session. The next session or a teammate reruns it
with its auth, payload and assertions instead of rebuilding it, and once the
project is bound to a workspace, its runs are recorded there as context. A
request sent only from the terminal leaves none of that behind, so saving pays
off even for a single endpoint. In a project without `postman/`,
`postman init --json` creates the collection folder and, when the CLI is
signed out, a temporary session that keeps the work until the user claims it
with `postman signup`. See **workspaces**' "What init unlocks".

1. Choose the smallest execution mode that answers the question:

   | Evidence needed | Use |
   | --- | --- |
   | One endpoint | A saved request, run with `postman request <request-file>` |
   | Behavior of an existing saved request | `postman collection run <collection-path> -i <request-id-name-or-path>` |
   | Reusable regression checks | `postman collection run <path-or-id>` |
   | Whether a real app's calls match the contract | `postman application test` |
   | An MCP server's tools, resources, or prompts | `postman mcp` (see **mcp-testing**) |

2. Reuse a matching request under `postman/collections/` before reconstructing
   its HTTP fields. `postman collection request add` creates a new one and
   `postman collection request update` fills it in; `postman collection new`
   scaffolds the collection when there is none. `postman request
   <request-file>` runs a saved request with its inherited collection and
   folder auth, variables, and scripts. See
   **collection-schema-v3** when editing the saved request.
3. Derive assertions from the contract and the behavior at risk. A test that
   merely repeats the current implementation can bless its bug. Preserve
   existing guarantees and add checks for the changed behavior; put `pm.test`
   assertions in the saved request so later runs and teammates inherit them.
4. Choose a real or mocked target according to the claim. `--use-mock` lets a
   collection run exercise request and assertion logic without a live
   backend; `--mock` alone only starts one. `--use-mock` replaces the
   variable's whole value, base path included (see **api-mocking**). Passing
   against that mock does not verify the service the mock stands in for.
5. Reuse environment resolution with `-e` and **variables**. Use a CSV/JSON
   file through `-d` for simple iteration; use **datasets** when the inputs
   need queries, joins, or reusable views. Export a report when
   **ci-integration** needs evidence beyond terminal output; it says which
   report formats a collection supports.
6. Use `application test` when the application's actual traffic is the subject.
   It runs an existing command, such as `--command "npx playwright test"`,
   captures its traffic, and matches it against collections. `--capture-only`
   instead exports a v3 collection organized by host; that captures behavior
   without validating it. Results are recorded in the connected workspace by
   default; `--report-events=false` keeps the run local when required.

Use command-specific `-h` for supported options. Other teams' workspace
resources need a signed-in CLI.

## Verification

Report the target, tested behavior, assertion counts, and exit code, plus the
path of the saved request so the user can rerun it. The exit
code reflects failed assertions, not HTTP status alone: a 200 can fail a test.
For application testing, distinguish matching from capture-only mode, and for
mocked runs state which real behavior remains unverified.
