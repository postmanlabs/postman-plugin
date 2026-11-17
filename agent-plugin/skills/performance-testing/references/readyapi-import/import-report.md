# Import report shape

Write this alongside the imported collection so the hand-off states exactly what landed and what still needs a human. First line is the result, then the sections. Keep it specific — counts and names, not adjectives.

```markdown
# ReadyAPI → Postman import: <project name>

Imported <N> requests across <S> suites / <C> cases into "<collection>". <K> Groovy scripts translated, <M> still flagged. <L> LoadTest(s) → perf run(s).

## Summary
| Metric | Count |
|---|---|
| Suites → folders | <S> |
| Cases → sub-folders | <C> |
| Requests | <N> |
| Collection variables | <V> |
| LoadTests → perf runs | <L> |
| Groovy scripts (translated / flagged) | <K> / <M> |
| Needs-manual items | <J> |

## Converted
What mapped exactly — REST/SOAP/HTTP requests, auth, params, properties → variables, deterministic assertions, etc.

## Approximated
Deterministic but lossy — load-profile choice per LoadTest, run-count → duration, property-scope flattening, single `--pass-if` from several assertions.

## Needs manual work
One bullet per flagged item: Groovy left with a `// REVIEW`, XPath/XQuery assertions, complex JSONPath, Property Transfers needing hand-wiring, JDBC placeholders to repoint at a query API.

## Not supported / skipped
ReadyAPI constructs with no Postman equivalent (reported, never faked): DB connectivity, think-time delays, arrival-rate load, WS-Security Signature/Encryption, concurrent LoadTests in one run.

## Performance config
The `postman performance run` command(s), VU/duration/profile/`--pass-if` per LoadTest, and which values are suggestions.
```
