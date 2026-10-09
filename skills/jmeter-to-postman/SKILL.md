---
name: jmeter-to-postman
description: Convert a JMeter .jmx load test into a Postman collection (v2.1) plus a ready-to-run performance-test configuration and a conversion report. Use when a user wants to migrate a JMeter test plan to Postman performance testing, has a .jmx file to convert, or asks to turn JMeter requests/extractors/assertions/thread-groups into a Postman collection and `postman performance run` settings.
---

# JMeter (.jmx) → Postman converter

Turn a JMeter test plan into three artifacts:

1. **Postman Collection v2.1** — requests, flow, headers, auth, variables, extractors, assertions.
2. **Performance config** — VU count, duration, load profile, data file, `--pass-if`, and the exact `postman performance run` command.
3. **Conversion report** — what converted exactly, what was approximated, what needs manual work, what is unsupported.

The parsing and building are **deterministic Python** (`scripts/`). You (the model) only do the judgment calls the scripts flag: translating Groovy/BeanShell scripts to JavaScript and resolving extractors Python can't (XPath/CSS/complex JSONPath).

## When NOT to guess

Postman performance runs do not support everything JMeter does. The scripts already encode the gaps (see `references/postman-perf-capabilities.md`). Never invent a Postman feature to cover a JMeter one. If something can't convert, it goes in the report's "Needs manual work" or "Not supported" section — that is a correct outcome, not a failure.

## Correctness rules the converter reproduces (do not regress)

These are JMeter semantics that are easy to get subtly wrong. They're covered by the converter's test suite (71 checks across 22 fixtures):

- **Implicit HTTP success** — JMeter fails a sample on HTTP ≥ 400 even with no assertion. Each request gets a default `pm.test` asserting the code is 200–399, **unless** the plan already checks the status code or sets *assume_success* (Ignore Status).
- **Port 0 / -1** → "use protocol default" → omitted from the URL.
- **Full-URL path** — if `HTTPSampler.path` is itself an absolute URL, it's used verbatim; domain/port are ignored.
- **HEAD / TRACE arguments** — JMeter does not send separate parameters as a query for these; they're dropped (reported).
- **Duplicate headers** — in-scope header managers merge; the nearer/last value per name wins and the collapse is reported.
- **Sampler-scoped config** — a Header Manager / Auth Manager / HTTP Defaults inside a request's own subtree applies to that request.
- **Security** — the parser refuses DTD/ENTITY (XXE) and caps input at 25 MiB.

## Workflow

### 1. Run the converter

```bash
python3 scripts/jmx_to_postman.py INPUT.jmx -o OUTDIR --json-report
# CI gate: add --fail-on-blockers to exit non-zero when any item needs manual work
```

Produces in `OUTDIR`:
- `<name>.postman_collection.json` — the collection (import-ready)
- `<name>.perf.md` / `<name>.perf.json` — performance config + CLI command
- `<name>.report.md` — the conversion report
- `<name>.ir.json` — machine-readable intermediate model + `manual_tasks` + `warnings` (from `--json-report`)

Python 3.8+ only, standard library — no pip installs.

### 2. Resolve the manual tasks

Open `<name>.ir.json` and read `manual_tasks`. Each has `request`, `kind`, `detail`. Handle by kind:

- **`script`** — a JSR223/BeanShell pre/post-processor was auto-translated to JS and wrapped in an IIFE. Open that request's `event` script in the collection, read the `// REVIEW` block, and correct the translation. Use `references/script-translation.md` for the mapping. Common fixes: `prev`/`ctx`/`sampler` accessors, `.each{}` loops, `import`/`new` statements.
- **`script_sampler`** — a standalone JSR223/BeanShell *sampler* (no HTTP). The stub is a GET to an empty URL carrying the translated script. Decide with the user: delete it, fold its logic into an adjacent request's pre/post script, or replace with a real request.
- **`xpath` / `css`** — the Postman sandbox has no built-in XPath/CSS selector engine. Rewrite the extractor against the JSON body if the response is JSON, or use `xml2js`/`cheerio` via `require(...)` in the script (confirm availability), or drop it with a note.
- **`jsonpath` too complex** — the path used wildcards/filters/recursion. Rewrite it as explicit property access in the request's test script.

Edit the collection JSON in place. Keep the `// REVIEW` comments until the logic is confirmed.

### 3. Validate the output

Always run both gates before presenting results:

```bash
# (a) collection is valid v2.1 JSON
python3 -c "import json,sys; c=json.load(open('OUTDIR/<name>.postman_collection.json')); assert c['info']['schema'].endswith('v2.1.0/collection.json'); assert isinstance(c['item'],list); print('v2.1 OK', len(c['item']),'top-level items')"

# (b) every generated script parses as JS (node)
node -e "const fs=require('fs'),vm=require('vm');const c=JSON.parse(fs.readFileSync('OUTDIR/<name>.postman_collection.json'));let n=0,bad=0;(function w(i){for(const it of i||[]){if(it.item)w(it.item);for(const e of it.event||[]){n++;try{new vm.Script((e.script.exec||[]).join('\n'))}catch(err){bad++;console.log('BAD',it.name,err.message)}}}})(c.item);console.log('scripts',n,'bad',bad)"
```

If (b) reports a bad script, fix it — a syntax error breaks that request at run time.

### 4. Finalise the report

The generated `<name>.report.md` covers structure. Before handing off, append anything you changed in step 2 and confirm the numbers. Use `templates/conversion-report.md` if you need to regenerate it from scratch.

### 5. Hand off the perf config

`<name>.perf.md` has the `postman performance run` command with `<COLLECTION_UID>` as a placeholder — the collection must be uploaded to a Postman workspace first to get a real UID. Surface the VU/duration/profile choices and the `--pass-if` default so the user can adjust; the JMeter source rarely pins a performance threshold, so that value is a suggestion.

### 6. (optional) Push the collection to a Postman workspace

Only on the user's explicit request and consent. Push **through the Postman CLI**, mirroring the official Postman plugin (its `bootstrap` / `ci-integration` skills) — the CLI serializes the collection correctly and preserves every request's URL.

**Three rules that prevent the "pushed but empty URLs" failure:**
1. **Interrogate the CLI; never invent a flag.** `postman -h`, then `postman <resource> -h`, then `postman <resource> <action> -h`. Live `-h` output is authoritative over anything written here.
2. **`postman init` needs no git repo and no browser login.** It scaffolds the git-native filesystem *and* provisions an agent-scoped session. "The CLI needs a git repo / login" is the misconception that makes agents bail to a lossy fallback — `init` creates the workspace filesystem itself.
3. **MCP is a last resort — only if the `postman` binary cannot be installed. Never push a full collection with MCP `createCollection`: it drops each request's `url`** (requests arrive with blank URLs). If you are truly forced onto MCP, see the repair step at the end.

**Steps:**
1. Resolve the CLI: `postman --version`; install it if missing (don't jump to MCP because it's absent).
2. Bind a workspace:
   - new → `postman init --json --visibility personal` (scaffolds `postman/` + `.postman/resources.yaml`, agent session, no login)
   - existing → `postman workspace list --json` to pick, then `postman workspace pull <WORKSPACE_ID>`
3. Bring the converted collection into the bound `postman/` tree. Our output is v2.1; the git-native workspace is v3, so migrate it in — check the exact flag first: `postman collection migrate -h`, then migrate `OUTDIR/<name>.postman_collection.json` into `postman/collections/`.
4. Review, then push with consent: `postman workspace diff --push-strategy default` → `postman workspace push`. Do **not** add `-y` just to skip the prompt, and never use `--push-strategy force-sync` unless the user approves the deletions it shows.
5. Wire the resulting UID into `<name>.perf.md`'s `postman performance run` command; optionally `postman collection run <UID>` once to confirm green.

**Last resort only — the `postman` binary cannot be installed and only the Postman MCP is reachable.** `createCollection` will drop URLs, so after creating, **repair each request's URL** with a plain-string `url` and verify:
```
updateCollectionRequest(collectionId=<uuid-without-owner-prefix>, requestId=<request id>, url="https://…/path")
# then getCollection(model=full) and confirm no request has "url": {"raw": ""}
```

Report back: the workspace, the collection UID, and the ready-to-run perf command. If the user did **not** ask to publish, skip this entirely and leave the local `collection.json`.

## Fallback: when you cannot run Python

If this environment has no code execution, do **not** refuse — convert by hand, following the exact same rules the script encodes. Output must be identical in shape (collection v2.1 + perf config + report).

1. **Read first:** `references/mapping-table.md` (what maps to what), `references/postman-perf-capabilities.md` (the hard limits), `references/script-translation.md` (Groovy/BeanShell → JS). These ARE the algorithm.
2. **Parse the JMX by the one structural rule:** every element is followed by a sibling `<hashTree>` holding its children. Walk those pairs. A config element (Header Manager, Auth, HTTP Defaults, extractor, assertion) applies to every sampler in its subtree; the same element inside a sampler's own hashTree applies only to that sampler.
3. **Apply the non-negotiable rules** (same as the script). Use the **exact JS templates in `references/script-translation.md`** for extractors and assertions so a hand conversion matches the script output byte-for-byte:
   - `${var}` → `{{var}}`; `${__UUID}`→`{{$guid}}`, `${__time}`→`{{$timestamp}}`, `${__Random(..)}`→`{{$randomInt}}`, `${__RandomString(..)}`→`{{$randomAlphaNumeric}}`.
   - Every request gets a default `pm.test` asserting HTTP 200–399 — **unless** that request has a Response Assertion whose `test_field` is `response_code` **or** `response_message`, **or** any assertion with `assume_success=true`. An assertion on the **body** (`response_data`) does NOT suppress it.
   - Port 0/-1 → omit. Full-URL path (`path` starts with `http://`/`https://`) → use verbatim, ignore domain/port. HEAD/TRACE args → drop + note. Keep inherited headers as-is even on a GET (JMeter still sends them); don't prune.
   - Extractors → `pm.collectionVariables.set` in the test script; assertions → `pm.test`. (Templates in the reference.)
   - Thread group → VUs = `num_threads`; **duration (minutes) = round(`ThreadGroup.duration` seconds ÷ 60), minimum 1**; profile = `ramp-up` if `ramp_time`>0 or a plugin/concurrency group, else `fixed`. Loop counts → duration (there is no iteration count). One `--pass-if` only; a Duration Assertion → `p95(less_than, <ms>)`, else default `error_rate(less_than, 5)`.
   - Timers / concurrent thread groups / non-HTTP samplers → **not supported**; list them in the report, never fake them.
4. **Produce the same files** a run would: the collection JSON, the perf `.md`, and the report with the four sections (converted / approximated / needs manual work / not supported).
5. **State clearly** in your answer that this was a by-hand conversion (no Python), so it's best-effort and not the deterministic, tested path.

This fallback is lower-reliability than running the script — flag anything you were unsure about.

## Core mapping (summary)

Full table with fidelity + owner in `references/mapping-table.md`.

| JMeter | Postman | Fidelity |
|--------|---------|----------|
| Test Plan | Collection | exact |
| Thread Group | VU count + duration + load profile | approximate |
| HTTP Request sampler | Request item | exact |
| Header Manager | request headers (scoped) | exact |
| HTTP Request Defaults | base URL / fallback fields | exact |
| Auth Manager (Basic/Digest) | request/collection auth | exact (Kerberos/NTLM unsupported) |
| User Defined Variables | collection variables | exact |
| CSV Data Set | `--data-file` | approximate (one file per run) |
| Regex / Boundary extractor | test script → `pm.collectionVariables.set` | exact |
| JSON extractor (simple path) | test script property access | exact |
| XPath / CSS extractor | — | manual |
| Response Assertion | `pm.test(...)` | exact |
| Duration Assertion | `pm.test` + `--pass-if p95(...)` hint | exact |
| JSR223 / BeanShell | pre/post script (JS) | model-assisted |
| Transaction Controller | folder | exact |
| If Controller | per-request pre-request skip guard (`pm.execution.skipRequest`) | approximate |
| Loop / While Controller | flattened; loop count → duration | approximate |
| Timer, per-request | pre-request pause before the request | approximate |
| Timer, group/plan scope | `--delay-request <ms>` between requests | approximate |
| Multiple thread groups | one run each (can't run concurrently) | approximate |

## Scope limits (hard facts, verified against the CLI/engine code)

- Performance runs execute **one collection repeated across VUs**. Multiple thread groups cannot run concurrently in a single run.
- Runs are **time-based**, not iteration-based. JMeter loop counts become a duration.
- `--pass-if` is a **single, non-repeatable** condition. Extra assertions stay as `pm.test` in scripts.
- **No native think time.** JMeter timers are approximated — group-scope ones as `--delay-request`, per-request ones as a pre-request pause — not reproduced exactly. Always reported.
- Only **HTTP(S)** samplers convert. JDBC/FTP/LDAP/Java/TCP/Debug/Dummy samplers are reported as skipped.
