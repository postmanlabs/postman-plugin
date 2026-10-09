"""Deterministic ReadyAPI LoadTest -> Postman performance-run config.

A ReadyAPI `<con:loadTest>` lives inside a `<con:testCase>` and drives that
case's steps under load. Postman performance runs are VU- and duration-driven
with four fixed load shapes (fixed / ramp-up / spike / peak) and a single
`--pass-if` condition, so this mapping is lossy BY NECESSITY. The rule mirrors
the JMeter converter's: carry everything with a faithful slot, and for the rest
emit an explicit note rather than invent a Postman feature. The notes ARE the
honesty of the migration.

Output run shape matches the JMeter skill's perf IR so the two skills share a
report/CLI format:
    {name, vus, duration_min, load_profile, duration_note, source_kind, notes[]}

`--pass-if` is single and non-repeatable (verified against the CLI). We pick the
most load-relevant LoadTest assertion for it (response-time SLA > throughput >
error rate) and leave the rest as notes.
"""
import math

SUPPORTED_PROFILES = ("fixed", "ramp-up", "spike", "peak")
DEFAULT_VUS = 20            # postman CLI default
DEFAULT_DURATION_SEC = 60   # used only when ReadyAPI gives no time limit


def _minutes(seconds):
    """Seconds -> whole minutes, min 1 (the CLI --duration floor)."""
    return max(1, int(math.ceil((seconds or 0) / 60.0)))


def map_strategy(strategy, thread_count, duration_sec, notes):
    """ReadyAPI load strategy -> (load_profile, peak_vus)."""
    stype = (strategy or {}).get("type", "Simple").strip()
    cfg = (strategy or {}).get("config", {}) or {}
    base_vus = thread_count or DEFAULT_VUS

    if stype == "Simple":
        if cfg.get("testDelay"):
            rf = cfg.get("randomFactor")
            notes.append(
                "Simple strategy think-time (testDelay=%sms%s) has no perf-config "
                "equivalent; add a per-request delay in the collection if pacing matters."
                % (cfg["testDelay"], (", randomFactor=%s" % rf) if rf else "")
            )
        return "fixed", base_vus

    if stype == "Thread":
        end = cfg.get("endThreadCount") or base_vus
        start = cfg.get("startThreadCount")
        if start is None:
            start = max(1, int(end * 0.25))
        if start > end:
            notes.append(
                "Thread strategy ramps DOWN (%s->%s); Postman ramp-up only ramps up. "
                "Mapped to peak VUs with a full-duration ramp." % (start, end)
            )
        return "ramp-up", max(start, end)

    if stype == "Burst":
        notes.append(
            "Burst strategy (bursts with idle gaps) has no exact equivalent; mapped "
            "to the spike profile. Idle-gap timing is not preserved."
        )
        return "spike", base_vus

    if stype == "Variance":
        notes.append(
            "Variance strategy (sawtooth load) has no exact equivalent; mapped to the "
            "spike profile as an approximation. Oscillation period/amplitude is lost."
        )
        return "spike", base_vus

    if stype in ("Fixed Rate", "FixedRate"):
        notes.append(
            "Fixed Rate strategy targets throughput (rate=%s req/s), but Postman perf "
            "is concurrency-driven, not rate-driven. Mapped to a fixed VU count; tune "
            "VUs to hit the target throughput." % cfg.get("rate", "n/a")
        )
        return "fixed", base_vus

    if stype in ("Grid", "Script"):
        notes.append(
            "%s strategy uses an arbitrary/programmatic thread schedule with no "
            "perf-config equivalent. Mapped to a fixed VU count at the base thread "
            "count." % stype
        )
        return "fixed", base_vus

    notes.append('Unknown load strategy "%s" mapped to a fixed VU count.' % stype)
    return "fixed", base_vus


def map_duration(load_test, notes):
    """LoadTest run-length -> duration in seconds, with a note when inexact."""
    limit_type = (load_test.get("limitType") or "TIME").upper()
    test_limit = load_test.get("testLimit")
    if limit_type == "TIME" and test_limit:
        return test_limit, "from ReadyAPI testLimit %ss (TIME)" % test_limit
    if limit_type in ("COUNT", "RUNPERTHREAD") and test_limit:
        notes.append(
            "Run length was a run COUNT (%s), which Postman perf cannot express "
            "(it is duration-based). Defaulted to %ss." % (test_limit, DEFAULT_DURATION_SEC)
        )
        return DEFAULT_DURATION_SEC, "approximated from run COUNT %s" % test_limit
    notes.append(
        "LoadTest had no time limit (runs until stopped); defaulted to %ss."
        % DEFAULT_DURATION_SEC
    )
    return DEFAULT_DURATION_SEC, "defaulted (no ReadyAPI limit)"


def _pass_if_from_assertions(assertions, notes):
    """Pick ONE --pass-if condition; note the rest. Returns (pass_if, suggested)."""
    chosen = None
    for a in assertions or []:
        atype = (a.get("type") or "").strip()
        if atype == "Step Average":
            ms = a.get("maxValue") or a.get("value") or a.get("limit")
            if ms is not None and chosen is None:
                chosen = "avg(less_than, %s)" % ms
            elif ms is None:
                notes.append("Step Average assertion found but its ms limit was not readable.")
        elif atype == "Step Maximum":
            ms = a.get("maxValue") or a.get("value") or a.get("limit")
            notes.append(
                "Step Maximum (worst-case response time%s) has no absolute-max perf "
                "assertion; closest is p99 via --pass-if." % (" %sms" % ms if ms else "")
            )
        elif atype == "Step TPS":
            tps = a.get("minValue") or a.get("value") or a.get("limit")
            if tps is not None and chosen is None:
                chosen = "rps(greater_than, %s)" % tps
            elif tps is None:
                notes.append("Step TPS assertion found but its value was not readable.")
        elif atype == "Max Relative Errors":
            frac = a.get("maxRelative") or a.get("value")
            if frac is not None and chosen is None:
                pct = frac * 100 if frac <= 1 else frac
                chosen = "error_rate(less_than, %s)" % pct
        elif atype == "Max Absolute Errors":
            notes.append(
                "Max Absolute Errors assertion (%s) has no perf slot (Postman thresholds "
                "are rates, not counts); surface via the run report." % a.get("maxAbsolute", "n/a")
            )
        elif atype == "Step Status":
            notes.append(
                "Step Status assertion -> add status checks as pm.test in the collection; "
                "there is no run-level status gate beyond error_rate."
            )
        elif atype:
            notes.append('LoadTest assertion "%s" has no perf-config equivalent; dropped.' % atype)

    if len(assertions or []) > 1 and chosen is not None:
        notes.append(
            "Multiple LoadTest assertions, but --pass-if is single & non-repeatable; "
            "used %s and left the rest as notes." % chosen
        )
    suggested = chosen or "error_rate(less_than, 5)"
    return chosen, suggested


def map_load_test(load_test, source_name=""):
    """Map one LoadTest intermediate -> a perf run dict + its chosen/suggested pass-if.

    `load_test` shape (from the XML parser):
        {name, testCaseName, disabled, threadCount, startDelay, limitType,
         testLimit, maxAssertionErrors, strategy:{type, config:{...}},
         assertions:[{type, name, maxValue, minValue, value, limit,
                      maxAbsolute, maxRelative}]}
    """
    notes = []
    duration_sec, duration_note = map_duration(load_test, notes)
    profile, peak_vus = map_strategy(load_test.get("strategy"), load_test.get("threadCount"),
                                     duration_sec, notes)
    if load_test.get("startDelay"):
        notes.append("startDelay=%sms before threads start has no perf equivalent; dropped."
                     % load_test["startDelay"])
    pass_if, suggested = _pass_if_from_assertions(load_test.get("assertions"), notes)

    run = {
        "name": load_test.get("name") or ("%s LoadTest" % (source_name or "TestCase")),
        "source_test_case": load_test.get("testCaseName") or source_name,
        "vus": peak_vus,
        "duration_min": _minutes(duration_sec),
        "duration_sec": duration_sec,
        "load_profile": profile if profile in SUPPORTED_PROFILES else "fixed",
        "duration_note": duration_note,
        "source_kind": "loadtest",
        "notes": notes,
    }
    return run, pass_if, suggested


def build_perf(load_tests):
    """Map every LoadTest -> the perf IR used by the report/CLI.

    `load_tests` is a flat list of load-test intermediates (one project may hold
    several across its cases). Returns the perf.json-shaped dict.
    """
    runs = []
    pass_if = None
    suggested = "error_rate(less_than, 5)"
    top_notes = []
    for lt in load_tests:
        if lt.get("disabled"):
            continue
        run, pif, sug = map_load_test(lt, lt.get("testCaseName", ""))
        runs.append(run)
        if pass_if is None and pif is not None:
            pass_if = pif
        suggested = sug
    if len(runs) > 1:
        top_notes.append(
            "%d LoadTests found. A performance run executes ONE collection, so each "
            "LoadTest is a separate `postman performance run` (they cannot run "
            "concurrently in one run)." % len(runs)
        )
    return {
        "runs": runs,
        "pass_if": pass_if,
        "pass_if_suggested": suggested,
        "data_files": [],
        "notes": top_notes,
    }


def cli_command(run, pass_if, collection_uid="<COLLECTION_UID>", environment_uid=None):
    """Render the ready-to-run `postman performance run` command for one run."""
    parts = [
        "postman performance run", collection_uid,
        "--vu-count %s" % run["vus"],
        "--duration %s" % run["duration_min"],
        "--load-profile %s" % run["load_profile"],
    ]
    if environment_uid:
        parts.append("--environment %s" % environment_uid)
    if pass_if:
        parts.append('--pass-if "%s"' % pass_if)
    return " ".join(parts)
