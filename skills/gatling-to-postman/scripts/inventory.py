#!/usr/bin/env python3
"""Inventory a Gatling project: list every construct a conversion must account for.

Usage: inventory.py <project-dir> [-o inventory.json]

Gatling's DSL uses the same method names in Java, Kotlin, Scala and JS/TS, so a
string-aware regex pass is enough to build a checklist. This is NOT a parser:
requests built dynamically (loops over lists, helper methods that take the
request name as a parameter) can be missed. The skill adds those as
`found-by-model` items.

Every item gets a stable id. The converter must map each id to an output
location or to a gap-report entry, and verify.py enforces that.

Secrets: literal values are never written to the inventory, only a sha256 and
length, so verify.py can detect the literal in outputs without storing it.
"""

import argparse
import hashlib
import json
import os
import re
import sys

SOURCE_EXTS = {".java": "java", ".kt": "kotlin", ".scala": "scala", ".ts": "typescript", ".js": "javascript", ".mjs": "javascript"}
SKIP_DIRS = {"target", "build", "node_modules", ".git", ".gradle", ".idea", ".bsp", "project", "out", ".verify"}
DATA_EXTS = {".csv", ".tsv", ".ssv", ".json"}

Q = r'''("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')'''  # one string literal, double or single quoted


# ---------------------------------------------------------------- lexing helpers

def strip_comments(src):
    """Blank out // and /* */ comments, keeping string literals and offsets intact."""
    out = list(src)
    i, n = 0, len(src)
    while i < n:
        c = src[i]
        if src.startswith('"""', i):
            i = skip_string(src, i)
        elif c in "\"'`":
            i = skip_string(src, i)
        elif src.startswith("//", i):
            j = src.find("\n", i)
            j = n if j < 0 else j
            for k in range(i, j):
                out[k] = " "
            i = j
        elif src.startswith("/*", i):
            j = src.find("*/", i + 2)
            j = n if j < 0 else j + 2
            for k in range(i, j):
                if out[k] != "\n":
                    out[k] = " "
            i = j
        else:
            i += 1
    return "".join(out)


def skip_string(src, i):
    """Return the index just past the string literal starting at i."""
    if src.startswith('"""', i):
        j = src.find('"""', i + 3)
        if j < 0:
            return len(src)
        # A run of 4+ quotes (e.g. a regex literal whose content ends in `"`,
        # written `""""..(\d+)""""`) closes at the LAST quote of the run, not the
        # first triple — otherwise the string under-runs and the chain over-captures.
        j += 3
        while j < len(src) and src[j] == '"':
            j += 1
        return j
    quote = src[i]
    j = i + 1
    while j < len(src):
        if src[j] == "\\":
            j += 2
            continue
        if src[j] == quote:
            return j + 1
        if src[j] == "\n" and quote != "`":
            return j  # unterminated; stop at end of line
        j += 1
    return j


def read_balanced(src, i):
    """src[i] is an opening bracket. Return the index just past its match."""
    pairs = {"(": ")", "{": "}", "[": "]"}
    stack = [pairs[src[i]]]
    j = i + 1
    while j < len(src) and stack:
        c = src[j]
        if c in "\"'`":
            j = skip_string(src, j)
            continue
        if c in pairs:
            stack.append(pairs[c])
        elif c == stack[-1]:
            stack.pop()
        j += 1
    return j


IDENT = re.compile(r"[A-Za-z_$][\w$]*")


def take_chain(src, i):
    """Read ident(args)?(.ident(args)?)* starting at i. Return (end, [(method, args_text)])."""
    calls = []
    m = IDENT.match(src, i)
    if not m:
        return i, calls
    j = m.end()
    name = m.group(0)
    k = skip_ws(src, j)
    args = None
    if k < len(src) and src[k] == "(":
        e = read_balanced(src, k)
        args, j = src[k + 1:e - 1], e
    calls.append((name, args))
    while True:
        k = skip_ws(src, j)
        if k < len(src) and src[k] == "." and not src.startswith("..", k):
            m = IDENT.match(src, skip_ws(src, k + 1))
            if not m:
                break
            name, j = m.group(0), m.end()
            k2 = skip_ws(src, j)
            args = None
            if k2 < len(src) and src[k2] == "(":
                e = read_balanced(src, k2)
                args, j = src[k2 + 1:e - 1], e
            calls.append((name, args))
        else:
            break
    return j, calls


def skip_ws(src, i):
    while i < len(src) and src[i] in " \t\r\n":
        i += 1
    return i


def split_top_level(args):
    """Split an argument list on top-level commas."""
    parts, depth, cur, i = [], 0, [], 0
    while i < len(args):
        c = args[i]
        if c in "\"'`":
            j = skip_string(args, i)
            cur.append(args[i:j])
            i = j
            continue
        if c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
        if c == "," and depth == 0:
            parts.append("".join(cur).strip())
            cur = []
        else:
            cur.append(c)
        i += 1
    if "".join(cur).strip():
        parts.append("".join(cur).strip())
    return parts


def unquote(lit):
    if lit and lit[0] in "\"'" and lit[-1] == lit[0]:
        return lit[1:-1]
    return lit


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-") or "x"


def line_of(src, pos):
    return src.count("\n", 0, pos) + 1


def compact(s, limit=240):
    s = re.sub(r"\s+", " ", s).strip()
    return s if len(s) <= limit else s[:limit - 1] + "…"


# ---------------------------------------------------------------- inventory

class Inventory:
    def __init__(self, root):
        self.root = root
        self.items = []
        self.ids = set()
        self.counters = {}
        self.el_vars = set()
        self.simulations = []
        self.languages = set()
        self.data_files = []

    def new_id(self, base):
        if base not in self.ids:
            self.ids.add(base)
            return base
        n = 2
        while f"{base}#{n}" in self.ids:
            n += 1
        self.ids.add(f"{base}#{n}")
        return f"{base}#{n}"

    def seq_id(self, prefix):
        self.counters[prefix] = self.counters.get(prefix, 0) + 1
        return self.new_id(f"{prefix}#{self.counters[prefix]}")

    def add(self, id_, kind, file, src, pos, text, **details):
        self.items.append({
            "id": id_,
            "kind": kind,
            "file": os.path.relpath(file, self.root),
            "line": line_of(src, pos),
            "text": compact(text),
            **({"details": details} if details else {}),
        })


REQ_RE = re.compile(r"\bhttp\s*\(\s*" + Q + r"\s*\)\s*\.\s*(get|post|put|patch|delete|head|options|httpRequest)\s*\(")
NONHTTP_RE = re.compile(r"\b(ws|sse|grpc|mqtt|jms|kafka|amqp)\s*\(\s*" + Q)
SCENARIO_RE = re.compile(r"\bscenario\s*\(\s*" + Q + r"\s*\)")
GROUP_RE = re.compile(r"\bgroup\s*\(\s*" + Q + r"\s*\)")
FEEDER_RE = re.compile(r"\b(csv|tsv|ssv|separatedValues|jsonFile|jsonUrl|jdbcFeeder|redisFeeder|listFeeder|arrayFeeder|sitemap)\s*\(")
FEED_RE = re.compile(r"\bfeed\s*\(")
PAUSE_RE = re.compile(r"\b(pause|pace|rendezVous)\s*\(")
FLOW_CALL_RE = re.compile(r"\b(repeat|during|forever|asLongAs|asLongAsDuring|doWhile|doWhileDuring|foreach|doIf|doIfEquals|doIfOrElse|doIfEqualsOrElse|doSwitch|doSwitchOrElse|randomSwitch|randomSwitchOrElse|uniformRandomSwitch|roundRobinSwitch|tryMax|exitBlockOnFail|stopLoadGenerator|stopLoadGeneratorIf|crashLoadGenerator|crashLoadGeneratorIf)\s*(\(|\{)")
FLOW_BARE_RE = re.compile(r"\b(exitHereIfFailed|exitHere)\b")
CODE_RE = re.compile(r"\bexec\s*(?:\(\s*\(?\s*\w+\s*\)?\s*(?:->|=>)|\{\s*\w+\s*->)")
INJ_RE = re.compile(r"\b(nothingFor|atOnceUsers|rampUsers|constantUsersPerSec|rampUsersPerSec|stressPeakUsers|incrementUsersPerSec|constantConcurrentUsers|rampConcurrentUsers|incrementConcurrentUsers)\s*\(")
THROTTLE_RE = re.compile(r"\b(reachRps|jumpToRps|holdFor)\s*\(")
MAXDUR_RE = re.compile(r"\bmaxDuration\s*\(")
ASSERT_RE = re.compile(r"\b(global|forAll|details)\b\s*(\([^()]*\))?\s*\.\s*(responseTime|allRequests|failedRequests|successfulRequests|requestsPerSec)\b")
PROTO_RE = re.compile(r"\bhttp\s*\.\s*(baseUrl|baseUrls|header|headers|acceptHeader|shareConnections|enableHttp2|warmUp)\b")
EL_RE = re.compile(r"#\{([A-Za-z_][\w.]*)(?:\(\))?")
SECRET_PATTERNS = [
    re.compile(r"^(sk|pk|rk)_(live|test)_[A-Za-z0-9]{8,}$"),
    re.compile(r"^AKIA[0-9A-Z]{16}$"),
    re.compile(r"^(ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{20,}$"),
    re.compile(r"^xox[abprs]-[A-Za-z0-9-]{10,}$"),
    re.compile(r"^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}$"),  # JWT
    re.compile(r"^[A-Fa-f0-9]{32,}$"),
    re.compile(r"^(?i:bearer|basic)\s+[A-Za-z0-9._~+/=-]{16,}$"),
]
SECRET_NAME_RE = re.compile(r"(?i)(api[_-]?key|secret|password|passwd|token|auth)\w*\s*(?::\s*\w+\s*)?=\s*" + Q)
INJ_OPEN = {"nothingFor", "atOnceUsers", "rampUsers", "constantUsersPerSec", "rampUsersPerSec", "stressPeakUsers", "incrementUsersPerSec"}
CHECK_KINDS = {"status", "jsonPath", "jmesPath", "regex", "css", "xpath", "header", "headerRegex", "bodyString", "bodyBytes", "bodyLength", "substring", "responseTimeInMillis", "currentLocation", "currentLocationRegex", "md5", "sha1", "form", "jsonpJsonPath", "jsonpJmesPath"}


def scan_file(inv, path):
    raw = open(path, encoding="utf-8", errors="replace").read()
    src = strip_comments(raw)
    lang = SOURCE_EXTS[os.path.splitext(path)[1]]

    is_sim = bool(re.search(r"extends\s+Simulation\b|:\s*Simulation\s*\(\s*\)|\bsimulation\s*\(\s*\(", src))
    uses_gatling = "io.gatling" in src or "@gatling.io" in src
    if not (is_sim or uses_gatling):
        return
    inv.languages.add(lang)
    if is_sim:
        m = re.search(r"class\s+(\w+)", src)
        inv.simulations.append({"file": os.path.relpath(path, inv.root), "class": m.group(1) if m else os.path.basename(path), "language": lang})

    for m in EL_RE.finditer(src):
        inv.el_vars.add(m.group(1))

    # protocol configuration: http.baseUrl(...).header(...)...
    for m in PROTO_RE.finditer(src):
        _, calls = take_chain(src, m.start())
        for name, args in calls[1:]:
            detail = compact(args or "", 160)
            base = f"proto:{slug(name)}"
            if name == "header" and args:
                parts = split_top_level(args)
                base = f"proto:header:{slug(unquote(parts[0]))}"
            inv.add(inv.new_id(base), "protocol_setting", path, src, m.start(), f".{name}({detail})" if args is not None else f".{name}", setting=name, args=detail)

    for m in SCENARIO_RE.finditer(src):
        name = unquote(m.group(1))
        inv.add(inv.new_id(f"scenario:{slug(name)}"), "scenario", path, src, m.start(), m.group(0), name=name)

    for m in GROUP_RE.finditer(src):
        name = unquote(m.group(1))
        inv.add(inv.new_id(f"group:{slug(name)}"), "group", path, src, m.start(), m.group(0), name=name)

    # requests, with their checks. A request's segment runs until the next
    # request, non-HTTP step, or setUp.
    starts = sorted([(m.start(), "req", m) for m in REQ_RE.finditer(src)] +
                    [(m.start(), "nonhttp", m) for m in NONHTTP_RE.finditer(src)] +
                    [(m.start(), "setup", m) for m in re.finditer(r"\bsetUp\s*\(", src)])
    for idx, (pos, kind, m) in enumerate(starts):
        end = starts[idx + 1][0] if idx + 1 < len(starts) else len(src)
        if kind == "nonhttp":
            proto, name = m.group(1), unquote(m.group(2))
            chain_end, calls = take_chain(src, m.start())
            sid = inv.new_id(f"{proto}:{slug(name)}")
            inv.add(sid, "non_http_step", path, src, pos, src[pos:chain_end], protocol=proto, name=name)
            # checks on non-HTTP replies (e.g. ws.checkTextMessage(...).check(regex(...))) are nested
            # inside the chain's arguments, so scan the whole step text for them
            for n, cm in enumerate(re.finditer(r"\.check\s*\(", src[pos:chain_end]), 1):
                a = pos + cm.end() - 1
                expr = src[a + 1:read_balanced(src, a) - 1]
                inv.add(inv.new_id(f"check:{proto}-{sid.split(':', 1)[1]}#{n}"), "check", path, src, a, expr,
                        request=sid, check_type=f"{proto}-reply", conditional=False, save_as=None)
            continue
        if kind != "req":
            continue
        name, method = unquote(m.group(1)), m.group(2)
        chain_end, calls = take_chain(src, m.start())
        seg = src[pos:max(chain_end, pos)]
        rid = inv.new_id(f"req:{slug(name)}")
        url = unquote(split_top_level(calls[1][1] or "")[0]) if len(calls) > 1 and calls[1][1] else ""
        attrs = [c for c, _ in calls[2:] if c not in ("check", "checkIf")]
        inv.add(rid, "request", path, src, pos, compact(seg, 200), name=name, method=method.upper(), url=url, modifiers=sorted(set(attrs)))
        has_status = False
        n = 0
        for cname, cargs in calls[2:]:
            if cname not in ("check", "checkIf") or cargs is None:
                continue
            for expr in split_top_level(cargs):
                ck = IDENT.match(expr)
                ckind = ck.group(0) if ck else "unknown"
                if ckind == "status":
                    has_status = True
                n += 1
                save = re.search(r"\.saveAs\s*\(\s*" + Q, expr)
                inv.add(f"check:{rid[4:]}#{n}", "check", path, src, pos, expr,
                        request=rid, check_type=ckind if ckind in CHECK_KINDS else f"other:{ckind}",
                        conditional=(cname == "checkIf"), save_as=unquote(save.group(1)) if save else None)
                inv.ids.add(f"check:{rid[4:]}#{n}")
        if not has_status:
            inv.add(inv.new_id(f"implicit-status:{rid[4:]}"), "implicit_check", path, src, pos,
                    "Gatling applies an implicit status check (2xx or 304) because no status() check is declared", request=rid)

    for m in FEEDER_RE.finditer(src):
        chain_end, calls = take_chain(src, m.start())
        fname = unquote(split_top_level(calls[0][1] or "")[0]) if calls[0][1] else m.group(1)
        strategy = "queue"
        mods = []
        for c, _ in calls[1:]:
            if c in ("queue", "random", "shuffle", "circular"):
                strategy = c
            elif c in ("shard", "batch", "eager", "unzip", "transform", "readRecords"):
                mods.append(c)
        inv.add(inv.new_id(f"feeder:{slug(os.path.basename(fname))}"), "feeder", path, src, m.start(), src[m.start():chain_end],
                source_type=m.group(1), source=fname, strategy=strategy, strategy_explicit=any(c in ("queue", "random", "shuffle", "circular") for c, _ in calls[1:]), modifiers=mods)

    for m in FEED_RE.finditer(src):
        e = read_balanced(src, src.index("(", m.start()))
        inv.add(inv.seq_id("feed"), "feed", path, src, m.start(), src[m.start():e])

    for m in PAUSE_RE.finditer(src):
        e = read_balanced(src, src.index("(", m.start()))
        inv.add(inv.seq_id(m.group(1).lower()), "timing", path, src, m.start(), src[m.start():e], timing=m.group(1), args=compact(src[m.end():e - 1], 120))

    # spans of injection/throttle chains: `.during(...)` there is a duration, not a loop
    load_spans = [(m.start(), take_chain(src, m.start())[0]) for r in (INJ_RE, THROTTLE_RE) for m in r.finditer(src)]

    for m in FLOW_CALL_RE.finditer(src):
        if any(a <= m.start() < b for a, b in load_spans):
            continue
        br = m.start(2)
        e = read_balanced(src, br)
        head = src[m.start():e]
        has_lambda = bool(re.search(r"(->|=>)", src[br:e])) and m.group(1).startswith(("doIf", "asLongAs", "doWhile", "stopLoad", "crashLoad", "doSwitch"))
        inv.add(inv.seq_id(f"flow:{m.group(1)}"), "flow", path, src, m.start(), head, construct=m.group(1), lambda_condition=has_lambda)
    for m in FLOW_BARE_RE.finditer(src):
        inv.add(inv.seq_id(f"flow:{m.group(1)}"), "flow", path, src, m.start(), m.group(0), construct=m.group(1))

    for m in CODE_RE.finditer(src):
        br = src.find("(", m.start())
        brace = src.find("{", m.start())
        opener = br if 0 <= br < m.end() else brace
        e = read_balanced(src, opener)
        inv.add(inv.seq_id("code"), "custom_code", path, src, m.start(), src[m.start():e])

    for m in INJ_RE.finditer(src):
        chain_end, calls = take_chain(src, m.start())
        step = m.group(1)
        inv.add(inv.seq_id("inj"), "injection", path, src, m.start(), src[m.start():chain_end],
                step=step, model="open" if step in INJ_OPEN else "closed",
                chain=[f"{c}({compact(a or '', 60)})" for c, a in calls])

    for m in THROTTLE_RE.finditer(src):
        chain_end, _ = take_chain(src, m.start())
        inv.add(inv.seq_id("throttle"), "throttle", path, src, m.start(), src[m.start():chain_end], step=m.group(1))

    for m in MAXDUR_RE.finditer(src):
        e = read_balanced(src, src.index("(", m.start()))
        inv.add(inv.new_id("max-duration"), "max_duration", path, src, m.start(), src[m.start():e])

    for m in ASSERT_RE.finditer(src):
        chain_end, calls = take_chain(src, m.start())
        scope = m.group(1)
        target = compact(m.group(2) or "", 100).strip("()") if m.group(2) else None
        inv.add(inv.seq_id("assert"), "assertion", path, src, m.start(), src[m.start():chain_end],
                scope=scope, path=target, chain=[c for c, _ in calls])

    # secrets: string literals that look like credentials, or are assigned to secret-ish names
    seen = set()
    for m in re.finditer(Q, src):
        lit = unquote(m.group(0))
        named = False
        pre = src[max(0, m.start() - 80):m.start()]
        if SECRET_NAME_RE.search(pre + m.group(0)) and len(lit) >= 8 and "#{" not in lit:
            named = True
        pattern_hit = any(p.match(lit) for p in SECRET_PATTERNS)
        if (named or pattern_hit) and lit not in seen:
            seen.add(lit)
            inv.add(inv.seq_id("secret"), "secret", path, src, m.start(), f"<redacted literal, {len(lit)} chars>",
                    sha256=hashlib.sha256(lit.encode()).hexdigest(), length=len(lit), reason="name" if named else "pattern")


def find_data_files(inv):
    for dirpath, dirnames, filenames in os.walk(inv.root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for f in filenames:
            ext = os.path.splitext(f)[1].lower()
            if ext in (".csv", ".tsv", ".ssv") or (ext in DATA_EXTS and "resources" in dirpath.split(os.sep)):
                inv.data_files.append(os.path.relpath(os.path.join(dirpath, f), inv.root))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("project")
    ap.add_argument("-o", "--output")
    args = ap.parse_args()
    root = os.path.abspath(args.project)
    if not os.path.isdir(root):
        sys.exit(f"not a directory: {root}")

    inv = Inventory(root)
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
        for f in sorted(filenames):
            if os.path.splitext(f)[1] in SOURCE_EXTS:
                scan_file(inv, os.path.join(dirpath, f))
    find_data_files(inv)

    counts = {}
    for it in inv.items:
        counts[it["kind"]] = counts.get(it["kind"], 0) + 1
    result = {
        "tool": "gatling-migration inventory 0.1.0",
        "project": root,
        "languages": sorted(inv.languages),
        "simulations": inv.simulations,
        "data_files": sorted(inv.data_files),
        "el_variables": sorted(inv.el_vars),
        "counts": counts,
        "items": inv.items,
    }
    text = json.dumps(result, indent=2)
    if args.output:
        os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
        open(args.output, "w").write(text + "\n")
        print(f"{len(inv.items)} items → {args.output}  " + "  ".join(f"{k}={v}" for k, v in sorted(counts.items())))
    else:
        print(text)
    if not inv.simulations:
        print("warning: no Simulation class found", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
