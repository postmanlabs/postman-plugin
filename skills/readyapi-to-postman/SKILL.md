---
name: readyapi-to-postman
description: Convert a ReadyAPI / SoapUI project XML into a Postman Collection (v2.1) plus a ready-to-run performance-test configuration and a conversion report. Use when a user wants to migrate a ReadyAPI or SoapUI project to Postman, has a ReadyAPI/SoapUI `.xml` project file to convert, or asks to turn ReadyAPI test suites / test cases / REST or SOAP requests / assertions / Groovy scripts / LoadTests into a Postman collection and `postman performance run` settings.
---

# ReadyAPI / SoapUI → Postman converter

Turn a ReadyAPI (SoapUI) project into three artifacts:

1. **Postman Collection v2.1** — REST + SOAP requests, folder structure (suites → cases → steps), headers, auth, properties → variables, assertions.
2. **Performance config** — VU count, duration, load profile, `--pass-if`, and the exact `postman performance run` command, derived from ReadyAPI `<con:loadTest>` definitions.
3. **Conversion report** — what converted exactly, what was approximated, what needs manual work, what is unsupported.

The parsing and building are **deterministic Python** (`scripts/`), standard-library only. **You (the model) only do the judgment calls the scripts flag** — chiefly translating Groovy scripts/assertions to JavaScript, and resolving XPath/JsonPath assertions Python can't. This is model-agnostic: nothing here calls an LLM API or a hosted service. The tokens spent are the ones running this skill — yours.

## Scope

The default output is the **collection JSON and the perf config** — nothing is published automatically. Pushing the collection into a Postman workspace is an **optional final step** the user must ask for (see step 6); until then `<COLLECTION_UID>` stays a placeholder the user fills after importing.

## When NOT to guess

Postman performance runs do not support everything ReadyAPI does (no DB connectivity, no arrival-rate load, single `--pass-if`, time-based not run-count-based). The scripts already encode the gaps — see `references/postman-perf-capabilities.md` and `references/loadtest-to-perf.md`. Never invent a Postman feature to cover a ReadyAPI one. If something can't convert, it belongs in the report's "Needs manual work" or "Not supported" section — that is a correct outcome, not a failure.

## Workflow

### 1. Run the converter

```bash
python3 scripts/readyapi_to_postman.py INPUT.xml -o OUTDIR --json-report
```

Produces in `OUTDIR` (`<name>` = input basename):
- `<name>.postman_collection.json` — the collection (import-ready)
- `<name>.perf.json` / `<name>.perf.md` — performance config + the `postman performance run` command(s)
- `<name>.report.md` — the conversion report
- `<name>.ir.json` — machine-readable intermediate model + `manual_tasks` + `warnings`

Python 3.8+ only, standard library — no pip installs.

### 2. Resolve the manual tasks

Open `<name>.ir.json` and read `manual_tasks`. Each has `request`/`step`, `kind`, `detail`. Handle by kind:

- **`script`** — a ReadyAPI Groovy script step, script assertion, or setup/teardown script. A Groovy *step* (no HTTP) becomes a **sendable** `[Groovy] <name>` request pointed at Postman Echo with the script in its pre-request tab — never an empty URL. It was translated to JS **only if confidently valid**; otherwise the whole body is commented out with the original Groovy preserved and a `// [needs-manual-translation]` banner (so the collection always imports). Open that item's `event` script, read the banner, and complete the translation. Use `references/script-translation.md`. Common fixes: `testRunner`/`context`/`messageExchange` accessors with no clean `pm.*` target, `assert` → `pm.expect`, `XmlSlurper`, `.each{}` closures, `import`/`new`, `0..9` ranges, `getTestStepByName(...)` chains.
- **`property_transfer`** — a ReadyAPI Property Transfer step. Rewrite it as a `pm.collectionVariables.set(...)` in the source request's test script reading from the response (see the detail for source/target).
- **`jdbc`** — a JDBC/database test step. Postman has no DB connectivity by design. Replace with an HTTP call to a thin read-only query API, or drop with a note. See `references/mapping-table.md` → JDBC.
- **`xpath`** — an XPath/XQuery assertion. The Postman sandbox has no built-in XPath engine. Rewrite against the JSON body if the response is JSON, or use `xml2js`/`cheerio` via `require(...)` in the script (confirm availability), or drop with a note.
- **`jsonpath`** — a JsonPath Match/Count assertion whose path used wildcards/filters/recursion. Rewrite it as explicit property access in the request's test script.
- **`assertion`** — an assertion type with no deterministic mapping. Read `detail` for the ReadyAPI type and decide: express as `pm.test` if possible, else note it.
- **`datasource`** — a ReadyAPI DataSource/Grid loop. Its filename + columns are already captured in the perf config's `data_files`; export the grid/Excel data as JSON or CSV and it wires in as `--data-file` (columns → `pm.iterationData.get(col)`). A DB DataSource has no file and needs an API or export.
- **`wss`** — WS-Security that isn't a standard UsernameToken (Signature, Encryption, custom). UsernameToken is already wired as a collection pre-request; these need manual setup in Postman.

Edit the collection JSON in place. Keep the `// REVIEW` comments until the logic is confirmed.

### 3. Validate the output

Always run both gates before presenting results:

```bash
# (a) collection is valid v2.1 JSON
python3 -c "import json; c=json.load(open('OUTDIR/<name>.postman_collection.json')); assert c['info']['schema'].endswith('v2.1.0/collection.json'); assert isinstance(c['item'],list); print('v2.1 OK', len(c['item']),'top-level items')"

# (b) every generated script parses as JS (node)
node -e "const fs=require('fs'),vm=require('vm');const c=JSON.parse(fs.readFileSync('OUTDIR/<name>.postman_collection.json'));let n=0,bad=0;(function w(i){for(const it of i||[]){if(it.item)w(it.item);for(const e of it.event||[]){n++;try{new vm.Script((e.script.exec||[]).join('\n'))}catch(err){bad++;console.log('BAD',it.name,err.message)}}}})(c.item);console.log('scripts',n,'bad',bad)"
```

If (b) reports a bad script, fix it — a syntax error breaks that request at run time.

### 4. Finalise the report

The generated `<name>.report.md` covers structure. Before handing off, append anything you changed in step 2 and reconcile the counts. Use `references/conversion-report-template.md` if you need to regenerate it from scratch.

### 5. Hand off the perf config

`<name>.perf.md` has a `postman performance run` command per LoadTest, with `<COLLECTION_UID>` as a placeholder — the collection must be imported into a Postman workspace first to get a real UID. Surface the VU / duration / profile choices and the `--pass-if` default so the user can adjust; ReadyAPI LoadTest assertions map imperfectly (see `references/loadtest-to-perf.md`), so those values are suggestions, not guarantees.

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

Report back: the workspace, the collection UID, and the ready-to-run perf command. If the user did **not** ask to publish, skip this entirely and leave the local `collection.json`.

## Core mapping (summary)

Full table with fidelity + owner in `references/mapping-table.md`; LoadTest specifics in `references/loadtest-to-perf.md`.

| ReadyAPI / SoapUI | Postman | Fidelity |
|-------------------|---------|----------|
| Project | Collection | exact |
| Test Suite | Folder | exact |
| Test Case | Sub-folder | exact |
| REST Request step | Request item | exact |
| SOAP (WSDL) Request step | Request item (POST, text/xml) | exact |
| Project / Suite / Case properties | Collection variables | approximate (scopes flattened) |
| Interface endpoint + resource path | Request URL | exact |
| REST parameters (path/query) | URL path vars + query | exact |
| Auth: Basic / Bearer / API key | request/collection auth | exact |
| Simple assertions (status, contains, SLA) | `pm.test(...)` | exact |
| Groovy script step / assertion | pre/post script (JS) | model-assisted |
| Property Transfer step | test-script variable set | model-assisted |
| JDBC / database step | — (expose via API) | manual |
| XPath / XQuery assertion | — | manual |
| JsonPath assertion (complex) | test-script property access | manual |
| DataSource / Grid loop | `--data-file` (JSON/CSV) | approximate |
| LoadTest: thread count | `--vu-count` | exact |
| LoadTest: time limit | `--duration` | exact |
| LoadTest: Simple strategy | `fixed` profile | exact |
| LoadTest: Thread (ramp) strategy | `ramp-up` profile | approximate |
| LoadTest: Burst / Variance strategy | `spike` profile | approximate |
| LoadTest: Fixed Rate strategy | fixed VUs (rate note) | weak — reported |
| LoadTest assertions (avg/TPS/errors) | `--pass-if` (one only) | approximate |

## Scope limits (hard facts, verified against the CLI/engine code)

- Performance runs execute **one collection repeated across VUs**. Multiple LoadTests cannot run concurrently in a single run — each becomes its own `postman performance run`.
- Runs are **time-based**, not run-count-based. ReadyAPI "Total Runs" / "Runs per Thread" limits become a duration estimate.
- `--pass-if` is a **single, non-repeatable** condition. Extra LoadTest assertions stay as notes or `pm.test`.
- **No native think time.** ReadyAPI test delays / pacing are not reproduced — always reported.
- **No database connectivity.** JDBC steps have no equivalent; expose reads via an HTTP API.
- Postman has **no XPath/XQuery engine** in the sandbox; those assertions need a JSON rewrite or a `require()`'d parser.
