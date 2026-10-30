# The workspace manifest

`.postman/resources.yaml` maps local paths to workspace ids. **Do not hand-author it** —
`postman init` creates it and `workspace push` / `mock push` maintain the mappings. The
one routine hand-edit is deleting a stale line after an entity is deleted in the workspace,
since that leaves the mapping behind.

Collections map to a **directory**; the other registered entities map to the path the CLI
wrote, normally a **file**. Datasets are not registered here. Paths are relative to
`.postman/`, so they begin `../`. Ids come either owner-prefixed
(`12345678-<uuid>`) or as bare 24-character hex — both are accepted.

```yaml
workspace:
  id: 6d3e9a17-4c80-4f25-b1a9-7e02c58d3f64
cloudResources:
  collections:
    ../postman/collections/My API: 12345678-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
  environments:
    ../postman/environments/Dev.environment.yaml: 12345678-6d3e9a17-4c80-4f25-b1a9-7e02c58d3f64
  globals:
    ../postman/globals/Globals.globals.yaml: 12345678-99999999-8888-7777-6666-555555555555
  mocks:
    ../postman/mocks/probe-mock/config.yaml: a41c8e05-7f23-4b96-8d0e-3c6a9b25f718
  specs:
    ../postman/specs/orders.yaml: cccccccc-dddd-eeee-ffff-000000000000
```

A registered entity that exists in the workspace but is missing from this file makes
`workspace push` plan a *create*, which fails `404 The target resource was not found` and
leaves the workspace copy stale. A mapping whose path no longer exists raises `WSP014` from
`workspace lint`.
