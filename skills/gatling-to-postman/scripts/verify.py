#!/usr/bin/env python3
"""Verify a Gatling → Postman conversion. Exits non-zero on any hard failure.

Usage: verify.py <out-dir> [--inventory <out-dir>/inventory.json] [--no-smoke]

Expected files in <out-dir> (written by the skill):
	collection.json    Postman collection v2.1
	environment.json   Postman environment (secrets as empty placeholders)
	data/*.csv         optional iteration data
	run.sh             the `postman performance run …` command(s)
	MIGRATION.md       gap report
	manifest.json      every inventory id → where it landed, or a gap entry

Manifest shape:
	{
	  "items": { "<inventory id>": {"status": "mapped|approximated|gap",
	                                "target": "collection:<folder>/<request>[ › <detail>]"
	                                          | "run:<flag>" | "environment:<key>" | "data:<path>" | "collection-variable:<key>",
	                                "note": "…"} },
	  "found_by_model": [ {"id": "…", "kind": "…", "status": "…", "target": "…", "note": "…"} ],
	  "run": {"data_file": "data/x.csv" | null}
	}

Checks (H = hard failure, S = reported only):
	H accounting     every inventory id has a manifest entry; gaps and approximations are named in MIGRATION.md
	H targets        collection:/run:/environment:/data: targets resolve to something that exists
	H collection     valid v2.1 structure, stamped `imported-from: gatling`
	H variables      every {{var}} is defined (environment, collection variables, data columns, set by a script, or dynamic)
	H secrets        no inventory secret literal and no credential-looking string in any output
	H run.sh         `postman performance run` flags exist in this CLI version, values are valid, at most one --pass-if
	H smoke          `postman collection run` for 1 iteration executes every request without a transport error
	S smoke-tests    pm.test failures (these can come from the target, not the conversion)
"""

import argparse
import csv
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys

VALID_STATUS = {"mapped", "approximated", "gap"}
PROFILES = {"fixed", "ramp-up", "spike", "peak"}
RUNNERS = {"local", "postman-cloud", "postman-cloud-static-ip"}
PASS_IF_RE = re.compile(r"^(less_than|greater_than|less_than_eq|greater_than_eq)\(\s*(avg|p90|p95|p99|error_rate|rps)\s*,\s*\d+(\.\d+)?\s*\)$")
FALLBACK_FLAGS = {"-e", "--environment", "-g", "--globals", "--setup-collection", "--teardown-collection", "--vu-count", "-d", "--duration",
                  "-p", "--load-profile", "--data-file", "--dataset-id", "--dataset-view-id", "--dataset-distribution", "--postman-api-key",
                  "--output", "--runner", "--pass-if", "--use-mock", "-h", "--help"}
SECRET_RES = [
    re.compile(r"\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{8,}"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\b(ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{20,}"),
    re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}"),
    re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}"),
    re.compile(r"(?i)\b(bearer|basic)\s+(?!\{\{)[A-Za-z0-9._~+/=-]{16,}"),
]
VAR_RE = re.compile(r"\{\{\s*([^{}\s]+)\s*\}\}")
SET_RE = re.compile(r"pm\.(?:collectionVariables|environment|variables|globals|iterationData)\.set\(\s*['\"`]([^'\"`]+)['\"`]")


class Report:
    def __init__(self):
        self.rows = []

    def add(self, check, ok, hard, msg):
        self.rows.append({"check": check, "ok": ok, "hard": hard, "message": msg})

    @property
    def failed(self):
        return any(not r["ok"] and r["hard"] for r in self.rows)

    def print(self):
        for r in self.rows:
            mark = "PASS" if r["ok"] else ("FAIL" if r["hard"] else "WARN")
            print(f"[{mark}] {r['check']:<13} {r['message']}")


def load_json(path, report, check):
    try:
        return json.load(open(path))
    except FileNotFoundError:
        report.add(check, False, True, f"missing {os.path.basename(path)}")
    except json.JSONDecodeError as e:
        report.add(check, False, True, f"{os.path.basename(path)} is not valid JSON: {e}")
    return None


def walk_requests(items, prefix=""):
    """Yield (path, item) for every request leaf; path is folder/…/request name."""
    for it in items or []:
        path = f"{prefix}/{it.get('name', '')}" if prefix else it.get("name", "")
        if "item" in it:
            yield from walk_requests(it["item"], path)
        else:
            yield path, it


def scripts_of(item):
    out = []
    for ev in item.get("event", []) or []:
        ex = (ev.get("script") or {}).get("exec", [])
        out.append("\n".join(ex) if isinstance(ex, list) else str(ex))
    return "\n".join(out)


def check_collection(col, report):
    ok = True
    schema = (col.get("info") or {}).get("schema", "")
    if "v2.1.0" not in schema:
        report.add("collection", False, True, f"info.schema is not v2.1.0 ({schema or 'missing'})")
        ok = False
    desc = (col.get("info") or {}).get("description", "")
    desc = desc.get("content", "") if isinstance(desc, dict) else desc
    if "imported-from: gatling" not in (desc or ""):
        report.add("collection", False, True, "info.description is not stamped `imported-from: gatling`")
        ok = False
    leaves = list(walk_requests(col.get("item")))
    bad = [p for p, it in leaves if not isinstance(it.get("request"), dict) or not it["request"].get("method") or not it["request"].get("url")]
    if not leaves:
        report.add("collection", False, True, "collection has no requests")
        ok = False
    if bad:
        report.add("collection", False, True, f"requests missing method/url: {bad}")
        ok = False
    dupes = sorted({p for p, _ in leaves if [q for q, _ in leaves].count(p) > 1})
    if dupes:
        report.add("collection", False, True, f"duplicate request paths (targets would be ambiguous): {dupes}")
        ok = False
    if ok:
        report.add("collection", True, True, f"v2.1, stamped, {len(leaves)} requests")
    return leaves


def check_accounting(inv, manifest, migration_md, report):
    items = manifest.get("items") or {}
    missing = [i["id"] for i in inv["items"] if i["id"] not in items]
    bad_status = [k for k, v in items.items() if v.get("status") not in VALID_STATUS]
    no_target = [k for k, v in items.items() if v.get("status") in ("mapped", "approximated") and not v.get("target")]
    not_in_report = [k for k, v in items.items() if v.get("status") in ("approximated", "gap") and k not in migration_md]
    fbm = manifest.get("found_by_model") or []
    fbm_missing = [f.get("id") for f in fbm if f.get("status") in ("approximated", "gap") and f.get("id") not in migration_md]
    problems = []
    if missing:
        problems.append(f"{len(missing)} inventory ids have no manifest entry: {missing}")
    if bad_status:
        problems.append(f"invalid status on: {bad_status}")
    if no_target:
        problems.append(f"mapped/approximated without target: {no_target}")
    if not_in_report or fbm_missing:
        problems.append(f"gap/approximated ids not named in MIGRATION.md: {not_in_report + fbm_missing}")
    counts = {}
    for v in list(items.values()) + fbm:
        counts[v.get("status")] = counts.get(v.get("status"), 0) + 1
    summary = ", ".join(f"{k}={v}" for k, v in sorted(counts.items(), key=lambda x: str(x[0])))
    if problems:
        for p in problems:
            report.add("accounting", False, True, p)
    else:
        report.add("accounting", True, True, f"{len(inv['items'])}/{len(inv['items'])} inventory ids accounted for ({summary}); found-by-model: {len(fbm)}")
    return counts


def check_targets(manifest, leaves, env_keys, col_var_keys, run_text, out_dir, report):
    paths = {p for p, _ in leaves}
    bad = []
    entries = list((manifest.get("items") or {}).items()) + [(f.get("id"), f) for f in manifest.get("found_by_model") or []]
    for key, v in entries:
        t = v.get("target")
        if not t or v.get("status") == "gap":
            continue
        for part in [x.strip() for x in t.split(";")]:
            kind, sep, rest = part.partition(":")
            rest = rest.strip()
            # A note's free text may contain the ';' target separator; the trailing
            # fragment then has no "kind:" colon of its own — treat it as note
            # continuation, not an unknown target. A real typo (has a colon) still fails.
            if not sep:
                continue
            if kind == "collection":
                req = rest.split(" › ")[0].strip()
                if req and req not in paths and not any(p.startswith(req + "/") for p in paths):
                    bad.append(f"{key} → {part} (no such request/folder)")
            elif kind == "run":
                flag = rest.split()[0] if rest else ""
                if flag and flag not in run_text:
                    bad.append(f"{key} → {part} (flag not in run.sh)")
            elif kind == "environment":
                if rest not in env_keys:
                    bad.append(f"{key} → {part} (no such environment key)")
            elif kind == "collection-variable":
                if rest not in col_var_keys:
                    bad.append(f"{key} → {part} (no such collection variable)")
            elif kind == "data":
                if not os.path.exists(os.path.join(out_dir, rest)):
                    bad.append(f"{key} → {part} (file not found)")
            elif kind in ("note", "gap-report"):
                pass
            else:
                bad.append(f"{key} → {part} (unknown target kind '{kind}')")
    if bad:
        report.add("targets", False, True, f"{len(bad)} unresolvable targets: {bad}")
    else:
        report.add("targets", True, True, "all targets resolve")


def check_variables(col, leaves, env_keys, col_var_keys, data_cols, report):
    text = json.dumps(col)
    used = {v for v in VAR_RE.findall(text) if not v.startswith("$")}
    set_by_script = set(SET_RE.findall(text))
    defined = env_keys | col_var_keys | data_cols | set_by_script
    undefined = sorted(used - defined)
    if undefined:
        report.add("variables", False, True, f"undefined variables {undefined} (not in environment, collection variables, data columns, or set by a script)")
    else:
        report.add("variables", True, True, f"{len(used)} variables used, all defined")


def check_secrets(inv, out_dir, report):
    hashes = {(i["details"]["sha256"], i["details"]["length"]) for i in inv["items"] if i["kind"] == "secret"}
    hits = []
    for dirpath, dirnames, filenames in os.walk(out_dir):
        dirnames[:] = [d for d in dirnames if d != ".verify"]
        for f in filenames:
            if f == "inventory.json":
                continue
            p = os.path.join(dirpath, f)
            try:
                text = open(p, encoding="utf-8", errors="replace").read()
            except OSError:
                continue
            rel = os.path.relpath(p, out_dir)
            for rx in SECRET_RES:
                for m in rx.finditer(text):
                    hits.append(f"{rel}: credential-looking string ({m.group(0)[:6]}…)")
            for sha, n in hashes:
                for k in range(0, max(0, len(text) - n + 1)):
                    if hashlib.sha256(text[k:k + n].encode()).hexdigest() == sha:
                        hits.append(f"{rel}: contains an inventory secret literal at offset {k}")
                        break
    if hits:
        report.add("secrets", False, True, f"{len(hits)} findings: {hits}")
    else:
        report.add("secrets", True, True, f"clean (checked {len(hashes)} inventory secret(s) + credential patterns)")


def cli_flags():
    try:
        out = subprocess.run(["postman", "performance", "run", "--help"], capture_output=True, text=True, timeout=30).stdout
        flags = set(re.findall(r"(?<![\w-])(--[a-z][a-z-]+|-[a-z])\b", out))
        return (flags or FALLBACK_FLAGS), bool(flags)
    except (OSError, subprocess.SubprocessError):
        return FALLBACK_FLAGS, False


def check_run_sh(out_dir, report):
    path = os.path.join(out_dir, "run.sh")
    if not os.path.exists(path):
        report.add("run.sh", False, True, "missing run.sh")
        return ""
    raw = open(path).read()
    joined = re.sub(r"\\\n", " ", raw)
    cmds = [l for l in joined.splitlines() if re.search(r"\bpostman\s+performance\s+run\b", l) and not l.strip().startswith("#")]
    if not cmds:
        report.add("run.sh", False, True, "no `postman performance run` command")
        return raw
    flags, live = cli_flags()
    problems = []
    for c in cmds:
        try:
            toks = shlex.split(c[c.index("postman"):], posix=True)
        except ValueError as e:
            problems.append(f"cannot parse: {e}")
            continue
        args = toks[3:]
        pass_ifs = 0
        i = 0
        positional = []
        while i < len(args):
            a = args[i]
            if a.startswith("-"):
                name, eq, val = a.partition("=")
                if name not in flags:
                    problems.append(f"unknown flag {name}")
                if not eq and i + 1 < len(args) and not args[i + 1].startswith("--"):
                    val = args[i + 1]
                    i += 1
                if name in ("-p", "--load-profile") and val not in PROFILES:
                    problems.append(f"load profile '{val}' not in {sorted(PROFILES)}")
                if name == "--runner" and val not in RUNNERS:
                    problems.append(f"runner '{val}' not in {sorted(RUNNERS)}")
                if name == "--vu-count" and not (val.isdigit() and int(val) >= 1):
                    problems.append(f"--vu-count '{val}' is not a positive integer")
                if name in ("-d", "--duration") and not (val.isdigit() and int(val) >= 1):
                    problems.append(f"--duration '{val}' is not a whole number of minutes ≥ 1")
                if name == "--pass-if":
                    pass_ifs += 1
                    if not PASS_IF_RE.match(val):
                        problems.append(f"--pass-if '{val}' does not match function(metric, value)")
                if name == "--data-file" and not os.path.exists(os.path.join(out_dir, val)):
                    problems.append(f"--data-file '{val}' not found relative to out dir")
            else:
                positional.append(a)
            i += 1
        if pass_ifs > 1:
            problems.append(f"{pass_ifs} --pass-if flags; the CLI takes one condition")
        if not positional:
            problems.append("no collection id argument")
    src = "live `--help`" if live else "fallback flag list"
    if problems:
        report.add("run.sh", False, True, f"{problems} (flags checked against {src})")
    else:
        report.add("run.sh", True, True, f"{len(cmds)} command(s) valid (flags checked against {src})")
    return raw


def smoke(out_dir, manifest, leaves, report):
    vdir = os.path.join(out_dir, ".verify")
    os.makedirs(vdir, exist_ok=True)
    rep = os.path.join(vdir, "smoke.json")
    cmd = ["postman", "collection", "run", os.path.join(out_dir, "collection.json"), "-n", "1", "-r", "json", "--reporter-json-export", rep]
    if os.path.exists(os.path.join(out_dir, "environment.json")):
        cmd += ["-e", os.path.join(out_dir, "environment.json")]
    data = (manifest.get("run") or {}).get("data_file")
    if data:
        cmd += ["-d", os.path.join(out_dir, data)]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    except (OSError, subprocess.SubprocessError) as e:
        report.add("smoke", False, True, f"could not run postman CLI: {e}")
        return
    open(os.path.join(vdir, "smoke.log"), "w").write(proc.stdout + proc.stderr)
    try:
        run = json.load(open(rep))["run"]
    except (OSError, ValueError, KeyError):
        report.add("smoke", False, True, f"no JSON report (exit {proc.returncode}); see .verify/smoke.log")
        return
    execs = run.get("executions") or []
    transport = [e["requestExecuted"]["name"] for e in execs if e.get("errors") or not e.get("response")]
    executed = {e["requestExecuted"]["name"] for e in execs}
    expected = {p.split("/")[-1] for p, _ in leaves}
    not_run = sorted(expected - executed)
    if run.get("runError") or transport:
        report.add("smoke", False, True, f"runError={run.get('runError')} transport errors on {transport}")
    elif not_run:
        report.add("smoke", False, True, f"requests never executed in 1 iteration: {not_run} (skipped by flow control? say so in MIGRATION.md and the manifest)")
    else:
        codes = {}
        for e in execs:
            codes[e["response"].get("code")] = codes.get(e["response"].get("code"), 0) + 1
        report.add("smoke", True, True, f"{len(execs)} executions, all requests ran, status codes {codes}")
    failed = [f"{e['requestExecuted']['name']} › {t['name']}" for e in execs for t in e.get("tests") or [] if t.get("status") == "failed"]
    total = sum(len(e.get("tests") or []) for e in execs)
    report.add("smoke-tests", not failed, False, f"{total - len(failed)}/{total} tests passed" + (f"; failed: {failed}" if failed else ""))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("out_dir")
    ap.add_argument("--inventory")
    ap.add_argument("--no-smoke", action="store_true", help="skip the network run")
    args = ap.parse_args()
    out = os.path.abspath(args.out_dir)
    report = Report()

    inv = load_json(args.inventory or os.path.join(out, "inventory.json"), report, "inventory")
    manifest = load_json(os.path.join(out, "manifest.json"), report, "manifest")
    col = load_json(os.path.join(out, "collection.json"), report, "collection")
    env = load_json(os.path.join(out, "environment.json"), report, "environment") if os.path.exists(os.path.join(out, "environment.json")) else {"values": []}
    md_path = os.path.join(out, "MIGRATION.md")
    migration_md = open(md_path).read() if os.path.exists(md_path) else ""
    if not migration_md:
        report.add("gap-report", False, True, "missing or empty MIGRATION.md")

    if inv and manifest and col is not None:
        env_keys = {v.get("key") for v in (env or {}).get("values", []) if v.get("enabled", True)}
        col_var_keys = {v.get("key") for v in col.get("variable", []) or []}
        data_cols = set()
        data = (manifest.get("run") or {}).get("data_file")
        if data and os.path.exists(os.path.join(out, data)):
            with open(os.path.join(out, data), newline="") as fh:
                data_cols = set(next(csv.reader(fh), []))
        leaves = check_collection(col, report)
        run_text = check_run_sh(out, report)
        check_accounting(inv, manifest, migration_md, report)
        check_targets(manifest, leaves, env_keys, col_var_keys, run_text, out, report)
        check_variables(col, leaves, env_keys, col_var_keys, data_cols, report)
        check_secrets(inv, out, report)
        if not args.no_smoke:
            smoke(out, manifest, leaves, report)

    report.print()
    os.makedirs(os.path.join(out, ".verify"), exist_ok=True)
    json.dump({"ok": not report.failed, "checks": report.rows}, open(os.path.join(out, ".verify", "verify.json"), "w"), indent=2)
    print("RESULT:", "FAIL" if report.failed else "PASS")
    sys.exit(1 if report.failed else 0)


if __name__ == "__main__":
    main()
