---
name: api-simulation
description: Runs your code for real against stand-ins for the HTTP services it calls, served together as one environment on one local port or one deployed URL, whether that code is a service you're changing, a frontend, a test suite or a demo. Use when you add or change code that calls other services and need to run it, test it, prove a fix or reproduce an upstream failure (timeouts, 5xx, 409, 429) end to end, locally or in CI, without the real services because they're unreachable, need credentials, cost money, have side effects or don't exist yet. Also answers what happens to a request, or to the data it writes, when a service it calls goes down, is slow or returns errors ("what happens to a booking if the email service is down?"), by running each failure instead of reading the code. Applies even when nobody says mock or simulation. To give a frontend or another team a stand-in for an API, use api-mocking. Covers `postman simulation`.
---

# API Simulation

A simulation serves several mocks as one environment, each reached by its
routeKey: as a path prefix by default, or as an `x-mock-slug` header when the
caller's paths can't change.

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

- **Members are the code's HTTP dependencies.** Databases, queues and caches
  aren't; run them locally. **api-discovery** can find calls made through
  shared code; ask about the repo by its `git remote` name, because a close
  name matches another repo.
- **Each member needs a mock: see `api-mocking`,** which looks for the owning
  team's published mock before building one. For a question, one built from
  the contract will do; one that invents responses can send the caller down a
  path the real service never would. In a mock you build, answer `501` for calls this path
  doesn't make: a `404` reads to the caller like a real "not found".
- **Prefix each mock's `pm.state` keys with its name.** As of CLI 1.73.0,
  members of a local run read each other's keys, so two mocks storing
  `orders` overwrite each other.

## Running it

The run is a server that never exits, so a foreground command never returns.
Start it in the background with an explicit port, its log in a file:

```bash
postman simulation run postman/simulations/checkout-dev.sim.yaml --port 4900 --output ndjson > sim.ndjson 2> sim.err &
```

Without `--port`, a busy 3000 silently becomes a random port and every base
URL points at nothing. It's up when `sim.ndjson` has a `listening` event; a
start-up error is in `sim.err`. It listens on 127.0.0.1 only, so a caller in
a container or VM can't reach it. Stop it with
`pkill -INT -f "simulation run .*<file>.sim.yaml"` — `-f` matches the whole
command line, so a pattern built from the bare filename misses a run launched
by path; `kill $!` leaves it running, because the `postman` launcher ignores
the signal. Nothing reloads: restart it after a mock edit.

Point the caller at it without changing what the code does once deployed.
Under path routing, swap only the host and keep the path:
`https://catalog.internal.example.com/v2` becomes
`http://127.0.0.1:4900/catalog/v2`; a dropped `/v2` is the usual cause of a
`404`. A hard-coded base URL should read an environment variable with
today's value as the default. If the code mustn't change at all, run it
behind the proxy instead, below.

## Through a proxy, when no base URL can change

`simulation run <file.sim.yaml> --proxy` puts the members behind a local
forward proxy that answers for the dependencies' own hostnames, so the code
keeps the base URLs it ships with and reaches the mocks through
`HTTP_PROXY`/`HTTPS_PROXY`. Any other host passes through to the real
service, HTTPS tunneled undecrypted. Reach for it when hostnames are
hard-coded, built from config the change shouldn't touch, or owned by an
SDK — and because nothing it answers for has to resolve, an internal
hostname with no DNS record works.

- **A hostname belongs to the mock, not the simulation.** `origin:` in the
  mock's own `config.yaml`, a string or a list, carried onto every member
  built from it. A member with none is never matched and its host reaches
  the real service; with none anywhere, the proxy intercepts nothing.
- **Check the client honors the variables first:** `--proxy --doctor` probes
  the ones the project has installed and prints a fix for each that doesn't.
  Node's `fetch` ignores them, needing undici's `EnvHttpProxyAgent` as the
  global dispatcher — keep that out of the code under test by preloading it
  with `NODE_OPTIONS=--require ./proxy-agent.cjs`, from a file inside the
  project so `undici` resolves.
- **Export all three of the banner's lines**, `HTTPS_PROXY`, `HTTP_PROXY`
  and `NODE_EXTRA_CA_CERTS`, in the shell that starts the code, before it
  starts: an intercepted HTTPS host is served from a CA made fresh each run
  and deleted on exit. Copy the CA path from the banner, since each install
  channel has its own, and set all three for that session alone, so trust in
  a CA ends with the run that made it.
- Every request is logged as mocked or passed through, `--log-format json`
  for machine-readable lines, so a dependency logged as passed through means
  a missing `origin`, not a mock that served. Conditions don't apply here and
  member `scenarios` are ignored, so failures need the one-port run;
  `--scenario <name>` picks one for every member at once, and a member
  without it serves its default.

## Reading the log

A passing test command doesn't show the dependency path ran: read
`sim.ndjson`. A member with no `request` events isn't wired or isn't on this
path. Some answers come from the simulation itself and mean wiring, not code:

- `404 Unknown simulation member`: a base URL lost its routeKey, or a client
  sent the wrong `x-mock-slug`.
- `501`, or a generated mock's `404 Endpoint not defined`: a call the mock
  doesn't model yet.
- `502 Proxy error`: the member's process died, usually an async throw in a
  mock without `interceptRequests: true`. It stays down and logs nothing
  until you restart; run that mock alone with `postman mock run` to see why.

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

Only `overrides.conditions` on a member change it. Members always serve
their default handler and ignore `x-mock-scenario`, and a `scenarios` entry
with just a `path`, as the Postman app writes, does nothing. Fields and the
other conditions are in [reference/sim_yaml_schema.md](reference/sim_yaml_schema.md). An injected
failure never reaches the mock and isn't logged, so judge it by what the
caller did, and check the other members' logs for side effects, such as
stock reserved and never released.

## Its context document

Every simulation is created with a `<name>.context.md` beside it, holding
what running this one has taught: the commands that start it and prove it's
up, the preconditions and what breaks when one fails, the data seeded to test
with, and what a passing run still doesn't prove. The `.sim.yaml` says what
the simulation is, not how it behaves, so read this before rebuilding any of
it — a new file is mostly `@todo`s, which are the questions a first real run
answers. Leave it truer than you found it: the `@todo`s your run can answer,
whatever it found wrong, a precondition you had to discover, and what the
members actually served, which is the one section a run always rewrites.

Keep it to its four Markdown sections and about a screenful, and give each
line the same test: the repo doesn't already state it. A precondition you had
to discover, a failure and its cause, what the simulation can't reproduce, and
which members served or stayed silent are what only a run teaches. For routes,
request shapes, auth or config, name the file that holds them and let the
reader go there — one source stays true, and a named file is how a credential
stays out of a committed document. Write what holds between runs, leaving
counts and timings in the log. Its sections and conventions are in
[reference/context_file.md](reference/context_file.md).

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
