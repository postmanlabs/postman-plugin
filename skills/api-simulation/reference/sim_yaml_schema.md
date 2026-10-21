# `.sim.yaml` reference

Read this when writing or debugging a `.sim.yaml` by hand.
`postman simulation create` writes the same shape; the Postman app adds
`id:` fields, which a local run ignores.

```yaml
simulation: checkout-dev               # required: the name
routing: path                          # path (default) or header
mocks:                                 # required: one entry per member
  - name: catalog                      # optional display name
    routeKey: catalog                  # lowercase letters, digits, - and _
    origin:                            # optional: hostnames, for --proxy
      - catalog.internal.example.com
    path: postman/mocks/catalog        # a mock's folder, config.yaml or handler
    scenarios:                         # optional: conditions, below
      - overrides:
          conditions:
            latency: { delay_ms: 250 }
```

Run the `.sim.yaml` rather than a simulation id: a run by id drops every
member's conditions (CLI 1.70.0–1.73.0).

`simulation create` writes each `path:` relative to the repository root, the
directory holding `postman/`, and puts the simulation in a folder of its own
(`postman/simulations/checkout-dev/checkout-dev.sim.yaml`) so its
`<name>.context.md` sits beside it; the app records that document in a
`context:` ref. Reading is broader than writing — a path relative to
`postman/simulations/`, to the file, absolute or `~/`, naming the folder or
the manifest inside it, all resolve — and an unresolvable one names every
directory it looked in.

## Conditions

| Condition | Field | Effect |
| --- | --- | --- |
| `latency` | `delay_ms` | Holds each request that long, then serves it. |
| `error` | `status_code` (400–599) | Every request gets that status as JSON, with `"scenario":"error"`. |
| `rate_limit` | `requests_per_minute` | Requests over the limit get `429` and `Retry-After`. |
| `chaos` | `failure_rate` (0–100), optional `status_code` | That share of requests, at random, get `500` or that status. |

- A condition covers every route on its member. To fail one endpoint while
  its siblings succeed, give that endpoint a mock of its own.
- They run in a fixed order (`latency`, `error`, `rate_limit`, `chaos`), and
  the first to fail a request ends it, so set one failure at a time,
  optionally with `latency`.
- An unknown condition name is ignored silently, so a misspelling injects
  nothing. `overrides.bypass` prints a warning and is ignored.
- A `latency` request is served and logged, with a `duration` that leaves
  out the delay.

## Proxy mode (`--proxy`)

The same `.sim.yaml`, with `origin` deciding which hostnames reach which
member. A path is required: `--proxy` takes no simulation id, because the
file on disk is what declares the hostnames.

`origin` is declared in the mock's own manifest and copied onto every member
built from it, so every simulation using that mock intercepts the same hosts:

```yaml
# postman/mocks/payments/config.yaml
name: payments
origin: api.stripe.com        # a string, or a list
mockSrc: ./default.js
```

A scheme and port are stripped (`https://API.Stripe.com:443` →
`api.stripe.com`). A value that can't match a `Host` — a path left on a
copied URL, a wildcard — is warned about and skipped by name, leaving the
mock a working member. `mock get` shows what a mock declares, and `origin` is
left out of a member entirely when its mock declares none, since `origin: []`
would read as deliberately unreachable.

A matched request is forwarded to that member with `pm-mock-scenario`,
`x-mock-scenario` and `x-mock-session`, plus `/<routeKey>` on the path under
`routing: path` or an `x-mock-slug` header under `routing: header`. A member
that doesn't answer in 30s gives `504`, one that can't be reached `502`.
Members run on throwaway ports, so a manifest's `port` is ignored and no
start history is recorded (`--workspace` and `--simulation` warn). Ctrl+C
prints the total, mocked and passed-through counts.

| Flag | Notes |
| --- | --- |
| `--proxy-port <n>` | Default `7001`, bound to `127.0.0.1` — point clients there, not at `localhost`. A busy port fails at once with exit `1`. |
| `--scenario <name>` | Sent to every member, default `default`. A member without that scenario serves its default. |
| `--session <id>` | Sent as `x-mock-session`. Default: a generated id. |
| `--log-format <text\|json>` | Request log: method, host, path, destination (a routeKey, or `passthrough`), status, duration. |
| `--log-body` | Also log response bodies, truncated. Buffers responses; debugging only. |
| `--doctor` | Probe each installed HTTP client through the proxy, print a fix for each that ignores the proxy variables, exit `0` if all reached it. With no origins declared it reports nothing to probe. |

Each of these without `--proxy` is a usage error (exit `2`), as is an
unsupported `--log-format`.

## The log (`--output ndjson`)

One JSON event per line on stdout; notices go to stderr, so keep them apart.

- `listening`: every member has started; a member that fails to start
  stops the run with `Error: …` and exit code 1.
- `request`: one per request a member served.
- `summary`, on stop: `requestsServed` (under 400), `requestsFailed` (400
  and up), `uptimeMs` and `signal`. Injected failures and the simulation's
  own `400`, `404` and `502` aren't counted.
