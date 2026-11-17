---
name: mcp-testing
description: Use when checking, debugging or writing tests for an MCP server, local or remote, whoever built it. Use for requests such as "does my MCP server work", "why does this tool call fail", "connect to this MCP URL" or "make sure these tools keep working". Not for using Postman's own MCP tools on a workspace; that is postman-mcp-server.
---

# MCP Testing

`postman mcp` is a scriptable MCP client in the CLI, not only in the app. Each
command connects to one server, does one operation and disconnects;
`postman mcp -h` has the targets, credential order and exit codes. If the
command is missing, update the CLI rather than conclude Postman cannot do this.

One `postman mcp tools call` answers whether a tool works. Save the call as an
MCP request (`postman collection request add --type mcp`) when the check should
outlive the session: `collection run` repeats it locally and in CI with the same
transport, auth and scripts, so what you proved by hand is what CI checks.

Take expectations from the tool's contract: its `inputSchema`, `outputSchema`
and description, which are what a calling agent relies on. A test copied from
the output the tool just returned only proves the server agrees with itself.

## Results that mislead

- **`tools call` checks some schema rules before sending**: it blocks a call
  that breaks one of them (exit 2) and sends one that breaks another. To test
  how the server handles bad input, save the call as a request message, which
  is sent as written.
- **Exit 4 from `inspect`**: one list method failed, often an optional one such
  as `resources/templates/list`. The rest of the server may be fine.
- **Sampling and elicitation** are declined, because a one-shot client cannot
  answer them. A tool that needs them fails here, not in an agent's client.
- **The stdio command is split at every space** (CLI 1.90.0), so no
  argument can contain one, and a script given by absolute path cannot take
  arguments; use a relative path.

## Script hooks

Each MCP request runs its scripts at four points. Put each script where its
job belongs:

- `beforeConnect` is setup, before the session opens: a value unique to the
  run, or a token.
  `pm.request.headers.push({ key: "Authorization", value: "Bearer " + pm.variables.get("token") })`
  sends the token on every call in the session. Headers are a `{key, value}`
  array; assigning an object is silently ignored.
- `afterConnect` tests the server itself: `pm.response.tools`, `resources`,
  `prompts`, `capabilities`, `server`, `protocolVersion` and `instructions`. A
  request with no message only connects, so it checks what the server
  advertises once.
- `afterResponse` tests the call: `pm.response.result`, including `isError`.
- `afterDisconnect` is cleanup, after the session closes, so it can no longer
  call the server's tools. Unset the variables a run no longer needs, or remove
  data the run created with `pm.sendRequest`.

A collection or folder definition holds the same hooks as `mcp:<event>`, and
they run for every MCP request under it. That suits auth in
`mcp:beforeConnect`. A server check or cleanup placed there repeats on every
request, so give those their own request. A run that stops early, as with
`--bail`, skips a cleanup request; when leftover data matters, clean up from
the CI script after the run.

## Chain requests into workflows

A collection runs its requests in order, and scripts pass values between them,
so a collection can be a workflow rather than a list of separate checks: create
something, act on it by the id the first call returned, then check the result.
An `afterResponse` script stores a value with
`pm.collectionVariables.set("todoId", ...)`, and a later request uses it as
`{{todoId}}`. The values a run captures replace hard-coded fixtures. CI then
repeats the whole flow unattended, and nobody has to rebuild it in test code.

- A variable is substituted as a string, even inside the message JSON (CLI
  1.90.0). An
  unquoted `{{id}}` fails the JSON check, so a numeric argument cannot be
  chained yet.
- Each MCP request opens a new session, so the server has to keep the state the
  flow builds between sessions. A stdio request also starts a new server
  process, which loses anything held in memory. For such a server, run the
  flow against a long-running HTTP instance, or test it in the server's own
  tests.

## Credentials

`postman mcp login` opens a browser for the user and keeps the sign-in on this
machine. CI has neither, so CI for a server that needs auth takes a token from
the CI secret store, set as the request's auth through a variable
(see **variables**).

## Verification

Keep three results apart: the server answered, the tool succeeded (no
`isError`), and the assertions passed. `postman mcp` exits 1 for an `isError`
result, but `collection run` does not: a tool error there fails the run only
when a test checks `isError`, so every success check in a saved request
asserts it.
