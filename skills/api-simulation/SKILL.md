---
name: api-simulation
description: Runs your code for real against stand-ins for the HTTP services it calls, served together as one environment on one local port or one deployed URL, whether that code is a service you're changing, a frontend, a test suite or a demo. Use when you add or change code that calls other services and need to run it, test it, prove a fix or reproduce an upstream failure (timeouts, 5xx, 409, 429) end to end, locally or in CI, without the real services because they're unreachable, need credentials, cost money, have side effects or don't exist yet. Also answers what happens to a request, or to the data it writes, when a service it calls goes down, is slow or returns errors ("what happens to a booking if the email service is down?"), by running each failure instead of reading the code. Applies even when nobody says mock or simulation, and a `postman/simulations/` directory in the repository is itself a reason to load this before changing code it covers. To give a frontend or another team a stand-in for an API, use api-mocking. Covers `postman simulation`.
---

# API Simulation

Building, fixing and testing an API goes faster here than against the real
services or against stubs. One command brings up every dependency the code
calls, so a change is exercised end to end in seconds — nothing to get
credentials for, no environment to book, no other team's service to wait on —
and that same command is what CI runs. A repository with `postman/simulations/`
has already paid that cost: the path you're changing may be covered already.

The `<name>.context.yaml` beside a simulation is where the last session's work
went: what the code takes for granted about each dependency it calls, and the
evidence each of those beliefs rests on. So the second change to a service costs
less than the first, and the tenth costs least.

A simulation serves several mocks as one environment: by default behind a
proxy that answers for the dependencies' own hostnames, so the code under test
keeps the base URLs it ships with, or on one local port where each member is
reached by its routeKey.

Run your code against it rather than stubbing its HTTP client in tests or
calling the real services. A stub skips the client, config, timeouts and
error handling that will run in production; the real services need
credentials and leave side effects. A simulation runs that code over real
HTTP, the same way in CI, and its log shows what each dependency was asked.

Do only what the task needs. Where a `.sim.yaml` in `postman/simulations/`
already covers it, that one runs as it stands, and its context document is
cheaper to read than the `.sim.yaml` and the handlers are to re-derive. What
that document can't settle is what a run proved, which is decided here. One
request through the changed path proves a change; failure variants are worth
building when asked how the code fails or when it must survive a failure.

`postman simulation` needs CLI 1.70.0 or later (`postman --version`; an older
CLI answers `postman simulation -h` with its general help).

## Building it

- **Members are the code's HTTP dependencies.** Databases, queues and caches
  aren't; run them locally. **api-discovery** can find calls made through
  shared code; ask about the repo by its `git remote` name, because a close
  name matches another repo.
- **Each member needs a mock: see `api-mocking`,** which looks for the owning
  team's published mock before building one. For a question, one built from
  the contract will do; one that invents responses can send the caller down a
  path the real service never would. In a mock you build, answer `501` for calls this path
  doesn't make: a `404` reads to the caller like a real "not found".
- **Bring in each mock you don't own as a dependency first, then build the
  simulation over them.** `postman dependency add mock <name-or-id>` declares
  it in `.postman/resources.yaml` and materialises it under
  `postman/.dependencies/`, and the member's `path:` points there; `-w
  <workspace>` resolves a name from the workspace that owns it.
- **Prefix each mock's `pm.state` keys with its name.** As of CLI 1.73.0,
  members of a local run read each other's keys, so two mocks storing
  `orders` overwrite each other.

## Running it

The run is a server that never exits, so a foreground command never returns.
Start it in the background, its log in a file:

```bash
postman simulation run postman/simulations/checkout-dev.sim.yaml --proxy --output ndjson > sim.ndjson 2> sim.err &
```

`--proxy` is how to run it unless something below rules it out: nothing about
the code changes for the run — not a base URL, not a config file, not an SDK's
built-in host — and because nothing the proxy answers for has to resolve, an
internal hostname with no DNS record works.

It's up when `sim.ndjson` has a `listening` event; a start-up error is in
`sim.err`, a busy proxy port among them. Stop it with
`pkill -INT -f "simulation run .*<file>.sim.yaml"`. Nothing reloads: restart
it after a mock edit.

Read `postman simulation run --help` before driving it. The flags, what the
caller's own process needs in order to reach the proxy, and what to do about a
client that ignores it are all there and change with the CLI, so take them
from the command rather than from here.

What decides whether a proxied run proves anything is `origin:`. A member with
none in the `.sim.yaml` is never matched, so its traffic reaches the real
service and a run can come up having intercepted nothing — `simulation create`
copies that field from the mock's manifest, so editing the manifest alone
won't fix it ([reference/sim_yaml_schema.md](reference/sim_yaml_schema.md)).

## Running it on one port instead

`--port` is for a client that won't honour the proxy however it's configured.
The cost is repointing the code at the port — the change the proxy exists to
avoid — so a base URL that can't change rules this mode out too.

## Reading the log

A passing test command doesn't show the dependency path ran: read
`sim.ndjson`. A member with no `request` events isn't wired or isn't on this
path. Some answers come from the simulation itself and mean wiring, not code:

- `404 Unknown simulation member`, on a one-port run: a base URL lost its
  routeKey, or a client sent the wrong `x-mock-slug`.
- `501`, or a generated mock's `404 Endpoint not defined`: a call the mock
  doesn't model yet.
- `502 Proxy error`: the member's process died, usually an async throw in a
  mock without `interceptRequests: true`. It stays down and logs nothing
  until you restart; run that mock alone with `postman mock run` to see why.

## When a dependency goes down

Run it rather than reason from the code: each way of going down takes a different
path through the caller, and a stub skips the client code that picks the
path. Fail the one dependency in each shape that matters, a run each, with
the others answering normally:

- **Unreachable:** point its base URL at a port nothing listens on. This one
  needs the one-port run, since under `--proxy` the base URLs are the point.
- **Hanging:** give its member a `latency` condition longer than the
  client's timeout. If the client sets none, that is the finding: Node's
  `fetch` waits about five minutes, so say so rather than wait it out.
- **An error with a JSON body:** the `error` condition.
- **An error with an HTML body,** as proxies send: a copy of its mock whose
  default handler answers `500` with HTML. No condition can do this.

Only `overrides.conditions` on a member change it. Members always serve
their default handler and ignore `x-mock-scenario`, and a `scenarios` entry
with just a `path`, as the Postman app writes, does nothing. Fields and the
other conditions are in [reference/sim_yaml_schema.md](reference/sim_yaml_schema.md). An injected
failure never reaches the mock and isn't logged, so judge it by what the
caller did, and check the other members' logs for side effects, such as
stock reserved and never released.

## Its context document

Every simulation is created with a `<name>.context.yaml` beside it, holding
what the code is believed to rely on about the dependencies it calls — who the
caller is taken to be, which plan or permission is assumed, the order calls go
in, what gets retried, the shape of the data — and what each belief rests on.
The `.sim.yaml` says what the simulation is, not what the services it stands in
for do, so this is the record that saves a session the search.

Read it before anything else — it is YAML under a fixed schema — and write what
you established back into it before you finish. Each claim carries a `status`,
the `reason` the evidence adds up to it, the `verification` that was done and
what it showed, and a `source` to re-check it against, so the next session can
tell a claim a contract promises from one a request actually demonstrated.
Never recreate the file: it is written from a fixed template, and everything in
it is something an earlier session established. Its keys, fields and write-back
order are in
[reference/context_file.md](reference/context_file.md); read that before
writing to it.

## Keeping it

Commit your own mocks, the `.sim.yaml`, its context document and what
`postman dependency add` changed, so the next session or CI reruns it in one
command. Don't commit
`postman/.dependencies/`: a copy goes stale when its owner updates theirs,
and `postman dependency install` restores it. Don't commit `sim.ndjson`: the
CLI redacts common auth headers and fields, but other headers and bodies are
logged as sent. In CI, `postman dependency install` needs `POSTMAN_API_KEY`,
and `postman collection run <collection> --simulation <file> --port <n>`
starts and stops the simulation around a collection run.

`postman simulation push` uploads every member to the workspace, so ask
first. It fails on a pulled member, which keeps its owner's `id:`; copy it to
`postman/mocks/` and delete that line.

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
your code against these stand-ins rather than the real services, what still
needs the real service before release, and where each mock came from,
including when you skipped the owner's.

Then write what you established back into `<name>.context.yaml`, so the next
session starts where this one ended: a claim for anything the run settled that
was not already written down, a new `status` for every claim it settled or
contradicted, and in each case the `verification` that was done and the
`source` to re-check it against. Scope what you claim to what you actually
exercised — "held in the scenarios run" rather than "works" — since the record
is read later as evidence, and the two don't mean the same thing.
[reference/context_file.md](reference/context_file.md) has what each field is
for.
