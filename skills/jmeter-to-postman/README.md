# JMeter → Postman importer: how to use it

`SKILL.md` is a skill that imports an existing JMeter load test (`.jmx`) into a **Postman collection (v2.1)**, a **performance-run configuration**, and a **import report**. Unlike a prompt-only importer, the heavy lifting is a deterministic Python parser (`scripts/`); the model only handles the judgment calls (Groovy/BeanShell → JavaScript, ambiguous extractors), and everything it can't import is reported, never faked.

## Prerequisites

- A model with code execution — Claude Code, Cursor, an agent, etc. (A plain chat with no execution still works via the by-hand fallback, but it's best-effort — see "Good to know".)
- **Python 3.8+** on PATH. Standard library only — no `pip install`.
- *(optional)* **Node.js** — used only to syntax-check generated scripts.
- *(optional)* **Postman CLI 1.50+**, logged in (`postman login`) — only if you want to actually run the imported collection (`postman collection run`) or launch `postman performance run`.
- A JMeter test plan: a `.jmx` file (plus any CSV data files it references).

## Install

Project-level:
```sh
git clone <this-folder> .skills/jmeter-to-postman
# or just copy the jmeter-to-postman/ folder next to your .jmx
```
System-wide (Claude Code skills dir):
```sh
cp -r jmeter-to-postman ~/.claude/skills/jmeter-to-postman
```

## Use

Give the model the skill folder and your `.jmx`, then prompt:

| Goal | Prompt |
|---|---|
| Import only | `Use the jmeter-to-postman skill to import ./mytest.jmx into a Postman collection and perf config.` |
| Import + explain gaps | `Import ./mytest.jmx with the jmeter-to-postman skill. Walk me through the import report — what's exact, approximated, and what I must fix by hand.` |
| CI gate | `Run the jmeter-to-postman importer on ./mytest.jmx with --fail-on-blockers and tell me if anything needs manual work.` |
| Smoke-test the result | `Import ./mytest.jmx, then run the collection locally with postman collection run and show me the request trace.` |

Or run it directly, no model:
```sh
python3 scripts/jmx_to_postman.py path/to/test.jmx -o out/ --json-report
```

## What happens

1. **Parse** — the importer reads the `.jmx` (XXE-hardened, 25 MiB cap) and walks the JMeter tree (element + sibling `hashTree` pairing).
2. **Build the collection** — requests, scoped headers, auth, URLs, query/body, `${var}`→`{{var}}`, extractors → `pm.collectionVariables.set`, assertions → `pm.test`, plus JMeter's implicit HTTP 200–399 success check.
3. **Build the perf config** — thread groups → VUs + duration (minutes) + one of Postman's 4 load profiles; a Duration Assertion → `--pass-if`; the `postman performance run` command (with a `<COLLECTION_UID>` placeholder).
4. **Sever setUp/tearDown** — those thread groups become separate run-once collections, not looped load.
5. **Flag the judgment calls** — Groovy/BeanShell scripts and XPath/CSS/complex-JSONPath extractors are auto-started and listed as `manual_tasks` for the model to finish (`references/script-translation.md`).
6. **Report** — `*.report.md` lists imported exactly / approximated / needs manual work / not supported.
7. **Validate** — collection is valid v2.1; every generated script is JS-syntax-checked (if Node is present).
8. *(optional)* **Smoke test** — `postman collection run out/test.postman_collection.json` runs it locally.
9. *(optional)* **Load test** — upload the collection for a UID, then `postman performance run <uid> …` using the generated settings.

## Adapt it to your team

- **Defaults** live in `scripts/jmx_to_postman.py`: blank-protocol default (`http`), the fallback `--pass-if` (`error_rate(less_than, 5)`), the load-profile heuristic. Change them in one place.
- **Script translation**: extend the rule table in `scripts/groovy_to_js.py` and `references/script-translation.md` with your common Groovy/BeanShell idioms.
- **Mapping policy**: `references/mapping-table.md` is the single source of truth for what maps where — edit it and the code together.
- **Regression safety**: the spec-fixture suite and corpus runner live in the source repo (not shipped with the skill); run them there after any change to `scripts/`.

## Good to know

- The **perf config is advisory** — review VUs, duration, and `--pass-if` before running. JMeter rarely pins a performance threshold, so the default is a suggestion.
- `postman performance run` needs the collection **uploaded to a workspace** (for a UID) and an interactive session; it is not an offline step. `postman collection run` *is* offline and runs a local file.
- **Unsupported by Postman perf** — think-time timers, concurrent thread groups, non-HTTP (JDBC/FTP/LDAP/Java) samplers — are dropped and listed in the report. That is a correct outcome, not a failure.
- **No code execution?** The model can still import by hand from `references/mapping-table.md` + `references/script-translation.md` (SKILL.md has the step-by-step fallback), but that path is slower and not deterministic — it's flagged as best-effort.
- `SKILL.md` is the model-facing workflow; this README is for humans.
