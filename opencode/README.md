# Postman for OpenCode

Postman's agent skills and hosted MCP server as an OpenCode plugin: design,
mock, test, monitor and document APIs, and deploy and debug Postman Flows, from
your OpenCode session.

## Install

OpenCode 2:

```bash
opencode plugin add @postman/opencode-plugin
```

OpenCode 1.18.29 or later:

```bash
opencode plugin @postman/opencode-plugin --global
```

On OpenCode 1, omit `--global` to add it to the current project only.
OpenCode 2's `plugin add` always writes the global config. Either way OpenCode
installs the package the next time it starts.

## What it adds

- **Skills** — every skill in
  [`skills/`](https://github.com/postmanlabs/postman-plugin/tree/main/skills),
  under OpenCode's own un-namespaced names. `api-engineer` is the entry point
  and routes to the rest.
- **The Postman MCP server** — `https://mcp.postman.com/minimal`, registered as
  `postman`.
- **Session guidance** — a short system instruction that points API work at
  `api-engineer`. Your own instructions, such as `AGENTS.md` and direct
  requests, take precedence over it.

The plugin never overwrites your configuration. If you already define an MCP
server named `postman`, the plugin leaves it as it is.

OpenCode skill names share one namespace. If another plugin or your own config
already provides a skill with the same name as one of these, OpenCode loads only
one of them.

## Sign in

The MCP server asks an unauthenticated client to sign in with OAuth, and
OpenCode opens that flow on its own. If the browser prompt never appears, run:

```bash
opencode mcp auth postman
```

## Data sent to Postman

MCP tool calls go to Postman's hosted server and identify themselves as
`postman-opencode-plugin`. The skills also run Postman CLI commands that report
usage by default. See
[Data sent to Postman](https://github.com/postmanlabs/postman-plugin#data-sent-to-postman)
for what is sent and how to opt out.

## Contributing

The package is built from the
[postmanlabs/postman-plugin](https://github.com/postmanlabs/postman-plugin)
repository, which serves the same skills to every agent it supports. See its
README's "The OpenCode package" section for tests and releases.

## License

Apache-2.0
