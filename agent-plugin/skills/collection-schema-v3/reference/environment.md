# Environment Schema (v3)

Read this reference before creating, editing, or debugging files under
`postman/environments/`.

## Prefer the CLI for ordinary edits

The CLI preserves the schema and avoids leaking secret values into command
output:

```bash
postman environment new "Staging EU"
postman environment var set baseUrl https://staging.example.com \
  --environment "postman/environments/Staging EU.environment.yaml"
postman environment var unset oldToken \
  --environment "postman/environments/Staging EU.environment.yaml"
postman environment lint postman/environments --fail-severity warning
```

Use `environment get --show-secrets` only when the user explicitly needs the
secret value revealed. Do not print, summarize, or commit credentials returned
by it.

## File and fields

An environment is one YAML file named `<name>.environment.yaml` under
`postman/environments/`. It has no `$kind` field.

- `name` — required string.
- `values` — required array; an empty environment uses `values: []`.
- Each value has:
  - `key` — required variable name.
  - `value` — string for a plain variable; omit it on a secret (see `secret`).
    Quote booleans, numbers, empty values, and values containing YAML
    punctuation or `{{variables}}` so YAML does not coerce them.
  - `disabled` — optional boolean. Write `disabled: true` only for a turned-off
    variable and omit the key for an enabled one. The app reads a legacy
    `enabled: true|false` too, but `disabled` wins when both are present, and
    the app never writes `enabled` back. Do not write `enabled`.
  - `secret` — optional boolean. `secret: true` is the only way the app treats
    a variable as secret. A secret carries no `value`; its content comes from a
    vault via an optional `source` object, which `postman environment var set
    --secret-id <id>` writes.
  - `type` — the app does not write it and ignores it on read. Omit it.
    `type: secret` without `secret: true` is read as a plain variable and its
    `value` stays in the file as plaintext, even though lint accepts it.
  - `description` — optional string.

Do not add collection-only fields such as `$kind`, `scripts`, `auth`, or
`variables`. Do not put secrets into an example merely to make it executable;
leave the value empty or use the team's supported secret source.

## Linted example

```yaml
name: Staging EU
values:
  - key: baseUrl
    value: 'https://staging.example.com'
    description: API base URL
  - key: apiToken
    secret: true
    disabled: true
```

After any hand edit, run `postman environment lint <file-or-directory>`. Use
`postman workspace lint` when the task is to validate the entire local
workspace, not just its environments.
