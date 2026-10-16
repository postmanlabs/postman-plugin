# ReadyAPI LoadTest → Postman performance run

How `scripts/loadtest_to_perf.py` maps a `<con:loadTest>` to a `postman performance run`. A LoadTest is a child of a `<con:testCase>` and drives that case's steps under load — so the perf run targets the collection folder that the case became.

## The clean mappings

| ReadyAPI LoadTest | Postman perf | Fidelity |
|---|---|---|
| `<con:threadCount>` | `--vu-count` (peak VUs) | exact |
| `<con:limitType>TIME</con:limitType>` + `<con:testLimit>` (seconds) | `--duration` (minutes, rounded up, min 1) | exact |
| Parent test case's steps | the collection folder the run executes | exact |

## Strategy → load profile

Postman has exactly four profiles: `fixed`, `ramp-up`, `spike`, `peak`. ReadyAPI strategies map as:

| ReadyAPI `<con:loadStrategy><con:type>` | Postman `--load-profile` | Notes |
|---|---|---|
| `Simple` | `fixed` | constant threads. `testDelay`/`randomFactor` think-time → note (no perf knob) |
| `Thread` (ramp start→end) | `ramp-up` | peak VUs = end thread count; down-ramp not representable |
| `Burst` | `spike` | idle-gap timing lost |
| `Variance` (sawtooth) | `spike` | oscillation period/amplitude lost |
| `Fixed Rate` (req/s target) | `fixed` | **perf is concurrency-driven, not rate-driven** — tune VUs to hit the rate; reported |
| `Grid` / `Script` | `fixed` | arbitrary/programmatic schedule not representable |

## Run length edge cases

- `limitType=TIME` → `testLimit` is seconds, used directly.
- `limitType=COUNT` (Total Runs) or Runs-per-Thread → no duration equivalent (Postman perf is time-based). Defaulted to 60s with a note; set `--duration` to the expected wall-clock.
- No limit (runs until stopped) → defaulted to 60s with a note.

## LoadTest assertions → `--pass-if` (one only)

`--pass-if` is **single and non-repeatable**. The mapper picks the most load-relevant assertion and notes the rest:

| ReadyAPI LoadTest assertion | `--pass-if` | Fidelity |
|---|---|---|
| Step Average (ms) | `avg(less_than, <ms>)` | exact |
| Step Maximum (ms) | — (note: closest is `p99`) | partial — no absolute-max metric |
| Step TPS (min) | `rps(greater_than, <tps>)` | exact |
| Max Relative Errors (fraction) | `error_rate(less_than, <pct>)` | exact |
| Max Absolute Errors (count) | — (note) | none — thresholds are rates, not counts |
| Step Status | — (add `pm.test` status checks) | none at run level |

Priority when several exist: response-time SLA > throughput > error rate. If none exist, the suggested default is `error_rate(less_than, 5)` — tell the user it's a default.

## Multiple LoadTests

A performance run executes ONE collection. Each `<con:loadTest>` in the project becomes its own `postman performance run` command in `<name>.perf.md`; they cannot run concurrently in a single run (noted in `perf.json.notes`).

## Grounding

Profiles, flags, units (`--duration` in minutes), and the single-`--pass-if` constraint are verified against `postman-cli`, `performance-test-api`, and `postman-performance-test` — see `references/postman-perf-capabilities.md`.
