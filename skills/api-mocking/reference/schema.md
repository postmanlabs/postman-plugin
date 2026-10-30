# Mock configuration YAML

```
postman/mocks/probe-mock/
├── config.yaml
└── default.js
```

```yaml
version: 1                    # not $kind
id: a41c8e05-7f23-4b96-8d0e-3c6a9b25f718
name: Probe Mock
slug: probe-mock
protocol: http
port: 4500
scenarios:
  - name: default
    path: ./default.js
    default: true             # only on the default one; elsewhere omit it
```

Scenario `id` is optional. The YAML identifies handlers; it does not establish
that their responses match the API contract. The main skill covers handler
implementation, reproducible error paths, state, and verification through callers.
