# Globals

The [environment reference](environment.md#file-and-fields) owns the shared
`name` and `values` schema and secret handling. Globals use the same shape,
conventionally `name: Globals`, with a `*.globals.yaml` filename under
`postman/globals/`. An empty `values: []` is valid.

The filename suffix identifies the entity: environment files use
`*.environment.yaml`, globals use `*.globals.yaml`; neither uses `$kind`.
Use `postman globals lint <file>` for globals. Environment and globals lint
both accept `-o/--output`, where collection lint accepts `-r/--reporter`.

`postman globals lint <file>` checks structure, not whether consumers use the intended values.
