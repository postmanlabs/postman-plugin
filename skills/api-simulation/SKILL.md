---
name: api-simulation
description: Runs the service you're building for real against stand-ins for the HTTP services it calls — each owning team's published mock where one exists, one built from the contract where not — served on one local port from a `.sim.yaml`. Use when you add or change code that calls other services and need to run it, test it, prove a fix or reproduce an upstream failure (timeouts, 5xx, 409, 429) end to end, locally or in CI, without the real services, because they're unreachable, need credentials, cost money, have side effects or don't exist yet. Applies even when nobody says mock or simulation. Not for a stand-in backend with no service of your own running (use api-mocking). Covers `postman simulation`.
---

# API Simulation

## Overview

A simulation is a service's development environment: each HTTP dependency it
calls is a mock, and all of them answer on one local port. The service you're
changing runs for real. Each mock is a member with a **routeKey**, its
address: `http://127.0.0.1:<port>/<routeKey>/...`, with the routeKey stripped
before the mock sees the request.

Prefer it to stubbing the HTTP client inside tests, or to calling the real
services. Your real client, config, timeouts and error handling run over real
HTTP, as they will in CI; the `.sim.yaml` is one command for teammates and CI
to rerun; the log shows what each dependency was asked and answered; and a
failure is a line of config, not new test code. No credentials, no side
effects in shared data, no waiting on a service that isn't built.

```yaml
# postman/simulations/checkout-dev.sim.yaml
simulation: checkout-dev
routing: path
mocks:
  - routeKey: catalog
    path: ../.dependencies/mocks/catalog-service/config.yaml # the owner's, pulled
  - routeKey: shipping
    path: ../mocks/shipping/config.yaml                      # built here
```

`postman simulation` needs Postman CLI 1.70.0 or later; if
`postman simulation -h` fails, run `postman update`. Check a command's `-h`
before using its flags. A local `.sim.yaml` runs signed out; the Context
Graph, `search`, `dependency` and workspaces need `postman login`.

## Process

1. **List what the change calls.** If a `.sim.yaml` in `postman/simulations/`
   already covers it, go to step 4. Otherwise read the HTTP dependencies off
   the code: its clients, their base-URL settings, and calls you're adding.
   Databases, queues and caches aren't members; run them locally. The code is
   the source of truth. If your team has the Context Graph, it can add calls
   made through shared code and other repos:
   `postman context-graph ask "What services and APIs does <repo> call?" --wait`,
   with the repo name from `git remote get-url origin` (a wrong name gets a
   confident "no dependencies"). It's often not set up; an access error or an
   empty answer means go on with the code's list.

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

4. **Run it and point the service at it.**

   ```bash
   postman simulation run postman/simulations/checkout-dev.sim.yaml --port 4900 --output ndjson > sim.ndjson 2> sim.err &
   ```

   It's up when `sim.ndjson` has a `listening` event; start-up errors are in
   `sim.err`. Swap each base URL's host for its member and keep its path:
   `https://catalog.internal.example.com/v2` becomes
   `http://127.0.0.1:4900/catalog/v2`. It listens on 127.0.0.1 only. Stop it
   with `pkill -INT -f "simulation run postman/simulations/checkout-dev.sim.yaml"`
   (`kill $!` stops only the launcher), or Ctrl+C in its own terminal.

5. **Call the real service, then read the log.** Exercise the changed route
   with `postman request` or its collection (see `api-testing`); requests
   saved in the collection become a test that reruns against this simulation
   in CI. Each request
   a member served is a `request` event in `sim.ndjson` (`routeKey`,
   `method`, `path`, `statusCode`, `duration`, bodies). Check every call you
   expect is there, on the right member, with the right status. Nothing
   reloads: restart the service after code changes, the simulation after mock
   edits. Answers that mean wiring, not code:
   - `404 Unknown simulation member` (lists valid ones): a base URL lost its
     routeKey.
   - `501`, or a generated mock's `404 Endpoint not defined`: a call the mock
     doesn't model yet.
   - `502 Proxy error`: that member's handler threw, and it's down until you
     restart. Nothing is logged; run the mock alone with `postman mock run`
     and resend to see why. `interceptRequests: true` in its `config.yaml`
     turns a throw into a `500`; pulled copies lose that setting (CLI 1.70.0),
     so fork one that needs it.

6. **Optionally, fail a dependency** when the change must survive a slow or
   failing upstream. Copy the `.sim.yaml` and give that member a condition:

   ```yaml
     - routeKey: shipping
       path: ../mocks/shipping/config.yaml
       scenarios:
         - overrides:
             conditions:
               error: { status_code: 503 }
   ```

   One failure at a time (`error`, `rate_limit`, `chaos`), optionally with
   `latency`; fields are in [reference/sim_yaml_schema.md](reference/sim_yaml_schema.md).
   It covers every route on that member. Injected failures never reach the
   mock and aren't logged, so judge them by your service's response. They
   test your resilience, not how the provider fails.

7. **Ship it.** Commit your own mocks, the `.sim.yaml` and
   `.postman/resources.yaml`. Don't commit `postman/.dependencies/`: a copy
   goes stale when the owner updates theirs, and `postman dependency install`
   restores it from `resources.yaml` after a clone. Don't commit `sim.ndjson`
   either; it holds headers and bodies. CI is optional: run
   `postman dependency install` (it needs a Postman API key), start the
   simulation before the tests, stop it after.
   `postman simulation push` fails on a pulled member, which keeps its
   owner's id; fork it first.

## Critical Rules

1. **The service you're changing is never a member.** It must run for real,
   or the test only proves the mock. Nothing of yours running? Use
   `api-mocking`.
2. **Always pass `--port`.** Without it, a busy 3000 silently becomes a random
   port and your base URLs point at nothing.
3. **`pm.state` belongs to each mock, not to the simulation.** Don't use it
   to pass data between members. In a local run, CLI 1.70.0 still lets
   members see each other's keys, so give each mock its own key names; a reset
   that calls `pm.state.clear()` empties every member.
4. **Only `overrides.conditions` change a member.** Members serve their
   default handler. A `scenarios` entry with only a `path`, as the Postman app
   writes, does nothing; `overrides.bypass` is ignored.
5. **Pull the owner's mock even if it's deployed.** Only members take
   conditions and appear in the log, and a private mock server wants an
   `x-api-key` your service won't send.
6. **`simulation deploy` is public by default,** unlike `mock deploy`. Ask
   before deploying without `--private`; a local run needs no deploy.

## Verification

Read the whole log first: a member with no `request` events isn't wired or
isn't on this path. Report:

- **What ran for real**, and what a pass proves: your service against these
  stand-ins, not the real dependencies.
- **Each member:** requests served, statuses, and anything odd (`501`, `502`,
  never called).
- **Each dependency's mock:** pulled from the owner's workspace (name it),
  built from a contract (name it), or written from your client code, and
  what you assumed. Signed out, say the owner search was skipped.
