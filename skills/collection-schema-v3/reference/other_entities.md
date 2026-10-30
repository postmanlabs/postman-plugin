# Field reference: request kinds and other entity formats

Consult the section for the entity being changed. These shapes help distinguish
format errors from valid configuration that does not produce the intended behavior.
Schema checks cannot establish credentials, provider availability, or contract fidelity.

- [Auth](#auth), [request bodies](#request-body), and [scripts](#scripts)
- [Request kinds](#request-kinds), [messages](#messages), and [examples](#examples)
- [Datasets](#datasets), [mocks](#mocks), and [environments and globals](#environments-and-globals)
- [Specs](#specs), [documents](#documents), and [SDKs](#sdks)
- [Workspace manifest](#the-workspace-manifest) and [validation](#validating-each-entity)

## Auth

`auth` is available on a collection, a folder, a request and an example. It has two
shapes. No auth:

```yaml
auth:
  type: noauth
```

Anything else takes `type` plus `credentials`:

```yaml
auth:
  type: bearer
  credentials:
    token: '{{TOKEN}}'
```

`type` is one of `basic`, `bearer`, `apikey`, `digest`, `oauth1`, `oauth2`, `jwt`,
`awsv4`, `hawk`, `ntlm`, `asap`, `edgegrid`, `azure`, `sasl`, `inherit`. Use `inherit`
to take the parent folder's or collection's auth explicitly; omitting `auth` entirely
does the same thing.

`credentials` keys are the same names the Postman app shows for that auth type —
`username`/`password` for `basic`, `token` for `bearer`, `key`/`value`/`in` for
`apikey`, `accessKey`/`secretKey`/`region`/`service` for `awsv4`. A structurally
valid credential entry does not establish that the server will authenticate it.
`credentials` accepts a map or an array of `{key, value}`. See the
[HTTP reference's key-list guidance](http.md#key-lists) for choosing a representation.

## Request body

`body` is one shape chosen by `type` — write that branch's keys and nothing else.

```yaml
body: {type: none}
```
```yaml
body:
  type: json          # or text, xml, html, javascript
  content: |-
    {"id": 1}
```
```yaml
body:
  type: urlencoded
  content:
    grant_type: client_credentials     # map, or array of {key, value, disabled?}
```
```yaml
body:
  type: formdata
  content:
    - key: file
      type: file
      src: ./payload.bin
    - key: note
      type: text
      value: hello
      contentType: text/plain
```
```yaml
body:
  type: file
  content:
    src: ./upload.bin       # an object with src, not a bare path
```

Choose `body.type` to match the payload and contract. JSON `content` is a string;
a block scalar keeps it readable without turning it into a YAML object.
A *response* body inside an example has a narrower type list:
see Examples below.

## Scripts

```yaml
scripts:
  - type: afterResponse
    code: |-
      pm.test('ok', () => pm.response.to.have.status(200));
```

`type` is `beforeRequest` or `afterResponse` on a request, and protocol-prefixed on a
collection or folder (`http:beforeRequest`, `http:afterResponse`,
`graphql:beforeQuery`, `grpc:beforeInvoke`, …). A script entry may also carry
`language`, `packages`, and `requests`. `language` takes exactly one value,
**`text/javascript`** — `language: javascript` is a hard error,
`Invalid input: expected "text/javascript"`. Omitting it is fine.

The v2.1 `event:` field is not the v3 `scripts:` field. A script's `type` also
depends on its scope; moving it between a request and a definition requires checking
the type as well as the code. See the main skill's verification guidance for
checking that the intended script behavior survives the edit.

## Request kinds

`$kind` is required on all of these, and it is the *only* required field except on
`mcp-request`, which also requires `transport`. So for every other kind a half-written
request can pass structural checks without being executable. Only `*.request.yaml`
files are discovered as requests; the right fields in a differently named file
do not make it runnable. Each kind has its own settings; HTTP settings do not
apply to every protocol. Common metadata fields `id`, `name`, `description` and `order`
are available on all of them and omitted below.

### `http-request`

`url`, `method`, `headers`, `queryParams`, `pathVariables`, `body`, `auth`, `scripts`,
`examples`, `settings`.

`settings`: `protocolVersion` (`auto`|`http1`|`http2`), `strictSSL`,
`followRedirects`, `maxRedirects`, `disabledSystemHeaders`.

`disabledSystemHeaders` is a closed list of **lowercase** header names, not free text:
`cache-control`, `postman-token`, `content-type`, `content-length`, `accept-encoding`, `user-agent`, `connection`, `accept`, `host`. `User-Agent` is rejected —
`Invalid option: expected one of "cache-control"|…|"host"`.

### `graphql-request`

`url`, `query`, `variables` (a **string** of JSON), `headers`, `auth`, `schema`,
`scripts`, `examples`, `settings`.

There is **no `queryParams`** — put query-string parameters in the `url`.

`settings`: `disabledSystemHeaders` only (same closed list as HTTP — see above).

`schema` is one shape chosen by `source`:

```yaml
schema: {source: none}
```
```yaml
schema: {source: auto}
```
```yaml
schema:
  source: file
  location: ./schema.graphql
```
```yaml
schema:
  source: api
  apiId: <id>
  versionId: <id>          # releaseId optional
```
```yaml
schema:
  source: specification
  specificationId: <id>
```

### `grpc-request`

`url`, `methodPath` (e.g. `helloworld.Greeter/SayHello`), `methodDescriptor` (an inline
proto definition), `message` (`{content}`), `metadata` (per-call headers; map or
array), `auth`, `schema`, `scripts`, `examples`, `settings`.

`settings`: `secureConnection`, `strictSSL`, `serverNameOverride`,
`maxResponseMessageSize`, `includeDefaultFields`, `connectionTimeout`.

### `websocket-request`

`url`, `headers`, `queryParams`, `messages`, `examples`, `settings`.

`messages` and `examples` are **strings** — relative paths to directories, not arrays.
An array fails with `Invalid input: expected string, received array`.

`settings`: `handshakeTimeout`, `retryCount`, `maxPayload`, `retryDelay`, `strictSSL`.

### `socket.io-request`

`url`, `headers`, `queryParams`, `events`, `messages`, `examples`, `settings`.

```yaml
events:
  - name: chat:message
    subscribeOnConnect: true
    description: Inbound chat traffic
```

`settings`: `version` (the **strings** `'2'`, `'3'`, `'4'`), `path`,
`handshakeTimeout`, `retryCount`, `retryDelay`, `strictSSL`. Bare `version: 4` is
rejected — `Invalid option: expected one of "2"|"3"|"4" (path: /settings/version)`.

### `mqtt-request`

`url`, `clientId`, `version`, `topics`, `lastWill`, `properties`, `auth`, `messages`,
`examples`, `settings`.

`version` is a **number**, either `4` or `5`, and it sits at the top level rather than
in `settings`. Do not quote it — that is the opposite of `socket.io-request`, whose
`settings.version` is the string `'2'`, `'3'` or `'4'`.

```yaml
topics:
  - name: sensors/+/temp
    qos: 1                 # a number: 0, 1 or 2
    subscribe: true
lastWill:
  topic: status/client
  payload: offline
  type: text
  qos: 0
  retain: true
```

`properties`: `sessionExpiryInterval`, `receiveMaximum`, `maximumPacketSize`,
`requestResponseInformation`, `userProperties`.

`settings`: `cleanSession`, `keepAlive`, `autoReconnect`, `connectionTimeout`,
`strictSSL`.

### `mcp-request`

Requires `$kind` **and** `transport`, which selects the legal keys. Common to both:
`message`, `auth`.

| `transport` | Its keys | `settings` |
|---|---|---|
| `stdio` | `command`, `env` (map or array) | `version`, `requestTimeout` |
| `sse` | `url`, `headers` | `version`, `requestTimeout`, `strictSSL`, `sessionTimeout` |

There are no other transports. `message` is a JSON-RPC envelope as a **string**;
`{{variables}}` interpolate inside it.

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

### `llm-request`

`url`, `config`, `userPrompts`, `systemPrompts`, `mcpConfig`, `enabledTools`,
`clientTools`, `auth`, `settings`.

`config` takes `model` and `provider`, both free-form strings. Schema validation
does not establish that the configured provider or model is available at run time.

Prompt entries are `{id, value, timestamp, active, contentType}`. The content
format is expressed by `contentType`; `type` is not a prompt-entry field.
`timestamp` is numeric, and `active` is boolean.

`mcpConfig` is a **string containing a JSON array**, not nested YAML and not
`mcp.json`'s `mcpServers` object. `clientTools`, for tools the model may call with no
MCP server behind them, is `[{id, tools: [{id}]}]`.

For example, a prompt and a stdio MCP tool configuration use different scalar
shapes within the same request:

```yaml
userPrompts:
  - id: '1'
    value: Summarise the last 10 orders
    timestamp: 1758412800000
    active: true
    contentType: text
mcpConfig: |-
  [
    {
      "name": "orders",
      "config": {"command": "uvx", "args": ["orders-mcp-server"]},
      "enabled": true,
      "disabledTools": []
    }
  ]
```

`settings`: `temperature`, `maxToken`, `maxSteps`, `topP`, `topK`, `seed`,
`presencePenalty`, `frequencyPenalty`, `repetitionPenalty`, `contextWindow`,
`streamResponse`, `streamTools`, `responseFormatJSON`. If a tool chain stops early,
distinguish a step limit from a tool or provider failure before changing `maxSteps`;
the limit also bounds execution cost and duration.

## Messages

A `messages` directory holds `*.message.yaml` files. Each kind has different required
fields; a valid WebSocket message is not automatically a valid MQTT message.

```yaml
$kind: websocket-message      # requires content + contentType
content: '{"op":"subscribe"}'
contentType: json             # text | json | xml | html | hex | base64
```

```yaml
$kind: socket.io-message      # requires eventName + args
eventName: chat:message
acknowledgement: true
args:
  - content: '{"text":"hi"}'
    contentType: json
```

```yaml
$kind: mqtt-message           # requires content + contentType + topic
topic: sensors/1/temp
content: '21.5'
contentType: text             # text | json | hex | base64
qos: 1
retain: false
```

## Examples

Examples live in `.resources/<request-name>.resources/examples/*.example.yaml`, with
`$kind` matching the request's protocol — `http-example`, `graphql-example`,
`grpc-example`, `websocket-example`, `socket.io-example`, `mqtt-example`. An
`*-example` kind is rejected in a `*.request.yaml`, and a `*-request` kind is rejected
in a `*.example.yaml`.

`http-example` requires `$kind` and `response`, and `response` requires `body`:

```yaml
$kind: http-example
name: 200 OK
request:
  method: POST
  url: https://api.example.com/orders
  headers:
    Content-Type: application/json
  body:
    type: json
    content: '{"sku":"A1"}'
response:
  statusCode: 200
  statusText: OK
  headers:
    Content-Type: application/json
  body:
    type: json
    content: '{"id":"o_1"}'
order: 1000
```

[HTTP examples](http.md#http-example-exampleyaml) describe the required response
body, including empty responses. Response `body.type` accepts only `text`, `json`, `xml`, `html`, `javascript` and `yaml`; there is **no
`urlencoded` on a response**, so carry a form-encoded payload as `type: text` with a
matching `Content-Type` header. Request bodies do have `urlencoded`.

## Datasets

See **datasets** for dataset YAML, source and view configuration, and query
verification. Dataset files have a separate schema from collection entities.

## Mocks

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
that their responses match the API contract. See **api-mocking** for handler
implementation, reproducible error paths, state, and verification through callers.

## Environments and globals

The [environment reference](environment.md#file-and-fields) owns the shared
`name` and `values` schema and secret handling. Globals use the same shape,
conventionally `name: Globals`, with a `*.globals.yaml` filename under
`postman/globals/`. An empty `values: []` is valid.

The filename suffix identifies the entity: environment files use
`*.environment.yaml`, globals use `*.globals.yaml`; neither uses `$kind`.
Use `postman globals lint <file>` for globals. Environment and globals lint
both accept `-o/--output`, where collection lint accepts `-r/--reporter`.

## Specs

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

## Documents

`postman/documents/<name>.md`, plain Markdown, no front matter and no wrapper. Nothing
validates a document; it is pushed and pulled as-is.

## SDKs

An SDK is configured in `.postman/config.json`, not under `postman/`. Generate with
`postman sdk generate`, which is also the only validation.

## The workspace manifest

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

## Validating each entity

| Entity | Command |
|---|---|
| collection | `postman collection lint <dir> -r json` |
| environment / globals | `postman environment lint <file>` / `postman globals lint <file>` |
| spec | `postman spec lint <path>` |
| dataset | see **datasets** for structure and query checks |
| mock | `postman mock run <config.yaml>` |
| sdk | `postman sdk generate` |
| document | none |
| everything, plus the manifest | `postman workspace lint` |

Choose checks for the entity and intended outcome. Workspace lint is useful for
relationships across entities and manifest mappings; it need not follow every
entity-specific lint. Review warnings as well as errors, and distinguish format
findings from runtime failures. A successful mock start or SDK generation does
not establish contract fidelity or correct consumer behavior.
