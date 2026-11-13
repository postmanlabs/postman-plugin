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

The CLI syntax is `<fn>(<metric>, <value>)` — operator first (e.g. `less_than(avg, 500)`), matching `SKILL.md` and `postman-perf-capabilities.md`. Do not reverse it to `avg(less_than, 500)`; the command is rejected.

| ReadyAPI LoadTest assertion | `--pass-if` | Fidelity |
|---|---|---|
| Step Average (ms) | `less_than(avg, <ms>)` | **approximate** — per-step vs aggregate (see below) |
| Step Maximum (ms) | — (note: closest is `less_than(p99, <ms>)`) | partial — no absolute-max metric |
| Step TPS (min) | `greater_than(rps, <tps>)` | **approximate** — per-step vs aggregate (see below) |
| Max Relative Errors (fraction) | `less_than(error_rate, <pct>)` | exact |
| Max Absolute Errors (count) | — (note) | none — thresholds are rates, not counts |
| Step Status | — (add `pm.test` status checks) | none at run level |

Priority when several exist: response-time SLA > throughput > error rate. If none exist, the suggested default is `less_than(error_rate, 5)` — tell the user it's a default.

**Per-step gates are not aggregate gates.** A ReadyAPI Step Average / Step TPS assertion constrains a single TestStep, but the CLI's `avg`/`rps` aggregate the whole run. A fast request can hide another step's excessive average latency, and other requests' throughput can hide insufficient TPS for the constrained step. So emit the `--pass-if` as the closest available gate, but **report in the import report that the original per-step gate was lost** — do not claim the assertion was preserved. To keep a true step-level check, add a `pm.test` on `pm.response.responseTime` to that specific request.

## Multiple LoadTests

A performance run executes ONE collection. Each `<con:loadTest>` in the project becomes its own `postman performance run` command in `<name>.perf.md`; they cannot run concurrently in a single run (noted in `perf.json.notes`).

## Scope the run to the parent TestCase — do not run the whole collection

A `<con:loadTest>` drives exactly its parent `<con:testCase>`'s step sequence. The imported collection holds much more than that one case: the `APIs/` interface request library plus every other suite/case under `Tests/`. Handing the perf command the whole collection UID would load-test all of it — interface examples and unrelated cases included — which is not the LoadTest.

So each generated `postman performance run` must be scoped to just that case's requests:

- **Preferred — a dedicated per-case collection.** Publish a collection containing only the parent TestCase's request sequence, carrying that case's applicable variables, auth, and scripts, and hand off *its* UID. This is unambiguous and works on every runner.
- **Only if your run target genuinely supports folder scope** may you instead point the run at the case's folder; verify the selector resolves to exactly that folder's requests before relying on it.

Carry the chosen selection (per-case collection UID, or verified folder) through the report and the command handoff — never emit a command that targets the whole imported collection.

## Grounding

Profiles, flags, units (`--duration` in minutes), and the single-`--pass-if` constraint are verified against `postman-cli`, `performance-test-api`, and `postman-performance-test` — see `references/postman-perf-capabilities.md`.
