---
name: api-simulation
description: The local development loop for a service that calls other APIs — find its dependencies with the Context Graph, give each one a mock (the owning team's, or one generated from its contract), serve them together from one `.sim.yaml` on one port, run the real service against it, test the change, and ship it with the simulation in the PR. Can also inject latency, error, rate-limit or chaos per dependency. Use when the user is building or changing an endpoint that calls other services, or asks to "simulate my dependencies," "mock everything this service calls," or "run this end to end locally." Covers `postman simulation`. Builds on api-discovery for finding dependencies and their owners' mocks, and on api-mocking for the rest.
---

# API Simulation

## Overview

A simulation serves several mocks on one local port. Each member has a
**routeKey**, its address: with `routing: path` (the default) a dependency
lives at `http://localhost:<port>/<routeKey>`, and the routeKey is stripped
before the mock sees the request. The service under test runs for real and is
never a member.

```yaml
# postman/simulations/feeds-dev.sim.yaml
simulation: feeds-dev
routing: path
mocks:
  - routeKey: acs
    path: ../mocks/acs/config.yaml
  - routeKey: workspaces
    path: ../.dependencies/mocks/workspace-service/config.yaml
```

Running a simulation is local and works signed out. The Context Graph,
`search`, `dependency` and anything in a workspace need `postman login`.
`postman simulation` needs CLI `1.69.0-beta-261006-114452` or a later release;
stable 1.69.0 has only the older `postman simulate run`.

## Commands

Every `postman simulation` command takes a `.sim.yaml` path, a simulation id
from a workspace, or both:

| Command | With a `.sim.yaml` path | With a simulation id |
| --- | --- | --- |
| `create -n <name> --mock <ref>=<routeKey>` | Writes `postman/simulations/<name>.sim.yaml` from mock paths | Creates one in the workspace from mock ids (`-w`). Don't mix the two |
| `list` | Lists `postman/simulations/` | `-w <workspaceId>` lists the workspace's |
| `get <pathOrId>` | Reads the file | Fetches it |
| `run <pathOrId>` | Serves the members on one port | Fetches the members, then serves them locally |
| `push <path>` | Uploads each member mock, then the simulation, to the linked workspace. A member pulled with `dependency add` goes up as a copy | — |
| `deploy <id>` | — | Serves it at a URL, **public by default**. `--private` requires an API key |
| `delete <pathOrId>` | Deletes the file, not its mocks | Deletes it and takes its URL down |

## Process

1. **Find what the change calls.**
   `postman context-graph ask "What services and APIs does <repo-name> call?" --wait`
   lists each upstream, the endpoints called and the call sites. Use the
   repository's name: a wrong name answers "no dependencies", not an error.
   The graph can miss a call, so check its list against the path you're
   changing and add any call the change introduces. Only HTTP dependencies
   become members; queues, databases and caches run as real local instances.
   If a `.sim.yaml` already covers the list, use it. Otherwise add what's
   missing.

2. **Give each dependency a mock.** Prefer the owner's. Ask the graph "Which
   Postman workspace holds the API for <service>?", list that workspace's
   mocks with `postman search mocks --filter "workspaceId=<id>"`, and pull one
   with `postman dependency add mock <mockId>` (see `api-discovery`). A name
   match in another workspace is not ownership. If the owner has none,
   generate one from their spec or collection (see `api-mocking`), and make it
   stateful when the change writes something and reads it back. Keep the
   endpoints this path calls and answer `501` for the rest, so a missed call
   fails loudly.

3. **Compose the simulation.**

   ```bash
   postman simulation create -n feeds-dev \
     --mock ./postman/mocks/acs=acs \
     --mock ./postman/.dependencies/mocks/workspace-service=workspaces
   ```

   Each `=<routeKey>` names a member: lowercase letters, digits, `-` and `_`.
   Schema: [reference/sim_yaml_schema.md](reference/sim_yaml_schema.md).

4. **Run it and point the service at it.**

   ```bash
   postman simulation run postman/simulations/feeds-dev.sim.yaml --port 4900 --output ndjson > sim.ndjson 2>&1 &
   ```

   It's up when the `listening` event lists each member's address. Set each
   upstream base URL to `http://localhost:4900/<routeKey>`. Stop it with
   Ctrl+C.

5. **Develop and test.** Call the changed route on the real service with
   `postman request` or its collection (see `api-testing`). Restart the
   service after a code change, and the simulation after a mock edit. A
   response from the simulation itself means wiring, not code:
   - `404 Unknown simulation member`: the path has no valid routeKey. The body
     lists the valid ones.
   - `501`: an upstream call you haven't modelled yet.
   - `502 Proxy error`: the member's handler crashed. See `sim.ndjson`.

6. **Ship.** Commit the mocks, the `.sim.yaml` and `.postman/resources.yaml`.
   CI runs `postman dependency install`, starts the simulation with
   `--no-history`, starts the service and runs the collection (see
   `ci-integration`).

**Failure paths.** Copy the baseline `.sim.yaml` and give one member
conditions: `latency.delay_ms`, `error.status_code` (400–599),
`rate_limit.requests_per_minute` or `chaos.failure_rate` (0–100). They apply
to every route on that member.

```yaml
  - routeKey: workspaces
    path: ../.dependencies/mocks/workspace-service/config.yaml
    scenarios:
      - overrides:
          conditions:
            error: { status_code: 503 }
```

## Critical Rules

1. **The service under test is never a member.** If nothing real runs, use
   `api-mocking`.
2. **Unique routeKeys and an explicit `--port`.** A member's own `port:` is
   ignored. Without `--port`, a busy 3000 silently moves to a random port.
3. **Members share one `pm.state` store.** Two stateful mocks that use the
   same key read and overwrite each other's records, so give each its own keys.
4. **Only `overrides.conditions` inject faults.** A bare
   `scenarios: - path: …/default.js` entry, as the Postman app writes, adds
   none. `overrides.bypass` is ignored.
5. **Pull an owner's mock even when it's deployed.** Only members take faults
   and log requests, and a private mock server needs an `x-api-key` your
   service won't send. Don't edit the pulled copy, because
   `dependency update` overwrites it. If it lacks an endpoint, copy it into
   `postman/mocks/` and call it a fork.
6. **Say where each mock came from:** the owner's (name the workspace),
   forked, or generated here.

## Verification

Starting is not the same as being used. Each request a member serves is a
`request` event in `sim.ndjson` with its `routeKey`; a member with none isn't
wired or isn't on this path. Injected `error`, `rate_limit` and `chaos`
responses never reach the mock, so confirm a fault from what the service got
back: `"scenario":"error"`, `429`s, or the added latency. Report each
dependency, where its mock came from, and what ran for real.
