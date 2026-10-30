# Specs

`postman/specs/<name>.yaml`, or `postman/specs/<name>/` as a directory — both are
accepted on disk. The content is plain OpenAPI or AsyncAPI with no Postman wrapper.

When lint reports an unresolved `$ref` in a spec split across documents,
distinguish a missing target from a CLI resolution limitation. Preserve the
source organization while checking the referenced file and fragment. If a
consumer needs a single document, a bundled validation copy can test that path
without restructuring the maintained contract. Report any resolution limitation
separately from contract validity.

`postman spec lint` reports governance findings next to validity ones, at **ERROR**
severity. A valid spec with no `security` block still reports *"Security field is not
defined"* with issue type `Governance`, so a non-zero error count does not mean the spec
is malformed. Read the `issue type` column and treat only `Validation` findings as
format errors.

Validate with `postman spec lint <path>`.
