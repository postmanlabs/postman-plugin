# ReadyAPI / SoapUI → Postman mapping (full)

Fidelity legend: **exact** (deterministic, lossless) · **approximate** (deterministic, documented loss) · **model-assisted** (Python stubs it, you fix it) · **manual** (no deterministic path; reported).

## Structure

| ReadyAPI element | Postman | Fidelity | Owner |
|---|---|---|---|
| `<con:soapui-project name>` | Collection (`info.name`) | exact | script |
| `<con:testSuite name>` | top-level folder | exact | script |
| `<con:testCase name>` | nested folder | exact | script |
| `<con:testStep>` (request) | request item | exact | script |
| step order within a case | item order within folder | exact | script |
| `<con:description>` | item description | exact | script |

## Requests

| ReadyAPI | Postman | Fidelity | Notes |
|---|---|---|---|
| REST Request step (`RestRequestStep`) | request item | exact | verb resolved from the `<con:interface>` resource/method by `methodName` |
| SOAP/WSDL Request step (`WsdlRequestStep`) | request item, POST, `Content-Type: text/xml` | exact | `SOAPAction` header added when present; body is the raw envelope |
| HTTP Request step (`HttpRequestTestStep`) | request item | exact | method + endpoint read from config |
| `<con:endpoint>` + `resourcePath` | `url.raw` / `url.host` / `url.path` | exact | concatenated; also parsed into structured `url` |
| REST `<con:parameters><con:entry>` in path (`{id}`) | `url` path variable | exact | path templating preserved |
| REST `<con:parameters>` not in path | `url.query` | exact | |
| `<con:request>` body | `body.raw` (json/xml by `mediaType`) | exact | |
| ReadyAPI vars `${#Scope#name}` | `{{name}}` | exact | scope prefix stripped (`#Project#`/`#TestCase#`/`#TestSuite#`/`#Global#`/step refs) |

## Auth

| ReadyAPI `<con:authType>` | Postman auth | Fidelity |
|---|---|---|
| `Basic` | `basic` (username/password) | exact |
| `OAuth 2.0` Bearer / `Bearer` | `bearer` | exact (token value may be a variable to fill) |
| API key header | `apikey` / header | exact |
| `No Authorization` | `noauth` | exact |
| `Inherit From Parent` / absent | inherit (auth omitted on item) | exact |
| OAuth 1.0 / NTLM / Kerberos | — | manual — not supported by perf runs; reported |

## Properties & data

| ReadyAPI | Postman | Fidelity | Notes |
|---|---|---|---|
| Project / Suite / Case / Global properties | collection variables | approximate | **scopes are flattened** — a single `variable[]` namespace; name collisions across scopes are reported |
| `<con:properties>` step | collection variables | approximate | folded in with a warning |
| Property / Suite / Case properties | collection variables | approximate | scopes flattened (above) |
| Dynamic value `${=...}` (now/UUID/date) | Postman dynamic var `{{$timestamp}}` / `{{$guid}}` / `{{$isoTimestamp}}` | exact | any other `${=expr}` left literal + warning |
| Property Transfer step (JSONPath source) | `pm.collectionVariables.set(target, pm.response.json().<path>)` folded into the source request's test | exact | one `set()` per transfer, on the source request |
| Property Transfer step (XPath source) | balanced `xml2js` scaffold + manual task | model-assisted | sandbox has no XPath engine |
| DataSource (Grid / Excel / File) loop | `--data-file` (JSON array or CSV) captured in the perf config | approximate | export the grid to JSON/CSV; columns map to `pm.iterationData.get(col)` |
| DataSource (JDBC / DB) | — | manual | no file; needs an API or an offline export |

## Assertions

| ReadyAPI assertion | Postman | Fidelity |
|---|---|---|
| Valid HTTP Status Codes | `pm.test` on `pm.response.code` | exact |
| Simple Contains / NotContains | `pm.expect(pm.response.text()).to.(not.)include(...)` | exact |
| Response SLA / TimeOut | `pm.expect(pm.response.responseTime).to.be.below(ms)` | exact (also a perf `--pass-if` hint) |
| JsonPath Match / Count (simple path) | `pm.test` + `pm.response.json().<path>` `.to.eql(...)` / `.to.have.lengthOf(n)` | exact |
| JsonPath Match / Count (wildcard/filter/recursive) | `// [manual]` note + manual task | manual |
| Script Assertion (Groovy) | translated JS in `test` event (safe-body: valid JS or commented original) | model-assisted |
| XPath / XQuery Match | balanced `xml2js` scaffold + manual task | manual (no sandbox XPath engine) |
| Schema Compliance / SOAP Fault | reported | manual |

## Scripts

| ReadyAPI | Postman | Fidelity |
|---|---|---|
| Groovy Script step (no HTTP) | a **sendable** `[Groovy] <name>` request pointed at Postman Echo (`https://postman-echo.com/get?groovyStep=true`, always 200 OK) with the JS in its `prerequest` event — never an empty URL | model-assisted |
| HTTP Request step (`con:HttpRequest`) | request — the `<con:endpoint>` child holds the full URL, body from `<con:request>` CDATA | exact |
| JDBC step | `<name> [JDBC - To Do]` placeholder POST to a sentinel URL, SQL in the body | manual |
| Test Case setup / teardown script | folder-level `prerequest` / `test` event | model-assisted |
| Test Suite setup / teardown script | folder-level event | model-assisted |
| `testRunner` / `context` / `messageExchange` accessors | `pm.*` where a rule exists; else flagged | model-assisted |

Every no-HTTP step (Groovy, JDBC, DataSource, delay) becomes a **sendable** request — a Postman-Echo no-op or a clearly-labelled sentinel URL — so a collection run never breaks on an empty URL. This mirrors the hosted ReadyAPI migration engine.

See `references/script-translation.md` for the Groovy→JS rule set and the accessors that have no `pm.*` equivalent.

## Load testing

Full detail in `references/loadtest-to-perf.md`. Summary: thread count → `--vu-count`; time limit → `--duration`; strategy → one of `fixed`/`ramp-up`/`spike`/`peak`; LoadTest assertions → a single `--pass-if` (the rest become notes).

## Security

| ReadyAPI | Postman | Fidelity |
|---|---|---|
| WS-Security UsernameToken (PasswordText) | collection `prerequest` builds `{{WSSE_HEADER}}` (plain) + injected into the SOAP `<Header>` | approximate |
| WS-Security UsernameToken (PasswordDigest) | collection `prerequest`, CryptoJS `Base64(SHA1(nonce+created+password))` | approximate |
| WS-Security Signature / Encryption / custom | — | manual (flagged `wss`) |

## Not supported (reported, never faked)

- JDBC / database steps (no DB connectivity by design)
- XPath / XQuery assertions evaluated at runtime (scaffold emitted; sandbox has no XPath engine)
- Arrival-rate / Fixed-Rate throughput targets (perf is concurrency-driven)
- Variance / Burst / Grid / Script load schedules (approximated to the nearest of four profiles)
- Multiple concurrent LoadTests in one run (each is a separate run)
- OAuth 1.0 / NTLM / Kerberos auth
- WS-Security Signature/Encryption, MTOM/attachments, JMS steps
