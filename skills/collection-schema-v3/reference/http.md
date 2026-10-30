# HTTP collection files

Read when authoring HTTP request, example, or definition YAML. These field
shapes distinguish v3 files from exported collection JSON; validate edits with
collection lint before relying on the result.

## Definition file (`.resources/definition.yaml`)

Optional metadata for a collection or folder:

- `$kind: "collection"` — required, even for a folder's definition.
- `name` — optional, defaults to the filesystem folder name.
- `description` — optional.
- `variables` — array of `{key, value, description?, disabled?}`. `value`
  must be a string; `disabled` a boolean. A map of name to value is also
  accepted when no entry needs `description` or `disabled`.
- `auth` — a single auth object `{type, credentials: [{key, value}, ...]}`
  (`credentials` may also be a map of name to value), or an array for multiAuth: `[{id, name, type, credentials, rules?}, ...]`.
- `scripts` — array of `{type, code, language: "text/javascript"}`. `type`
  is one of `http:beforeRequest`, `http:afterResponse`,
  `graphql:beforeQuery`, `graphql:afterResponse`, `grpc:beforeInvoke`,
  `grpc:onIncomingMessage`, `grpc:afterResponse`.
- `order` — number, used for folder ordering.

## Key lists

`headers`, collection `variables`, and `auth.credentials` accept maps as well
as arrays. The app writes maps when round-tripping collections, so maps can
avoid representation-only diffs. Preserve entry metadata when choosing a form:
arrays can carry fields such as `description` or `disabled` that a map cannot.
Quote numeric- or boolean-looking values where the field requires a string.

## HTTP request (`*.request.yaml`)

- `$kind: "http-request"` — required.
- `name` — optional (see naming rules below for when to include it).
- `order` — number; only used for relative comparison, so space values out
  (e.g. multiples of 1000) rather than packing them tight — a later
  insertion between two requests shouldn't force renumbering every sibling.
- `url` — string, with `{{varName}}` variable syntax.
- `method` — `GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS`.
- `headers` — array of `{key, value, description?, disabled?}`. A map of
  header name to value is also accepted when no entry needs `description` or
  `disabled`.
- `queryParams` — array of `{key, value, description?, disabled?}`.
- `pathVariables` — array of `{key, value, description?}`.
- `body` — `{type, content}`; `type` required whenever `body` is present.
  - Types: `json`, `formdata`, `urlencoded`, `text`, `xml`, `html`,
    `javascript`, `file`, `none`.
  - `json`/`text`/`xml`/`html`/`javascript`: `content` is a string.
  - `formdata`: `content` is an array of
    `{key, type: "text"|"file", value or src, contentType?, description?}`.
  - `urlencoded`: `content` is an array of `{key, value, description?}`.
- `auth` — `{type, credentials}`.
- `settings` —
  `{protocolVersion?, strictSSL?, followRedirects?, maxRedirects?, disabledSystemHeaders?}`.
- `scripts` — array of `{type: "beforeRequest"|"afterResponse", code, language: "text/javascript"}`.
- `examples` — optional, a relative path to the examples directory, e.g.
  `./.resources/<request-name>.resources/examples/`.

Keep `queryParams` and the URL query string consistent so consumers see the
same parameters in either representation (`FMT209`). Review lint warnings,
not just the error count. For example:

```yaml
url: '{{base_url}}/search?q=shoes&page=2'
queryParams:
  - key: q
    value: shoes
  - key: page
    value: '2'
```

## HTTP example (`*.example.yaml`)

- `$kind: "http-example"` — required.
- `name` — optional.
- `request: {url, method}`.
- `response: {statusCode, statusText, headers: [{key, value}], body: {type, content}}`.
- `order` — optional.

An example response requires `body`, even for a 204:
`body: {type: text, content: ''}`. See
[response body types](other_entities.md#examples) when the payload is not JSON.

Saved examples are what `collection ai-readiness` checks for — a request
with no examples scores worse for agent consumption even if perfectly
valid structurally.

## Environments (`postman/environments/*.environment.yaml`)

Environment files are v3 YAML but are not collection entities: they do not use
`$kind`. Before creating or editing one by hand, read
[reference/environment.md](environment.md) for the schema, secret
handling, CLI-first edit commands, and a linted example.

## YAML rules

YAML parsing and scalar coercion can change a field's meaning before schema
validation. Preserve the type the field expects:

1. Single-quote any value containing `{{variables}}`:
   `url: '{{base_url}}/users'` — never leave it unquoted.
2. Single-quote values containing `: # & * ! [ ] { } > |`, e.g.
   `name: 'Health check: v2'`.
3. Multi-line content (JSON bodies, scripts, queries) uses a `|-` block
   scalar:
   ```yaml
   body:
     type: json
     content: |-
       {
         "name": "example"
       }
   ```
4. Quote strings that resemble booleans/numbers when a string is intended:
   `value: "true"`, `value: "123"`.
5. `order` must be a bare number, never quoted: `order: 1000`.
6. Single-quote file paths and use forward slashes only:
   `examples: './.resources/name.resources/examples'`.

## Naming rules

- `<request-name>` (the filename stem before `.request.yaml`) must not
  contain `/ \ : * ? " < > |` — sanitize to `-`.
- Include `name` in the file only when it differs from `<request-name>`
  (e.g. `name: 'Health/check'` inside `Health-check.request.yaml`, since the
  filename itself can't hold the `/`).
- Filenames must be unique, case-insensitively, per directory.

## Worked example: "bookstore api"

`postman/collections/bookstore api/get all books.request.yaml`
```yaml
$kind: http-request
method: GET
url: '{{base_url}}/books'
order: 1000
```

`postman/collections/bookstore api/get-book-by-id.request.yaml`
```yaml
$kind: http-request
name: 'get book by :id'
method: GET
url: '{{base_url}}/books/:id'
order: 2000
pathVariables:
  - key: id
    value: '1'
```

`postman/collections/bookstore api/add new book.request.yaml`
```yaml
$kind: http-request
method: POST
url: '{{base_url}}/books'
order: 3000
headers:
  - key: Content-Type
    value: application/json
body:
  type: json
  content: |-
    {
      "title": "Example Book",
      "author": "Jane Doe"
    }
```

`postman/collections/bookstore api/.resources/definition.yaml`
```yaml
$kind: collection
name: Bookstore API
variables:
  - key: base_url
    value: 'https://api.bookstore.com/v1'
```
