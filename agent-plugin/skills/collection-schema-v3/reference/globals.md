# Globals

A globals file is named `<name>.globals.yaml` under `postman/globals/`.
It has no `$kind` discriminator.

## Fields

- `name` — required string, conventionally `Globals`.
- `values` — required array; `values: []` represents no globals.
- Each value has:
  - `key` — required variable name.
  - `value` — string for a plain variable; omit it on a secret. Quote
    numeric- or boolean-looking strings and `{{variables}}` so YAML preserves
    their type.
  - `enabled` — boolean, written on every value. Globals still use `enabled`,
    not the environment's `disabled`. The app reads `disabled: true` in a
    globals file as enabled, and a pull rewrites it to `enabled: false`.
  - `secret` — optional boolean. `secret: true` is the only way the app
    treats a variable as secret, and a secret carries no `value`.
  - `type` — the app does not write it. Omit it; `type: secret` without
    `secret: true` is not treated as secret.
  - `description` — optional string.

## Example

```yaml
name: Globals
values:
  - key: base_url
    value: 'https://api.example.com'
    enabled: true
  - key: api_token
    secret: true
    enabled: false
```

Marking a value as secret does not make a literal credential safe to commit.
Keep reusable examples free of credentials; see **variables** for secret sources.

Validate with `postman globals lint <file>`. This checks structure, not whether
requests resolve the intended values; check scope and overrides when diagnosing
unexpected runtime values.
