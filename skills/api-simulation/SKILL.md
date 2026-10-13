---
name: api-simulation
description: Runs your code for real against stand-ins for the HTTP services it calls, served together as one environment on one local port or one deployed URL, whether that code is a service you're changing, a frontend, a test suite or a demo. Use when you add or change code that calls other services and need to run it, test it, prove a fix or reproduce an upstream failure (timeouts, 5xx, 409, 429) end to end, locally or in CI, without the real services because they're unreachable, need credentials, cost money, have side effects or don't exist yet. Also answers what happens when a service it calls goes down, is slow or returns errors, by running each failure instead of reading the code. Applies even when nobody says mock or simulation. For one API alone, use api-mocking. Covers `postman simulation`.
---

# API Simulation

A simulation serves several mocks as one environment: one local port, or one
URL once deployed. Each mock is a member with a routeKey. Under `path`
routing (the default) a caller reaches it at `/<routeKey>/...`, prefix
stripped; under `header` routing paths stay as they are and the caller sends
`x-mock-slug: <routeKey>`.

Run your code against it rather than stubbing its HTTP client in tests or
calling the real services. A stub skips the client, config, timeouts and
error handling that will run in production; the real services need
credentials and leave side effects. A simulation runs that code over real
HTTP, the same way in CI, and its log shows what each dependency was asked.

Do only what the task needs. If a `.sim.yaml` in `postman/simulations/`
already covers it, run that one. One request through the changed path proves
a change; build failure variants only when asked how the code fails or when
it must survive a failure.

`postman simulation` needs CLI 1.70.0 or later (`postman --version`; an older
CLI answers `postman simulation -h` with its general help).

## Building it

- **Members are the code's HTTP dependencies,** read from its clients and
  base-URL settings. Databases, queues and caches aren't; run them locally.
  If your team has the Context Graph,
  `postman context-graph ask "What services and APIs does <repo> call?" --wait`
  can add calls made through shared code. Take `<repo>` from
  `git remote get-url origin`: a close name can match another repo, and "no
  service named …" means it isn't in the graph, not that it calls nothing.
- **Each member needs a mock: see `api-mocking`,** which looks for the owning
  team's published mock before building one. For a question, any mock that
  answers will do. Have it answer `501` for calls this path doesn't make, so
  a call you missed fails loudly instead of returning plausible data.
- `postman simulation create` writes the `.sim.yaml` from mock paths.

## Running it

The run is a server that never exits, so a foreground command never returns.
Start it in the background with an explicit port, its log in a file:

```bash
postman simulation run postman/simulations/checkout-dev.sim.yaml --port 4900 --output ndjson > sim.ndjson 2> sim.err &
```

Without `--port`, a busy 3000 silently becomes a random port and every base
URL points at nothing. It's up when `sim.ndjson` has a `listening` event; a
start-up error is in `sim.err`. It listens on 127.0.0.1 only. Stop it with
`pkill -INT -f "simulation run <file>"`; `kill $!` leaves it running,
because the `postman` launcher ignores the signal. Nothing reloads: restart
the caller after a code change and the simulation after a mock edit.

Point the caller at it without changing what the code does once deployed.
Under path routing, swap only the host and keep the path:
`https://catalog.internal.example.com/v2` becomes
`http://127.0.0.1:4900/catalog/v2`; a dropped `/v2` is the usual cause of a
`404`. A hard-coded base URL should read an environment variable with
today's value as the default. If the code mustn't change at all,
`simulation run --proxy` reaches the members through `HTTPS_PROXY` instead;
it needs a `simulation.yaml` naming each member's real host, applies no
conditions, and passes any other host through to the real service.

## Reading the log

Exit codes prove nothing here: read `sim.ndjson`. Each request a member
served is a `request` event with its routeKey, status and bodies. A member
with no events isn't wired or isn't on this path. Some answers come from the
simulation itself and mean wiring, not code:

- `404 Unknown simulation member`: a base URL lost its routeKey, or a client
  sent the wrong `x-mock-slug`.
- `501`, or a generated mock's `404 Endpoint not defined`: a call the mock
  doesn't model yet.
- `502 Proxy error`: the member's async code threw and its process exited;
  it stays down until you restart. Run that mock alone with
  `postman mock run` to see why.

## When a dependency goes down

Run it rather than reason from the code: each way of going down takes a
different path through the caller, and a stub skips the client code that
picks the path. Fail the one dependency in each shape that matters, a run
each, with the others answering normally:

- **Unreachable:** point its base URL at a port nothing listens on.
- **Hanging:** give its member a `latency` condition longer than the
  client's timeout. If the client sets none, that is the finding: Node's
  `fetch` waits about five minutes, so say so rather than wait it out.
- **An error with a JSON body:** the `error` condition.
- **An error with an HTML body,** as proxies send: a copy of its mock whose
  default handler answers `500` with HTML. No condition can do this.

Only `overrides.conditions` on a member change it; members always serve
their default handler, and a `scenarios` entry with just a `path`, as the
Postman app writes, does nothing. Fields and the other conditions are in
[reference/sim_yaml_schema.md](reference/sim_yaml_schema.md). An injected
failure never reaches the mock and isn't logged, so judge it by what the
caller did, and check the other members' logs for side effects, such as
stock reserved and never released.

## Keeping it

Commit your own mocks, the `.sim.yaml` and what `postman dependency add`
changed, so the next session or CI reruns it in one command. Don't commit
`postman/.dependencies/`: a copy goes stale when its owner updates theirs,
and `postman dependency install` restores it. Don't commit `sim.ndjson`; it
holds headers and bodies, tokens included. In CI,
`postman dependency install` needs `POSTMAN_API_KEY`, and
`postman collection run <collection> --simulation <file>` starts and stops
the simulation around a collection run. `postman simulation push` fails
with `403` on a pulled member, which keeps its owner's `id:`; fork it first.

## Rules

1. **What you're testing is never a member.** It must run for real, or the
   test only proves the mock.
2. **Pull the owner's mock even if it's deployed.** Only members take
   conditions and appear in the log, and a private mock server wants a key
   your code won't send.
3. **`simulation deploy` is public by default,** unlike `mock deploy`. Ask
   before deploying without `--private`; a local run needs no deploy.

## Before you say it works

Claim nothing until what you're testing actually ran: a service printed
that it's listening and answered your request, or the frontend or test
suite finished, and its calls are in the log. If its start command exited
or hung, the run proved nothing; say so and why. Say what a pass proves,
your code against these stand-ins rather than the real services, and where
each mock came from, including when you skipped the owner's.
