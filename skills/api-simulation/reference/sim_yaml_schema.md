# `.sim.yaml` reference

Read this when writing or debugging a `.sim.yaml` by hand. Flags are in
`postman simulation run -h`.

`postman simulation create` writes the file to `postman/simulations/`; the
Postman app writes the same shape with `id:` fields added, which a local run
ignores.

```yaml
simulation: checkout-dev               # required: the name
routing: path                          # path (default) or header
mocks:                                 # required: one entry per member
  - routeKey: catalog                  # its address: lowercase letters, digits, - and _
    path: ../mocks/catalog/config.yaml # a mock's config.yaml, or a .js handler
    scenarios:                         # optional: conditions, below
      - overrides:
          conditions:
            latency: { delay_ms: 250 }
```

A member's `path` resolves from the `.sim.yaml`'s folder. Don't write `port:`
on a member: each gets an internal port behind the simulation's one, and two
equal `port:` values stop the run. Run the `.sim.yaml` rather than a
simulation id: a run by id drops every member's conditions (CLI 1.70.0).

## Routing

- **`path`**: a member answers at `http://localhost:<port>/<routeKey>`, and the
  routeKey is stripped, so `/shipping/rates` reaches the `shipping` member
  as `/rates`.
- **`header`**: every member shares `http://localhost:<port>`, and the caller
  picks one with `x-mock-slug: <routeKey>`. Use it only when the caller can
  send that header.

The simulation answers these itself, without reaching a member, and logs
neither:

| Response | Cause |
| --- | --- |
| `400 Prefix the request path with the member routing token` | The path was `/`, or under `header` routing the header was missing. |
| `404 Unknown simulation member '<x>'` (lists the valid ones) | `<x>` isn't a routeKey. Often a client that dropped its base URL's path, so `<x>` is the endpoint's own first segment. |
| `502 Proxy error` | The member's handler threw. Nothing is logged; run that mock alone with `postman mock run` to see the error. |

## Conditions

Each member serves its mock's default handler. A `scenarios` entry changes
it only through `overrides.conditions`:

| Condition | Field | Effect |
| --- | --- | --- |
| `latency` | `delay_ms` | Holds each response that long. |
| `error` | `status_code` (400–599) | Every request gets that status, with `"scenario":"error"`. |
| `rate_limit` | `requests_per_minute` | Requests over the limit get `429` and `Retry-After`. |
| `chaos` | `failure_rate` (0–100), optional `status_code` | That percentage of requests, at random, get `500` or that status. |

- A condition covers every route on its member. To fail one endpoint while
  its siblings succeed, give that endpoint a mock of its own.
- Set one failure at a time, optionally with `latency`: once one condition
  fails a request, the others don't run.
- An unknown condition name is ignored silently, so a misspelling injects
  nothing.
- An entry with only a `path` or `id`, as the Postman app writes, changes
  nothing. `overrides.bypass` prints a warning and is ignored.
- Injected failures never reach the mock and aren't logged.

## The log (`--output ndjson`)

One JSON event per line on stdout; notices go to stderr, so redirect the two
apart.

- `listening`: the port, and each member's routeKey and address. All members
  start before it, so one `listening` means the whole simulation is up. A
  member that fails to start stops the run with `Error: …` and exit code 1.
- `request`: one per request a member served, with `routeKey`, `method`,
  `path`, `statusCode`, `duration` (ms), headers and bodies.
- `summary`, on stop: `requestsServed` and `requestsFailed`, totals only.

A run of a `.sim.yaml` that's linked to a workspace is recorded in that
simulation's start history in Postman; `--no-history` opts out.
