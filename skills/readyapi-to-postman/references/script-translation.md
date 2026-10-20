# ReadyAPI Groovy → Postman JavaScript translation

`scripts/groovy_to_js.py` applies the mechanical rewrites below, then flags every
script for your review (no regex pass is semantically trustworthy). Your job: open
the `// REVIEW` block in the collection event and make the logic correct. This file
is the mapping reference and the place to extend the rule table when you spot a
recurring pattern.

## What the deterministic pass already handles

| ReadyAPI Groovy | Postman JS | Note |
|---|---|---|
| `testRunner.testCase.setPropertyValue("k", v)` | `pm.variables.set("k", v)` | case-scope write |
| `testRunner.testCase.getPropertyValue("k")` | `pm.variables.get("k")` | case-scope read |
| `context.testCase.setPropertyValue(...)` / `getPropertyValue(...)` | `pm.variables.set/get(...)` | |
| `context.setProperty("k", v)` / `context.getProperty("k")` | `pm.variables.set/get(...)` | |
| `context.expand('${#TestCase#k}')` | `pm.variables.get("k")` | single-var expand only |
| `messageExchange.responseContent` / `getResponseContent()` | `pm.response.text()` | assertion/post-step context |
| `messageExchange.getResponseStatusCode()` | `pm.response.code` | |
| `new groovy.json.JsonSlurper().parseText(x)` | `JSON.parse(x)` | |
| `log.info/warn/error(...)` | `console.log/warn/error(...)` | |
| `System.currentTimeMillis()` | `Date.now()` | |
| `UUID.randomUUID().toString()` | `require("uuid").v4()` | confirm sandbox availability |
| `Integer.parseInt` / `Double.parseDouble` | `parseInt` / `parseFloat` | |
| `def x` / typed decls | `let x` | |

## What you must fix by hand (flagged, no clean mapping)

- **`assert <expr>`** — Groovy assertions. Rewrite as `pm.test("...", () => pm.expect(<expr>).to.<matcher>)`. A bare `assert a == b` → `pm.expect(a).to.eql(b)`.
- **`XmlSlurper` / `XmlParser`** — no sandbox XML parser. If the payload is really JSON, reparse with `JSON.parse`; otherwise `require('xml2js')`/`cheerio` (confirm availability) or drop with a note.
- **`testRunner.testCase.getTestStepByName("X").getPropertyValue("Y")`** — cross-step reads. If X is an earlier request, its extracted value should already be a collection variable → `pm.collectionVariables.get("Y")`. Rewire accordingly.
- **`.each { ... }` / `.collect { ... }` / closures (`->`)** — convert to `for...of` / `.map(...)` with arrow functions.
- **`import ...` / `new SomeJavaClass(...)`** — Java/Groovy types. Find a JS equivalent or drop.
- **`context.expand("...")` with multiple vars or expressions** — only the single-var form is auto-handled; expand the rest to template literals with `pm.variables.get(...)`.
- **`groovyUtils` / `com.eviware.*`** — SoapUI API; no equivalent, reimplement intent.

## Script placement

- **Groovy Script step** → emitted as a standalone request stub (GET, empty URL) with the JS in its `prerequest` event. Decide with the user: fold the logic into an adjacent request's pre/post script, or keep the stub.
- **Script Assertion** → the request's `test` event.
- **Setup / teardown script** → the enclosing folder's `prerequest` / `test` event.

## Extending the rules

Add `(pattern, replacement)` tuples to `RULES` in `scripts/groovy_to_js.py`, most-specific first. Add tokens that should always force review to `REVIEW_MARKERS`. Keep each rule narrow — a greedy rule that mis-rewrites is worse than leaving a token for the model.
