---
name: api-mocking
description: Finds, builds, runs and publishes a stand-in for one API — the owning team's published mock when there is one, otherwise one built from its spec or collection that behaves like the real API, stateful when callers write then read. Use when something needs an API that isn't built or reachable yet (a frontend, client, demo or one dependency), when other teams should build against your API before it ships, or when asked to mock an API or fake a backend. For running your own service against everything it calls, use api-simulation. Covers `postman mock` and `postman dependency add mock`.
---

# API Mocking

## Overview

A mock is a small program that answers like an API: a folder with
`config.yaml` (name, port, scenarios) and `default.js`, a Node HTTP server
that calls `listen(process.env.PORT)`. The runner provides `pm.state` and the
other `pm.*` APIs, and loads the handler as CommonJS even in an ESM project,
so use `require`, not `import`. The same folder lives in three places:

- **Your repo**, as `postman/mocks/<name>/`, served by `postman mock run`. It
  needs no sign-in, and it's a complete answer when only you and your tests
  call it.
- **A Postman workspace**, after `postman mock push`. Other teams pull it into
  their own simulations with `postman dependency add mock`, so push it to the
  workspace that owns the service: that's where they look.
- **A mock server**, after `postman mock deploy`: a URL for callers that can't
  run it themselves, such as a deployed frontend, a webhook sender or CI
  elsewhere.

Run `-h` on a `postman mock` command before you use one of its flags, and
believe it over this file.

Running your own service against everything it calls? Use `api-simulation`,
which gets each dependency's mock here.

## Use the owner's mock first

When the API belongs to another team, look for their published mock before
writing one: theirs encodes their contract and their service's state, and
yours would encode a guess. This needs `postman login`; signed out, build one
(below) and say the owner search was skipped.

1. Find the owner's workspace with
   `postman search workspaces "<service>" -o json`. Name the service plainly,
   as your code does ("the workspace service"), not by what it returns: a
   description matches lookalike services. Prefer a Git-connected workspace
   (`isGitConnected`) named for that service; its team publishes there. If
   your team has the Context Graph,
   `postman context-graph ask "Which Postman workspace holds the collections and mocks for <service>?" --wait`
   can confirm or break a tie. It's often not set up, so go on without it.
2. `postman mock list -w <workspaceId> --json` lists its mocks (`search`
   misses some). A same-named mock elsewhere isn't the owner's. Of several,
   prefer one the owner has deployed, updated recently, whose endpoints
   (`postman mock get <mockId>`) cover your calls.
3. `postman dependency add mock <mockId>` copies it into
   `postman/.dependencies/mocks/`. Use it as it is. Never edit that folder:
   `dependency update` overwrites it, so to change a pulled mock, copy it to
   `postman/mocks/` as a fork. A mock is code that runs as you, so pull only
   from workspaces you trust.

## Or build one that behaves like the real API

Callers shouldn't be able to tell the difference on the paths they use. A
mock that returns invented JSON passes your tests and fails against the real
service.

1. **Start from the contract.** `postman mock generate <openapi.yaml or collection> -n <name>`
   writes `postman/mocks/<name>/` with each documented response. It serves
   the spec's base path too (a server URL ending `/v2` gives `/v2/...`
   routes), and an `x-mock-response-code: 404` header returns the documented
   404. It's a replay: a `POST` and a later `GET` share nothing. A large
   contract gives a very large handler, so keep the routes callers use.
   `--update <path>` regenerates `default.js` from the source and overwrites
   hand edits. With no contract, `postman mock generate -n <name>` gives a
   small stateful sample to adapt.
2. **Cover what callers handle**, not just the 200: the 404 for an unknown
   id, the 409 on a conflict, the 400 on bad input, in the contract's error
   shape. Where the contract is silent, say what you assumed.
3. **Set `interceptRequests: true` in `config.yaml`.** It parses `req.body`
   and `req.query`, makes `x-mock-session` work locally, and turns a handler
   that throws into a `500` instead of a server that stops answering.
4. **Make it stateful when callers write then read.** Keep records in
   `pm.state`, the mock's async key-value store (`get`, `set`, `delete`,
   `has`, `keys`, `clear`, `size`, `toObject`, `increment`, `push`,
   `addToSet`). Seed starting records on first use, add a reset route so a
   test can start clean, and answer an unknown id with the real 404. Each
   `mock run` starts empty; a deployed mock server keeps its state across
   pushes and redeploys.
5. **Know who shares state.** Locally, every caller shares one state unless
   it sends `x-mock-session: <id>`. A mock server deployed from the CLI is the
   other way round: each caller is isolated, and a caller that doesn't send
   the same `x-mock-session` on every request starts from the seed each time,
   so its `POST` and later `GET` never meet. Tell consumers to send one per
   test run or CI job.
6. **Add scenarios for other behaviour.** A scenario is a named handler in
   `config.yaml`, with optional conditions. A caller picks one per request
   with `x-mock-scenario: <name>`. An unknown name falls back to the default
   locally, and is a `404` on a mock server. A simulation always serves the
   default.

   ```yaml
   scenarios:
     - name: default
       path: ./default.js
       default: true
     - name: out-of-stock            # x-mock-scenario: out-of-stock
       path: ./out-of-stock.js
     - name: slow
       path: ./default.js
       conditions:
         latency: { delay_ms: 3000 }  # also error, rate_limit, chaos
   ```

## Run and check it

`postman mock run postman/mocks/<name>` prints the URL it bound. If the
configured port is busy it picks another one, unless you passed `--port`, so
take the URL from that line. Nothing reloads: restart it after an edit. A
handler that throws answers `500 Handler error` with the message.
`--output ndjson` prints one event per request.

Check it against the contract, not against the handler you just wrote: a mock
checked against itself proves nothing. Send real requests with
`postman request`, or run the API's collection against it:
`postman collection run <collection> --use-mock "{{baseUrl}} mock:postman/mocks/<name>"`
sends that variable's requests to the mock (`--mock` alone only starts it).

## Publish it for other teams

1. **Push it to the service's workspace**, the one in `.postman/resources.yaml`
   or the one the user names. Never choose a workspace by name match.
   `postman mock push postman/mocks/<name>` creates the mock the first time,
   updates it after, and records the mapping in `.postman/resources.yaml`;
   commit that. Signed out, push fails with `Authentication required`; the
   local mock still works, so tell the user to run `postman login` and push.
2. **Keep it honest.** Change the mock in the same PR as the API, and run the
   API's collection against it, so consumers never build against a stale
   contract.
3. **Deploy it only when a caller needs a URL.**
   `postman mock deploy <mockId> -s <slug> -y` serves it at
   `https://<slug>.mock.<team-domain>.postman.dev`. Pass `-s`: the slug must
   be 3–32 lowercase letters, digits and hyphens, and the generated default
   can be longer. It's private by default: callers send a Postman API key as
   `x-api-key`. Your CLI login isn't an API key, so you can't call a private
   server yourself without one; `postman mock list -w <workspaceId> --json`
   shows its URL and whether it's private, and `postman mock log` shows its
   traffic. The first deploy fixes the slug and visibility; a scripted
   redeploy can turn `--public` on but never off. Deploying needs a paid
   Postman plan, a new server can take a minute or two to answer, and each
   later `push` updates what it serves.
4. **Write it for where it will run.** A mock server runs only the one handler
   file, with Node's built-in modules. It has no local `require`s, no
   `pm.mock` example lookups, no `-e` environment and no console output, and
   it never sees caller headers such as `authorization`, `cookie` or
   `x-api-key`. A mock that relies on any of these works locally and breaks
   once deployed.

## History and logs

- **Start history.** Each run of a mock that's in a workspace is recorded as
  a start ("Previous starts" in Postman): a run by mock id records
  automatically, a run by path only with `-w <workspaceId>`. `--no-history`
  opts out.
- **Mock server traffic.** `postman mock log <mockServerId>` lists what a
  deployed server received and returned; filter with `--status 5xx`,
  `--path` or `--since`. Its `mockServerId` comes from
  `postman mock get <mockId>`, and is not the mock's id.

## Critical Rules

1. **Ask before `--public`.** It serves the mock, and any data in it, to
   anyone with the URL, and a scripted redeploy can't take that back.
2. **`generate -w` writes nothing to the repo.** It creates the mock only in
   the workspace, so there's no folder to `run`. Generate locally and push.
3. **`mock delete` refuses a mock that's running or deployed.** Deleting the
   workspace copy leaves its line in `.postman/resources.yaml`; remove it.

## Verification

A mock isn't done because `run` exited 0. Call it: a documented error status
comes back, a valid scenario changes the response, and a `POST` then `GET`
shows state if it's meant to be stateful. Then report:

- **Where it runs:** the local URL or the mock server URL, and whether it's
  private (needs `x-api-key`) or public.
- **Where it lives:** the repo only, or which workspace, and why that one.
- **What it covers:** routes, error statuses, state, sessions, scenarios, and
  what you assumed.
- **Anything that failed**, such as sign-in, the plan or a permission error,
  stated plainly.
