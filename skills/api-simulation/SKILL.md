---
name: api-simulation
description: Boots every upstream a service depends on as one simulated environment — a `.sim.yaml` that starts several mocks together and injects latency, error, rate-limit, or chaos faults per dependency — so the real service under test can be exercised against mocked upstreams instead of a staging environment. Use when the user asks to "simulate my dependencies," "spin up a sandbox for this service," "test against a simulated environment," "mock everything this service calls," or "what happens when <dependency> is down or slow." Covers `postman simulate run`. Builds on api-mocking for the member mocks and api-discovery for working out what to mock; running a simulation locally needs nothing from bootstrap.
---

# API Simulation

## Overview

A mock is one fake server standing in for one dependency. A **simulation** is
the set of them a service needs in order to run at all, started as one process
from one file, with failure conditions attached per member. Mocks are the
individual servers; the simulation is the environment they add up to.

The service under test is **never** a member. It runs for real — its own
process, its own database — and only the upstreams it calls are mocked. That
distinction is the whole value: a green run means the endpoint itself works,
not that a mock of it answered.

One file holds the environment: `postman/simulations/NAME.sim.yaml`, listing
mocks that already exist on disk. `api-mocking` creates those members; this
skill composes and runs them. Composing and running a simulation is entirely
local and works signed out. Three things below do need `postman login`:
asking the Context Graph what a service depends on (step 1), finding a mock
the dependency's own team published (step 2), and recording a run against a
workspace (`-w` with `--simulation`). Each has a signed-out path, noted where
it comes up.

Reach for a simulation when a dependency isn't available: not implemented yet,
behind an auth wall, rate-limited, or simply not something to point at from a
dev machine. Reach for a single mock instead when there is exactly one
dependency and no failure mode to exercise.

## Process

**If a `.sim.yaml` already exists, do not skip to step 6.** An existing
simulation encodes the dependency set as it stood when someone wrote it, and a
member list that is one dependency short still starts cleanly and still goes
green — the missing call just leaves for the real upstream, or fails for a
reason that looks unrelated. Nothing in the file records when its mocks were
generated or from what, so an inherited sandbox is not a verified one. Run
step 1 against the current code and graph and compare the result with the
file's members. Report a dependency with no member, and a member the service no
longer calls, rather than quietly adding or deleting one. Then continue from
step 3.

1. **Resolve the service's name as the graph knows it, then ask the graph.**
   The Context Graph identifies an API by the name of the Git-connected
   repository behind it, not by a colloquial service name. Asking about
   `workspace-service` when the graph holds `postman-workspaces` returns a
   confident "this service does not call any other services" — a wrong name
   produces a negative answer, never an error, so it is indistinguishable from
   a genuine absence of dependencies. The repository is already bound: take the
   workspace from `.postman/resources.yaml` and the API name from the
   repository itself rather than inventing one.

   ```bash
   postman context-graph ask "What APIs and external services does the postman-workspaces API call or depend on? List them." --wait
   ```

   Named correctly, this returns the internal APIs, plus external services
   (managed Kafka, secrets, feature flags, telemetry), and often the specific
   endpoints called on each.

   **Those endpoints belong to the repository, not to your code path.** The
   graph aggregates call sites across the whole service, so the endpoints it
   names may be the ones some other route calls. Measured: asked about this
   service, it returned one dependency and named that dependency's create and
   destroy endpoints — while the route under test calls five different ones on
   it, and three further dependencies the answer omitted entirely. A mock built
   from that list answers the wrong calls and the route fails for a reason that
   looks like the service's fault. The answer also shifts with how the question
   is phrased, so two runs can disagree. Use the graph for *which* dependencies
   exist and who owns them; read the code for *which endpoints this path
   actually calls*.

   **Then cross-check against the service's own config** — the two are
   complementary, not redundant. The graph reports call sites across the whole
   repository; the config reports what this service resolves at runtime, and
   one code path usually touches a subset:

   ```bash
   grep -rnoE '[A-Z_]*BASE_?URL|baseUrl' config/
   ```

   Simulate what the path under test actually calls, taking the endpoint list
   from the code. Each source holding entries the other misses is normal and is
   not a sign either is wrong — they answer different questions.

   `context-graph ask` needs `postman login`, takes roughly 20–40s, and
   defaults to a 300s timeout. Signed out, the grep is the whole of this step;
   say the list came from this repository alone, since a dependency reached
   through a shared client library or resolved at runtime won't appear in it.

   **Split the dependency list by wire protocol, and say so before running
   anything.** A code mock serves `http` or `https` and nothing else — that is
   the only `protocol` its manifest accepts, and the generator has one emitter.
   So the line is the protocol, not whether a dependency is internal or
   third-party:

   - **Simulatable** — anything speaking HTTP, including third-party APIs. A
     feature-flag service, an error tracker, a chat webhook and an internal
     microservice are all the same kind of member.
   - **Not simulatable** — gRPC, message queues and brokers, databases, caches.
     A workflow engine (Temporal), a managed Kafka, MySQL and Redis each need a
     real local instance; no HTTP mock can stand in for the client's connection.

   The second group is where a simulation quietly stops meaning anything. If the
   service awaits one of them without a try/catch, leaving it down fails every
   request for a reason that has nothing to do with the mocks — a workflow
   client that is disabled rather than absent throws on first use, and every
   row gets rolled back after its upstream writes already succeeded. Run those
   dependencies for real (a local dev server is usually enough), and state which
   dependencies fell outside the simulation when reporting the result, so nobody
   reads a green run as covering them.

2. **Resolve each dependency to a mock — the producer's, if one exists.** A
   mock published by the team that owns the dependency reflects how that
   service actually behaves; one generated locally reflects only what this
   agent inferred.

   **Ownership is the test, and neither a name match nor a Git connection
   establishes it.** A bare keyword search ranks on name across every workspace
   in the organization, so it surfaces personal and demo-workspace mocks that
   merely share a word with the dependency — searching `identity` returned five,
   none of them the internal Identity service. `isGitConnected=true` filters out
   the obvious scratch copies and is worth adding, but it is not sufficient:
   searching for a user-management mock returned a Git-connected mock whose name
   matched exactly, owned by an unrelated workspace, while the dependency's own
   workspaces sat elsewhere in the results. Adopting it would have wired the
   simulation to a stranger's mock with the appearance of the producer's.

   ```bash
   postman search mocks "access control" --ownership organization \
     --filter "isGitConnected=true"
   ```

   So resolve the owner first and filter on it:
   `--filter "workspaceId=<the dependency's workspace id> AND isGitConnected=true"`,
   using the owner the graph named in step 1. With no owner confirmed, report
   the candidate as unverified and generate instead — do not promote a name
   match to "the producer's mock", and say where whatever you used came from.

   Only when no mock exists for a dependency, generate one —
   `postman mock generate <SOURCE> -n <name>-sim` against that dependency's
   spec or collection, or sourceless for a throwaway, then make it answer the
   endpoints step 1 reported. State per dependency which of the two it was;
   "all four upstreams are mocked" hides that three were endorsed by their
   owners and one was invented here.

   Both search commands need `postman login`. Signed out, generating is the
   only path available — say that a published mock may exist but wasn't
   searched for, which is not the same as reporting that none exists.

3. **Give every member a distinct port.** `postman mock generate` writes port
   `4500` into every `config.yaml` it creates, so two generated mocks in one
   simulation always collide. The run fails closed rather than binding one of
   them:

   ```
   Error: Duplicate mock port: 4500 (used by both 'acs-sim' and 'features-sim')
   ```

   Set `port:` on the `.sim.yaml` entry to override what the manifest declares.
   That keeps the port map in the one file that needs it and leaves each mock's
   `config.yaml` untouched.

4. **Author the `.sim.yaml`.** The baseline environment carries no faults —
   every dependency healthy, so a failure in the run is the service's:

   ```yaml
   simulation: bulk-visibility-sandbox
   mocks:
     - path: ../mocks/acs-sim/config.yaml
       port: 4901
     - path: ../mocks/features-sim/config.yaml
       port: 4902
   ```

   `path` points at a mock's `config.yaml`. Relative paths resolve next to the
   `.sim.yaml` first, then from the working directory. Full schema and every
   fault type: [reference/sim_yaml_schema.md](reference/sim_yaml_schema.md).

5. **Point the service's upstreams at the mock ports.** This is the step the
   CLI cannot do for you, and the one that decides whether the run means
   anything. Find how the service resolves each upstream base URL and override
   it to `http://127.0.0.1:<port>`: an environment variable per upstream if the
   service reads them, otherwise a config profile selected at boot
   (`APP_ENV=sandbox`) that inherits the normal development config and replaces
   only the base URLs.

   Two traps worth checking before trusting the run: a service that merges
   static config objects may read `process.env` zero times, so exported
   variables silently do nothing; and **authentication often resolves through a
   different key than the upstream list** — a session or identity middleware
   with its own configured URL will keep authenticating against the real remote
   service even when every entry in the upstream list points at a mock. Verify
   from the service's own boot log which URL each dependency resolved to.

6. **Run it, then prove the real service drove the mocks.** Hold the simulation
   in the background; one process owns every member port.

   ```bash
   postman simulate run postman/simulations/bulk-visibility-sandbox.sim.yaml --no-history > sim.log 2>&1 &
   ```

   Startup prints one `mock started` line per member with its bound port. Each
   request then logs `request sent` and `request completed` against the member
   that served it, so the log is the evidence that traffic reached the
   dependencies — see Verification.

   Stop it with Ctrl+C, which stops every member together. Killing the shell
   job instead can orphan the mock servers — `postman` is a wrapper around a
   nested platform binary — and the next run then fails with
   `Port <N> is already in use`. In a script, signal the process group.

   **Wait for every member before starting the service, and don't use `curl
   -f`.** Members bind one at a time, so the first port to answer does not mean
   the rest are listening; poll each one, or wait for as many `mock started`
   lines as the file has members. And `-f` makes curl exit nonzero on a 4xx/5xx
   response, so a member carrying an injected `error` never looks ready — the
   probe spins until it times out and reports mocks that are, in fact, up:

   ```bash
   for port in 4901 4902; do
     until curl -sS -o /dev/null -m 2 "http://127.0.0.1:$port/" 2>/dev/null; do sleep 1; done
   done
   ```

7. **Add a failure variant once the baseline passes.** Copy the baseline to a
   second `.sim.yaml` and attach a condition to one member. Keep them as
   separate files rather than editing faults in and out of one — the pair is
   what shows a reviewer the failure was reproduced and the fix held.

   ```yaml
   simulation: bulk-visibility-acs-down
   mocks:
     - path: ../mocks/acs-sim/config.yaml
       port: 4901
       scenarios:
         - path: ../mocks/acs-sim/default.js
           overrides:
             conditions:
               error:
                 status_code: 503
   ```

   Four conditions exist: `latency` (`delay_ms`), `error` (`status_code`,
   400–599), `rate_limit` (`requests_per_minute`), and `chaos`
   (`failure_rate`, 0–100). When a dependency's real failure rate or latency is
   known from telemetry, use those numbers — a simulation set to the
   dependency's actual 1.2% error rate tests something the service will meet.

8. **Keep it as a CI gate.** The same two commands — boot the simulation, boot
   the real service against it, run the collection at the real route — make a
   regression gate scoped to the paths that can break it. Use the readiness loop
   from step 6 rather than a fixed sleep, which is how this job goes flaky —
   and note that a gate copied from the healthy variant and pointed at a
   faulted one will hang on `curl -f`, then fail with a message blaming
   mocks that started correctly. Pass `--no-history` in CI. See
   `ci-integration`.

## Critical Rules

1. **An existing simulation is a claim, not a verified environment.** Finding
   the mocks and the `.sim.yaml` already written is not evidence that they still
   describe what the service calls today. Re-derive the dependency set before
   running it; a stale member list produces a green run that proves less than it
   appears to.
2. **The service under test is never a member of the simulation.** Mocking it
   alongside its dependencies produces a run that proves nothing. If no real
   process is under test, this is a set of mocks, not a simulation — use
   `api-mocking`.
3. **Distinct ports, or the run fails closed.** Every generated mock declares
   `4500`. Override with `port:` per entry in the `.sim.yaml`.
4. **A scenario entry with no `overrides.conditions` injects nothing.** A bare
   `- path: ../mocks/x/config.yaml` under `scenarios:` parses, starts, and
   applies zero faults. It reads like a configured scenario and is a no-op;
   omit `scenarios:` entirely for a healthy member.
5. **Faults apply to the whole member, not one route.** An injected `error`
   answers every request to that mock. To fail one endpoint while others
   succeed, put that endpoint in its own mock.
6. **`id:` and `routing:` keys are ignored by the CLI.** They may appear in a
   `.sim.yaml` written by the Postman app. Do not add them expecting behavior,
   and do not report header-based routing as configured.
7. **`overrides.bypass` is not supported** — the CLI warns and ignores it.
   Proxying a route through to the real dependency is not available here; don't
   write a simulation whose correctness depends on it.
8. **Prefer the producer's mock to a generated one, and say which you used.**
   A locally generated mock encodes this agent's assumptions about the
   dependency, which is the failure mode simulations exist to prevent.
9. **Recording history needs both `-w` and `--simulation`.** A local
   `.sim.yaml` has a name, not an id, so `-w` alone records nothing. Use
   `--no-history` when a run shouldn't be recorded at all.

## Verification

A simulation that started is not a simulation that was used. `mock started`
lines only prove ports are bound.

Prove the real service drove each dependency by counting completed requests per
member out of the simulation log:

```bash
grep -a 'request completed' sim.log \
  | sed -E 's|.*request completed +||; s|http://localhost:[0-9]+||; s|\?[^ ]*||' \
  | awk '{print $1, $2, $3, $4}' | sort | uniq -c | sort -rn
```

```
   2 payments-sim GET /cart 503
   2 inventory-sim GET /cart 200
```

A member with zero requests means the service never called it — either the
wiring in step 5 didn't take, or that dependency isn't on the path under test
and doesn't belong in the simulation. Report the per-member counts, not just
that the run exited 0.

Readiness probes land in these counts too, since the log records every request
the member served regardless of who sent it. Subtract them, or probe a route
the service under test never calls, before citing a count as service-driven
traffic.

For a fault, confirm the response actually changed: an injected `error` returns
that status with `"scenario":"error"` in the body, `rate_limit` returns 429
once the per-minute count is exceeded, and `latency` shows up as elapsed time
on the request. A 200 proves the fault did not apply.

Then state plainly which dependencies were simulated, which mock each one used
and whether it was the producer's or generated here, and which dependencies
were left real because they aren't HTTP.

## Reference

- [reference/sim_yaml_schema.md](reference/sim_yaml_schema.md) — the complete
  `.sim.yaml` schema: required and optional fields, mock reference forms, port
  resolution order, all four fault conditions with their validation bounds, and
  the keys the CLI ignores.
