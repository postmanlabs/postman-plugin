# Load model: injection, throttle, duration, assertions → `postman performance run`

## What Postman supports (verify against the installed `postman performance run --help`; don't assume a version)
- **Closed model only.** `--vu-count N` virtual users each loop the collection until the run ends. There's no arrival rate and no target RPS.
- `--load-profile`: `fixed` (N the whole time), `ramp-up` (grows to N), `spike` (a burst to N), `peak` (rises to N, holds, falls). Each has a fixed shape; you can't set stage times from the CLI.
- `--duration` in whole minutes (≥ 1). `--pass-if` takes **one** condition: `less_than|greater_than|less_than_eq|greater_than_eq(avg|p90|p95|p99|error_rate|rps, value)`. `error_rate` is a percentage.
- Cloud runs need `--vu-count` ≥ 10. For local runs, any value ≥ 1 works.

## Injection (`inj:*`)
**Closed steps: exact or near-exact.**
| Gatling | Flags | Status |
|---|---|---|
| `constantConcurrentUsers(n).during(d)` alone | `--vu-count n --load-profile fixed --duration ceil(d)` | mapped (approximated if d isn't whole minutes: say "rounded up") |
| `rampConcurrentUsers(a).to(b).during(d)`, then `constantConcurrentUsers(b).during(h)` | `--vu-count b --load-profile ramp-up --duration ceil(d+h)` | approximated: the ramp/hold ratio is fixed by the profile |
| `rampConcurrentUsers(a).to(b)` alone | `--load-profile ramp-up` | approximated |
| `incrementConcurrentUsers` (steps) | `ramp-up` to the final level | approximated: no stairs |

**Open steps: always approximated.** Gatling open users run the journey **once** and leave. Postman VUs loop. To keep the same load on the server, match the concurrency using Little's law:

> **VUs ≈ arrival rate (users/s) × journey time (s)**

- **Journey time** = the sum of pauses (use the mean for ranges, e.g. `pause(1,3)` → 2 s) + the expected response times. Use `0.3 s` per request if unknown, and say so — **but** if a path makes the latency evident (e.g. `/delay/1` ≈ 1 s, a Gatling request literally named "slow …"), use that value instead and note it. Pick one rule per conversion and state it, so two runs don't diverge.
- **Cloud VU floor.** If the computed `--vu-count` is below 10 and the user will run on **cloud**, keep the computed value but add a one-line note that cloud requires ≥ 10 (so they raise it deliberately, knowing it increases load). For **local** runs any value ≥ 1 is fine. Never silently inflate the count to clear the floor.
- **`pace(d)` is a floor, not an addend.** `pace` forces each iteration to take *at least* `d`; it does **not** add to the request/pause time, it subsumes it. So when a scenario has `pace(d)`, the journey time is `J = max(d, pauses + response times)`, **not** `pauses + response times + d`. Adding `pace` as a term overstates `J` and inflates `--vu-count`. Show the `max(...)` in MIGRATION.md.
- **A loop inside the per-user journey changes what `J` is.** If the open-model journey wraps a `during(t) { … }` / `forever { … }` loop (often with `pace`), each arriving user stays busy for the **whole loop duration**, so `J` is that duration, not one pass. Example: `constantUsersPerSec(20)` over a journey of `during(5.minutes){ pace(5s).exec(...) }` → `J = 300 s`, so `VUs ≈ 20 × 300 = 6000`, not `20 × (one 5 s iteration)`. This is usually a very large number — **do not silently pick the one-iteration reading**; compute both, put the arithmetic and the chosen reading in MIGRATION.md → Load model, and tell the user to confirm, because it swings `--vu-count` by orders of magnitude. A finite closed cap (`maxDuration`, cloud VU limits) may force you lower; say so.
- Round up. Use `--vu-count` ≥ 1 (≥ 10 if the user will run it on cloud).

| Gatling | Flags |
|---|---|
| `constantUsersPerSec(r).during(d)` | `--vu-count ceil(r × J) --load-profile fixed --duration ceil(d)` |
| `rampUsersPerSec(a).to(b).during(d)` (then `constantUsersPerSec(b)…`) | `--vu-count ceil(b × J) --load-profile ramp-up`, with duration the sum of all steps |
| `atOnceUsers(n)` | a burst: `--load-profile spike --vu-count n` if it's the main (only sustained) step. **When it coexists with a ramp/constant step, the sustained step is the dominant shape** — use that profile and its Little's-law VU count; fold the burst in as the initial spike and note it. Only when the burst's `n` exceeds the sustained VU count does it set the peak (use the larger, and say so) |
| `rampUsers(n).during(d)` | n users arriving evenly over d, so the rate is n/d: `--vu-count ceil((n/d) × J)`, ramp-up |
| `stressPeakUsers(n).during(d)` | `--load-profile peak --vu-count ceil(peak rate × J)` |
| `nothingFor(d)` | none. Add d to the explanation. Gap if it's the only step, otherwise approximated |
| `.randomized()` | none: gap (arrivals aren't randomised) |

When the chain has several steps, choose **one** profile for the dominant shape and put every step with its arithmetic in MIGRATION.md → Load model. Also write what the user should watch for: "Gatling measured N users arriving per second; Postman keeps V users busy. Compare throughput (rps) with your Gatling report rather than user counts."

Example (show your working like this):
```
Source: rampUsersPerSec(1).to(10).during(60s), then constantUsersPerSec(10).during(120s)
Journey: 2 requests × 0.3 s (assumed) + pause(1,2) mean 1.5 s = 2.1 s
Peak VUs: 10 users/s × 2.1 s = 21 → --vu-count 21
Duration: 60 + 120 = 180 s = 3 min → --duration 3
Profile: ramp-up (one ramp then a hold; the ramp/hold split is fixed by the profile, not 1:2)
```

## Throttle (`throttle:*`) and max duration
- `throttle(reachRps(r).in(t), holdFor(h))`: there's no RPS cap. **Gap**, and say that Postman won't hold throughput at r. The user can lower `--vu-count` to get near it.
- `maxDuration(d)`: `--duration` is already a hard stop. Mapped to `run:--duration` if d ≥ the computed duration. Otherwise use d, and approximate.

## Assertions (`assert:*`)
The CLI takes **at most one** `--pass-if`. Pick it by this **strict priority — this overrides the order the assertions appear in the source**:
1. a global error-rate assertion (`failedRequests`/`successfulRequests` → `error_rate`)
2. a global latency percentile (`p95`, then `p99`, then `p90`)
3. a global `mean` (`avg`) or `requestsPerSec` (`rps`)

Walk the list top-down and take the **first category that a source assertion matches**, even if a different assertion came first in the source. Example: a simulation with `responseTime().percentile(95).lt(800)` **and** `failedRequests().percent().lt(1)` → the `--pass-if` is `less_than(error_rate, 1)` (category 1 wins), and the p95 assertion is the **gap**, not the other way round.

All non-chosen assertions are **gap**, reason "the CLI takes one pass condition". Suggest adding them as run criteria in the app, where several aggregate checks are allowed.

**If no source assertion matches any category** (e.g. only `forAll`/`details(...)` per-request assertions, or only `responseTime().max()` which has no CLI metric), emit **no `--pass-if` flag at all** — this is correct and expected, not a defect. Record every assertion as a gap and tell the user to add run criteria in the app. `verify.py` passes a `run.sh` with zero `--pass-if`.
| Gatling | `--pass-if` | Notes |
|---|---|---|
| `global().failedRequests().percent().lt(x)` | `less_than(error_rate, x)` | mapped |
| `global().failedRequests().count().is(0)` | `less_than_eq(error_rate, 0)` | approximated (percentage instead of count) |
| `global().successfulRequests().percent().gt(x)` | `less_than(error_rate, 100 - x)` | mapped |
| `global().responseTime().percentile(95).lt(ms)` (Scala `percentile3`) | `less_than(p95, ms)` | mapped (also p90, p99. Other percentiles → the nearest, approximated) |
| `global().responseTime().mean().lt(ms)` | `less_than(avg, ms)` | mapped |
| `global().responseTime().max()` / `min()` / `stdDev()` | none | gap |
| `global().requestsPerSec().gt(r)` | `greater_than(rps, r)` | mapped |
| `forAll…` / `details("group", "req")…` | none (no per-request criteria) | gap |
| `lte` / `gte` | `less_than_eq` / `greater_than_eq` | — |
