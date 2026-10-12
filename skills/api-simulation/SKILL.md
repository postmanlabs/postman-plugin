---
name: api-simulation
description: Runs the service you're building for real against stand-ins for the HTTP services it calls, on one local port. Use when you add or change code that calls other services and need to run it, test it, prove a fix or reproduce an upstream failure (timeouts, 5xx, 409, 429) end to end, locally or in CI, without the real services, because they're unreachable, need credentials, cost money, have side effects or don't exist yet. Also answers what happens when a service it calls goes down, is slow or returns errors, by running each failure instead of reading the code. Applies even when nobody says mock or simulation. Not for a stand-in backend with no service of your own running (use api-mocking). Covers `postman simulation`.
---

# API Simulation

## Overview

A simulation is a service's development environment: each HTTP dependency it
calls is a mock, and all of them answer on one local port. The service you're
changing runs for real. Each mock is a member with a **routeKey**, its
address: `http://127.0.0.1:<port>/<routeKey>/...`, with the routeKey stripped
before the mock sees the request.

Prefer it to stubs inside tests or to the real services: your real client,
config, timeouts and error handling run over real HTTP, as in CI; the log
shows what each dependency was asked and answered; a failure is a line of
config, not test code; and nothing needs credentials or touches shared data.

`postman simulation` needs Postman CLI 1.70.0 or later; if
`postman simulation -h` fails, run `postman update`. Check a command's `-h`
before using its flags. A local `.sim.yaml` runs signed out; the Context
Graph, `search`, `dependency` and workspaces need `postman login`.

## Process

1. **List what the change calls.** If a `.sim.yaml` in `postman/simulations/`
   already covers it, go to step 4. Otherwise read the HTTP dependencies off
   the code: its clients, their base-URL settings, and calls you're adding.
   Databases, queues and caches aren't members; run them locally. If your
   team has the Context Graph,
   `postman context-graph ask "What services and APIs does <repo> call?" --wait`
   can add calls made through shared code and other repos. Take `<repo>` from
   `git remote get-url origin`: a wrong name gets a confident "no
   dependencies". It's often not set up; on an access error or an empty
   answer, go on with the code's list.

2. **Give each dependency a mock with `api-mocking`**: the owning team's
   published one first (its "Use the owner's mock first"), else one built
   from their contract (`postman dependency add collection <id>`, a spec in
   the repo, a vendor's published API) or from how your code calls it. In a
   simulation, answer `501` for calls this path doesn't make, so a missed
   call fails loudly, and make it stateful if the flow writes then reads.
   Note where each mock came from and what you assumed.

3. **Create it.**
   `postman simulation create -n checkout-dev --mock ./postman/.dependencies/mocks/catalog-service=catalog --mock ./postman/mocks/shipping=shipping`.
   RouteKeys: lowercase letters, digits, `-` and `_`, unique.

4. **Start it in the background and point the service at it.**

   ```bash
   postman simulation run postman/simulations/checkout-dev.sim.yaml --port 4900 --output ndjson > sim.ndjson 2> sim.err &
   ```

   It's up when `sim.ndjson` has a `listening` event; start-up errors are in
   `sim.err`. Swap each base URL's host for its member and keep its path:
   `https://catalog.internal.example.com/v2` becomes
   `http://127.0.0.1:4900/catalog/v2`, and the member sees `/v2/...`. If a
   base URL is hard-coded, make it read an environment variable with today's
   value as the default
   (`process.env.CATALOG_URL ?? 'https://catalog.internal.example.com/v2'`),
   so the deployed service is unchanged and the simulation is one variable
   away. Start the service in the background too, its output in a file. The
   simulation listens on 127.0.0.1 only. Stop it with
   `pkill -INT -f "simulation run postman/simulations/checkout-dev.sim.yaml"`
   (`kill $!` stops only the launcher).

5. **Call the real service, then read the log.** Exercise the changed route
   with `postman request` or its collection (see `api-testing`); requests
   saved in the collection become a test that reruns against this simulation
   in CI. Each request a member served is a `request` event in `sim.ndjson`
   (`routeKey`, `method`, `path`, `statusCode`, `duration`, request and
   response bodies). Check every call you expect is there, on the right
   member, with the right status. Nothing reloads: restart the service after
   code changes, the simulation after mock edits. Answers that mean wiring,
   not code:
   - `404 Unknown simulation member` (lists valid ones): a base URL lost its
     routeKey.
   - `501`, or a generated mock's `404 Endpoint not defined`: a call the mock
     doesn't model yet.
   - `502 Proxy error`: that member's handler threw, and it's down until you
     restart; see the [reference](reference/sim_yaml_schema.md).

6. **Ship it.** Commit your own mocks, the `.sim.yaml` and
   `.postman/resources.yaml`. Don't commit `postman/.dependencies/`: a copy
   goes stale when the owner updates theirs, and `postman dependency install`
   restores it from `resources.yaml` after a clone. Don't commit `sim.ndjson`
   either; it holds headers and bodies. CI is optional: run
   `postman dependency install` (it needs a Postman API key), start the
   simulation before the tests, stop it after.
   `postman simulation push` fails on a pulled member, which keeps its
   owner's id; fork it first.

## What happens if a dependency goes down

Whether you're asked what happens when a dependency goes down or making your
service survive it, run the service rather than read the code or stub its
HTTP client: each way of going down takes a different path through it, and a
stub skips the client code that picks the path. Build the simulation with
steps 1–4, but for a question any mock that answers will do, so skip the
owner search; the others only need to let the flow reach the one that fails.
Then fail that one in each shape, a run each:

- **Unreachable:** point its base URL at a port nothing listens on, such as
  `http://127.0.0.1:4999`.
- **Hanging:** give its member `latency` longer than your client's timeout.
- **An error with a JSON body:** give it the `error` condition, which answers
  `{"error":{"message":"Service Unavailable","statusCode":503},"scenario":"error"}`.
- **An error without one:** copy its mock to `postman/mocks/<name>-html500/`,
  make the default handler answer `500` with an HTML page, and use the copy
  as the member in a copy of the `.sim.yaml`. A scenario can't do this
  (rule 5).

Conditions go on the member, in a copy of the `.sim.yaml`. Each covers every
route on its member, never reaches the mock and isn't logged; `rate_limit`
and `chaos` exist too ([reference](reference/sim_yaml_schema.md)).

```yaml
  - routeKey: shipping
    path: ../mocks/shipping/config.yaml
    scenarios:
      - overrides:
          conditions:
            error: { status_code: 503 }    # or latency: { delay_ms: 5000 }
```

## Critical Rules

1. **The service you're changing is never a member.** It must run for real,
   or the test only proves the mock. Nothing of yours running? Use
   `api-mocking`.
2. **Run the simulation and your service in the background.** Both serve
   until stopped, so a foreground command never returns.
3. **Always pass `--port`.** Without it, a busy 3000 silently becomes a random
   port and your base URLs point at nothing.
4. **`pm.state` belongs to each mock, not to the simulation.** Don't pass
   data between members through it. CLI 1.70.0 still lets local members see
   each other's keys, so give each mock its own key names;
   `pm.state.clear()` empties every member.
5. **Only `overrides.conditions` change a member.** Members serve their
   default handler. A `scenarios` entry with only a `path`, as the Postman app
   writes, does nothing; `overrides.bypass` is ignored.
6. **Pull the owner's mock even if it's deployed.** Only members take
   conditions and appear in the log, and a private mock server wants an
   `x-api-key` your service won't send.
7. **`simulation deploy` is public by default,** unlike `mock deploy`. Ask
   before deploying without `--private`; a local run needs no deploy.

## Verification

Claim nothing until your service started and answered: its own output says
it's listening, it responded to your request, and its calls are in the log.
If its start command exited or hung (a missing build, an old Node), the run
proved nothing; report "not verified" and why. Then read the whole log: a
member with no `request` events isn't wired or isn't on this path. Report:

- **What ran for real**, and what a pass proves: your service against these
  stand-ins, not the real dependencies.
- **Each member:** requests served, statuses, and anything odd (`501`, `502`,
  never called).
- **Each failure shape you ran:** what your service returned, whether it
  crashed, and side effects in the other members' logs, such as stock
  reserved and never released.
- **Each dependency's mock:** pulled from the owner's workspace (name it),
  built from a contract (name it), or written from your client code, and
  what you assumed. If you skipped the owner search, say so.
