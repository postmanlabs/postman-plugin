---
name: api-simulation
description: The local development loop for a service that calls other APIs — mock every upstream it depends on, start them together from one `.sim.yaml`, run the real service against them, test the change, and ship it with the simulation in the PR. Can also inject latency, error, rate-limit or chaos per dependency. Use when the user is building or changing an endpoint that calls other services, or asks to "simulate my dependencies," "mock everything this service calls," or "run this end to end locally." Covers `postman simulate run`. Builds on api-mocking for the member mocks; running locally needs nothing from bootstrap.
---

# API Simulation

## Overview

This is how a service change gets developed: mock every dependency the service
calls, start them together as one simulation, run the real service against it,
test, push. Dependencies are not expected to exist locally — the simulation is
how the service runs on a laptop and in CI.

- **Mock** — one fake upstream in `postman/mocks/NAME/` (see `api-mocking`).
- **Simulation** — every mock the service needs, listed in
  `postman/simulations/NAME.sim.yaml` and started by one `postman simulate run`.
- **Service under test** — runs for real. It is never a member.

Everything here is local and works signed out.

## Process

1. **List what the changed path calls.** Read the code: the clients the route
   uses and the upstream base URLs in config
   (`grep -rnoE '[A-Z_]*BASE_?URL|baseUrl' config/`). The code decides which
   endpoints to mock. Signed in, `postman context-graph ask "What APIs does
   <repo-name> call?" --wait` adds dependencies hidden behind shared libraries,
   and their owners. Ask with the repository's name: a wrong name answers "no
   dependencies", not an error. Its endpoint lists cover the whole repo, not
   your path.

   Only HTTP dependencies can be mocked. gRPC, queues, databases and caches run
   as real local instances; name them in the result.

   If a `.sim.yaml` already exists and covers this list, use it. If it doesn't,
   build what's missing from the list.

2. **Mock each dependency.** Reuse the owning team's mock if they published one:
   `postman search mocks "<dependency>" --ownership organization --filter
   "workspaceId=<owner-workspace-id> AND isGitConnected=true" -n 25`. A name
   match is not ownership, and `--filter` runs after `-n` caps the page, so a
   low limit can miss it. Otherwise generate one from the dependency's contract
   (`postman mock generate <spec-or-collection> -n <dep>-sim`), then shape the
   handler to:
   - **the client that reads it** — your code decides what's accepted (wrapper
     keys, the exact fields it checks), not the spec;
   - **only the endpoints this path calls** — return `501` for anything else,
     never a plausible `200`, so a call you missed fails right away.

   For a third-party API, generate from its published contract (see
   `api-discovery`), not from memory.

3. **Compose the `.sim.yaml`, one port per member.** Every generated mock
   declares port `4500`, and the run refuses duplicates. Set `port:` per entry:

   ```yaml
   simulation: orders-dev
   mocks:
     - path: ../mocks/payments-sim/config.yaml
       port: 4901
     - path: ../mocks/inventory-sim/config.yaml
       port: 4902
   ```

   Full schema: [reference/sim_yaml_schema.md](reference/sim_yaml_schema.md).

4. **Point the service at the mocks.** Set each upstream base URL to
   `http://127.0.0.1:<port>`: with env vars if the service reads them, otherwise
   with a dev config profile that replaces only the base URLs. Check the boot log
   for what each dependency resolved to. Auth middleware often has its own URL
   key, and some services never read `process.env`. Use a throwaway local
   database rather than a shared one.

5. **Start the simulation, then wait for every member.**

   ```bash
   postman simulate run postman/simulations/orders-dev.sim.yaml --no-history > sim.log 2>&1 &
   for port in 4901 4902; do
     until curl -sS -o /dev/null -m 2 "http://127.0.0.1:$port/"; do sleep 1; done
   done
   ```

   Members bind one at a time, so poll each one. Don't use `curl -f`: a member
   with an injected error never looks ready. Stop it with Ctrl+C.

6. **Develop and test.** Start the real service and hit the changed route with
   `postman request` or its collection (see `api-testing`). While iterating:
   - Restart only the service after a code change. The simulation keeps running.
   - Mocks don't hot-reload. After you edit a handler, restart the simulation.
   - A `502` reading `Proxy error: connect ECONNREFUSED 127.0.0.1:<ephemeral>`
     means that mock's handler crashed. The cause is in `sim.log`.
   - A `501` from a mock means an upstream call wasn't modelled yet. Add it,
     restart, continue.

7. **Push.** Commit the mocks and the `.sim.yaml` with the change. CI runs the
   same steps: start the simulation, start the service, run the collection with
   `--no-history` (see `ci-integration`).

**Failure paths, if the change handles them.** Copy the baseline to a second
`.sim.yaml` and add conditions to one member:

```yaml
  - path: ../mocks/payments-sim/config.yaml
    port: 4901
    scenarios:
      - path: ../mocks/payments-sim/default.js
        overrides:
          conditions:
            error:
              status_code: 503
```

The conditions are `latency.delay_ms`, `error.status_code` (400–599),
`rate_limit.requests_per_minute` and `chaos.failure_rate` (0–100). A condition
applies to every route on that member.

## Critical Rules

1. **The service under test is never a member.** If nothing real runs, use
   `api-mocking` instead.
2. **Distinct ports, or the run fails closed.**
3. **A scenario entry without `overrides.conditions` injects nothing.** For a
   healthy member, leave out `scenarios:` entirely.
4. **`id:`, `routing:` and `overrides.bypass` do nothing in the CLI.** There is
   no proxying through to a real dependency.
5. **Say where each mock came from:** the owner's or generated here.
6. **Recording history needs both `-w` and `--simulation`.** Otherwise pass
   `--no-history`.

## Verification

Starting is not the same as being used. Count the requests each member served:

```bash
grep -a 'request completed' sim.log \
  | sed -E 's|.*request completed +||; s|http://localhost:[0-9]+||; s|\?[^ ]*||' \
  | awk '{print $1, $2, $3, $4}' | sort | uniq -c | sort -rn
```

A member with zero requests either isn't wired (step 4) or isn't on this path.
Readiness probes are in the counts too, so subtract them. For a fault, confirm
the response changed: `"scenario":"error"` in the body, `429`s, or added latency.
Report each dependency, where its mock came from, and what ran for real.
