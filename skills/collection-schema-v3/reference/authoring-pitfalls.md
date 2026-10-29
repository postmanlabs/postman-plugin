# Authoring pitfalls: entities beyond HTTP collections, and what lint will not catch

Read before hand-writing anything other than an HTTP request, example, definition or
environment. Complete field lists for every kind are in
[other_entities.md](other_entities.md); read it rather than guessing a field name — an
unrecognised key is dropped in silence, so a guess costs you a working request with no
error to show for it.

### Verify with `workspace lint`, not `collection lint`

Unrecognised keys are **dropped, not rejected** — a misspelled or v2.1-carryover key is
silently discarded and the entity runs without it. `collection lint` is the one verb that
will not tell you: `environment lint` and `globals lint` report an unknown field as
`ENV007`, and `workspace lint` reports one in a collection. Only `collection lint` stays
quiet:

| Written | `collection lint` | `workspace lint` |
|---|---|---|
| `body: {mode, raw}` | error `FMT015` | error |
| `$kind` missing or unknown | error `FMT015` / `FMT014` | error |
| `event:` instead of `scripts:` | **silent** | warning `FMT206` |
| `metod:` instead of `method:` | **silent** | warning `FMT206` |
| `dataMode:` / `data:` | **silent** | warning `FMT206` |
| any other unrecognised key in a request | **silent** | warning `FMT206` |
| an unrecognised key in `definition.yaml` | **silent** | warning `FMT208` |

`collection lint` reports `errorCount: 0, warningCount: 0` for all of those — it does not
run the unrecognised-field rules at all, so `-f warning` does not help. This is specific
to collections: an unknown key in an environment or globals file *is* reported, by both
`environment lint`/`globals lint` and `workspace lint`.

```
warning [FMT206]: Unrecognized field "metod" is not part of the Postman Collection
Format v3 schema and will be ignored. (path: /metod)
```

**So always finish with `postman workspace lint`.** It names every key that will be
thrown away, covers every entity in the repo plus the workspace manifest, and is the only
lint verb with `--fix` and `info`/`hint` severities. Treat a clean `collection lint` as
necessary, never sufficient.

For scripts specifically, `postman collection run <dir> --no-report-events` is the
end-to-end proof: `requests`, `test-scripts` and `assertions` should all be non-zero,
since a dropped `scripts` block leaves assertions at 0 while the run still reports green.

Pass `--no-report-events`. The run itself needs no login, but without that flag the CLI
uploads its run report to the cloud afterwards, which fails when you are not signed in
and turns a passing local run into a non-zero exit.

### Key lists accept a map as well as an array

`headers`, collection `variables` and `auth.credentials` take either form, and both lint
clean:

```yaml
headers:
  Content-Type: application/json
variables:
  base_url: https://api.example.com
auth:
  type: bearer
  credentials:
    token: '{{TOKEN}}'
```

Prefer the map: the Postman app writes maps when it round-trips a collection, so
array-form entries get rewritten on the next sync and show up as diff noise. Use the
array form only when an entry needs `description` or `disabled`, which a map cannot
carry:

```yaml
headers:
  - key: X-Trace
    value: '1'
    description: Enables verbose server logging
    disabled: true
```

In the array form, quote values that look numeric or boolean — `value: "400"`.

### `queryParams` and the url query string must agree

This one is symmetric and easy to trip. A url carrying `?a=1&b=2` with no `queryParams`
warns, and a `queryParams` block whose url has no query string warns too:

```text
warning [FMT209] query parameters in url are out of sync with the queryParams
field; keep the url query string and queryParams consistent.
```

So write both, in step:

```yaml
url: '{{base_url}}/search?q=shoes&page=2'
queryParams:
  - key: q
    value: shoes
  - key: page
    value: '2'
```

`collection lint` reports this as a warning, not an error, so a green `errorCount` will
not tell you about it — `postman workspace lint` surfaces it in normal output.

### `$kind` belongs to collection files

Each other entity lives in its own directory with its own discriminator. Getting this
wrong is the most common first-attempt error on these files.

| Entity | Path | Discriminator |
|---|---|---|
| collection | `postman/collections/<name>/` | `$kind: collection`, `<x>-request`, `<x>-example`, `<x>-message` |
| environment | `postman/environments/<n>.environment.yaml` | none — `name` + `values` |
| globals | `postman/globals/<n>.globals.yaml` | none — `name` + `values` |
| dataset | `postman/datasets/<n>/<n>.dataset.yaml` | **`type: dataset`** |
| mock | `postman/mocks/<slug>/config.yaml` | **`version: 1`** |
| spec | `postman/specs/<n>.yaml` | none — plain OpenAPI/AsyncAPI |
| document | `postman/documents/<n>.md` | none — plain Markdown |

**Filenames are validated, not just the directory.** `postman/environments/Staging.yaml`
is rejected — *"Not an environment file. Expected a file ending in .environment.yaml,
.environment.yml, .environment.json"* — and `globals.yaml` likewise needs
`.globals.yaml`. A spec is the exception: it may be a single file or a directory.

#### environment and globals

```yaml
name: Dev
values:
  - key: base_url
    value: https://api.example.com   # value must be a string
    enabled: true
    type: default                    # or "secret"
```

A secret can be marked either way — `type: secret`, or `secret: true` alongside
`type: default`. Both are recognised.

Globals are the same shape, conventionally `name: Globals`. An empty `values: []` is
valid. Validate with `postman environment lint <file>` / `postman globals lint <file>`
— note these take `-o/--output` where `collection lint` takes `-r/--reporter`.

#### dataset

The minimum, which is what `postman dataset create <path> --name X` writes:

```yaml
type: dataset
name: "Users"
id: 3f2b6c1e-9d4a-4f81-bc37-5e0a71d9c402   # uuid4
data_dir: .resources
```

With a file source and a view over it:

```yaml
type: dataset
name: "Sample Fixture"
id: d7c81f43-2e95-4a08-b6d1-9f3e5c07a284
data_dir: .resources
sources:
  - from: embedded_datasource
    datasource:
      name: Records
      id: 5b6a92c8-3d17-4e50-a9f2-81c4e7b0d365
      format: json               # or csv, xlsx, mysql
      source_type: static        # static for files, dynamic for databases
      location:
        type: local_filesystem   # or mysql
        value: rows.json         # relative to data_dir
views:
  - from: embedded_view
    view:
      name: Records_default_view
      id: e2f47a91-6b08-4c3d-95a7-1d8e0f62b4c3
      query: SELECT id, name FROM Records ORDER BY id
```

A database source adds `ingest: false`, `dsKey`, `slug` and `location.table`, and
`location.value` is a DSN. There is no `dataset lint`: use `postman dataset get <path>`
for structure, and `postman dataset query <path> -q "<sql>"` to run SQL against the
source, which also proves the data parses.

#### mock

`postman mock generate --name X` writes `config.yaml` plus a scenario `.js`:

```yaml
version: 1
id: a41c8e05-7f23-4b96-8d0e-3c6a9b25f718
name: Probe Mock
slug: probe-mock
protocol: http
port: 4500
scenarios:
  - name: default
    path: ./default.js
    default: true      # only on the default; omit it elsewhere rather than setting false
```

Scenario `id` is optional. A scenario file is a plain Node HTTP server — nothing
validates its contents, so match the shape the CLI emits:

```js
const http = require('http');
const PORT = process.env.PORT || 4500;

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '', 'http://localhost');
  const pathname = url.pathname;

  // @endpoint GET /health
  if (req.method === 'GET' && pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok' }));
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Endpoint not defined' }));
});

server.listen(PORT);
```

Branch on `req.headers['x-mock-response-code']` to let a caller select an error path
from a single scenario. Validate by running `postman mock run <config.yaml>`, or drive
it from a collection with `postman collection run <dir> --mock <config.yaml>`.

#### The workspace manifest — let the CLI own it

`.postman/resources.yaml` maps local paths to workspace ids. **Do not hand-author it.**
`postman init` creates it, and `workspace push` / `mock push` add and update the
mappings. The only routine hand-edit is deleting a line after a workspace entity is removed,
since a workspace delete leaves the mapping behind.

When you do need to read or repair it: collections map to a **directory**, the other
registered entities map to the path the CLI wrote (normally a **file**; datasets are not
registered), paths are relative to `.postman/` so they begin `../`, and ids
come either owner-prefixed (`12345678-<uuid>`) or as bare 24-character hex — both work.

```yaml
workspace:
  id: 6d3e9a17-4c80-4f25-b1a9-7e02c58d3f64
cloudResources:
  collections:
    ../postman/collections/My API: 12345678-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
  environments:
    ../postman/environments/Dev.environment.yaml: 12345678-6d3e9a17-4c80-4f25-b1a9-7e02c58d3f64
```

A registered entity that exists in the workspace but is missing here makes `workspace push`
plan a *create*, which then fails `404 The target resource was not found` and leaves the
workspace copy stale.

### Request kinds beyond HTTP

`folder` and `collection` share `$kind: collection` — a folder's
`.resources/definition.yaml` is distinguished only by sitting deeper in the tree, and may
also carry `order`.

**`$kind` must match the file type.** `http-example` is rejected in a `*.request.yaml`
and accepted in a `*.example.yaml` under
`.resources/<request-name>.resources/examples/`. Only `*.request.yaml` files are
discovered as requests; a request-shaped file under any other name is skipped silently.

#### Script `type` differs by scope

- on a request: `beforeRequest`, `afterResponse`
- on a collection or folder: protocol-prefixed — `http:beforeRequest`,
  `http:afterResponse`, `graphql:beforeQuery`, `grpc:beforeInvoke`, …

A bare value at collection scope, or a prefixed one at request scope, is dropped
silently.

#### Fields that are strings when they look like structures

- `mcp-request.message` — a JSON-RPC envelope as a **string**; `{{variables}}`
  interpolate inside it.
- `websocket-request.messages` and `mqtt-request.messages` — a **string** path to a
  messages directory holding `*.message.yaml` files, alongside the `examples`
  convention. An array fails with `Invalid input: expected string, received array`.
- `llm-request.mcpConfig` — a **string** containing a JSON **array**, not nested YAML
  and not `mcp.json`'s `mcpServers` object.

#### `mcp-request`

Requires `$kind` and `transport`, and `transport` selects which other keys are legal.
The only values are `stdio` and `sse`.

```yaml
$kind: mcp-request
transport: stdio           # command + env; no url
command: uvx some-mcp-server
env:
  API_KEY: '{{KEY}}'
message: |-
  {"method": "tools/call", "params": {"name": "do_thing", "arguments": {}}}
order: 1000
```

```yaml
$kind: mcp-request
transport: sse             # url + headers; no command
url: https://mcp.example.com/sse
headers:
  Authorization: 'Bearer {{KEY}}'
message: |-
  {"method": "tools/list"}
```

#### `llm-request`

Only `$kind` is required, so lint cannot catch a half-written one. `config` needs
`model` and `provider`, both free-form strings with no fixed list, so a typo lints clean.

> Prompt entries take **`contentType`**, not `type`. Both lint clean, so nothing warns
> you — but `contentType` is the defined field and `type` is unrecognised, so it is
> dropped and the content type is lost. This is the single most common error in the
> whole format: `type` reads natural and is silently wrong.

```yaml
$kind: llm-request
url: https://api.openai.com/v1/chat/completions
config:
  model: gpt-5
  provider: openai
settings:
  temperature: 0.2
  maxToken: 2048
  maxSteps: 16             # raise it when a long tool chain must complete
userPrompts:
  - id: '1'
    value: Summarise the last 10 orders
    timestamp: 1758412800000   # a number — do not quote it
    active: true
    contentType: text
mcpConfig: |-
  [
    {
      "name": "my-server",
      "config": {"command": "uvx", "args": ["my-mcp-server"]},
      "enabled": true,
      "disabledTools": []
    }
  ]
enabledTools:
  - some_tool
auth:
  type: bearer
  credentials:
    token: '{{OPENAI_API_KEY}}'
order: 1000
```

`clientTools`, for tools the model may call without an MCP server, is
`[{id, tools: [{id}]}]`.

#### Per-kind `settings` blocks

Each kind has its own closed `settings` list — they do **not** share the HTTP request's
keys. Writing a key from the wrong kind means it is dropped in silence.

| Kind | `settings` keys |
|---|---|
| `http-request` | `protocolVersion` (`auto`\|`http1`\|`http2`), `strictSSL`, `followRedirects`, `maxRedirects`, `disabledSystemHeaders` |
| `socket.io-request` | `version` (**`"2"`**\|**`"3"`**\|**`"4"`**, strings), `path`, `handshakeTimeout`, `retryCount`, `retryDelay`, `strictSSL` |
| `websocket-request` | `handshakeTimeout`, `retryCount`, `maxPayload`, `retryDelay`, `strictSSL` |
| `mqtt-request` | `cleanSession`, `keepAlive`, `autoReconnect`, `connectionTimeout`, `strictSSL` |
| `llm-request` | `temperature`, `maxToken`, `maxSteps`, `topP`, `topK`, `seed`, `presencePenalty`, `frequencyPenalty`, `repetitionPenalty`, `contextWindow`, `streamResponse`, `streamTools`, `responseFormatJSON` |
| `graphql-request` | `disabledSystemHeaders` |
| `grpc-request` | `secureConnection`, `strictSSL`, `serverNameOverride`, `maxResponseMessageSize`, `includeDefaultFields`, `connectionTimeout` |
| `mcp-request` | `version`, `requestTimeout`, plus `strictSSL` and `sessionTimeout` on `sse` only |

**`disabledSystemHeaders` takes a closed list of lowercase header names**, not free
text: `cache-control`, `postman-token`, `content-type`, `content-length`, `accept-encoding`, `user-agent`, `connection`, `accept`, `host`. `- User-Agent`
is rejected outright.

**Quote a numeric-looking value only where the field is a string.** The two fields
named `version` are the trap, because they disagree:

| Field | Type | Write |
|---|---|---|
| `socket.io-request` → `settings.version` | **string** | `version: '4'` |
| `mqtt-request` → `version` (top level, not in `settings`) | **number** | `version: 5` |

`version: 4` is rejected for Socket.IO and `version: '5'` is rejected for MQTT — the
only MQTT values are `4` and `5`. Beyond those, `timestamp`, `port`, `order`,
`maxToken`, `retryCount`, `handshakeTimeout` and `qos` are all numbers, and quoting
*them* fails with `Invalid input: expected number, received string`.

#### `graphql-request`

Has no `queryParams` field — put query-string parameters in the `url`. Its `schema`
block is a tagged union; write exactly one branch:

```yaml
schema:
  source: auto            # or none
```
```yaml
schema:
  source: file
  location: ./schema.graphql
```

#### `grpc-request`

`url` plus `methodPath` (e.g. `helloworld.Greeter/SayHello`), with `methodDescriptor`
for an inline definition, `message` for the request body, and `metadata` for per-call
headers.

### Examples

An example's `response` **requires** `body`, so a 204 still needs
`body: {type: text, content: ''}` rather than omitting it. `response.body.type` accepts
`text`, `json`, `xml`, `html`, `javascript` and `yaml` — there is no `urlencoded` on a
*response*, so carry a form-encoded payload as `type: text` with a matching
`Content-Type` header. Request bodies do have `urlencoded`.

### Specs

A spec may be one file or a directory, but **`$ref` does not resolve across documents**.
Splitting `index.yaml` and `components.yaml` fails whichever form you use —
`'#/components/schemas/X'`, `'./components.yaml#/components/schemas/X'` and
`'components.yaml#/components/schemas/X'` all report *"does not exist"*. Keep
`components` inline in the same document as the paths that reference it.

`postman spec lint` reports governance findings alongside validity ones, and it reports
them at **ERROR** severity. A perfectly valid spec with no `security` block still fails
with *"Security field is not defined"*, issue type `Governance`. So severity alone does
not tell you whether the spec is well-formed — read the `issue type` column, and treat
only `Validation` findings as format errors.
