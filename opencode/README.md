# Postman for OpenCode

Postman's agent skills and hosted MCP server as an OpenCode local plugin: design,
mock, test, monitor and document APIs, and deploy and debug Postman Flows, from
your OpenCode session.

## Install

Requires OpenCode 1.18.29 or later, and `git`. The plugin is a clone of this
repository plus a one-line file in OpenCode's `plugins/` directory, which
OpenCode loads at startup. Nothing is installed from npm.

For every project (global):

```bash
git clone https://github.com/postmanlabs/postman-plugin ~/.config/opencode/postman-plugin
```

```bash
mkdir -p ~/.config/opencode/plugins && echo "export { default } from '../postman-plugin/opencode/src/index.ts';" > ~/.config/opencode/plugins/postman.ts
```

For one project only, run these from the project root instead:

```bash
git clone https://github.com/postmanlabs/postman-plugin .opencode/postman-plugin
```

```bash
mkdir -p .opencode/plugins && echo "export { default } from '../postman-plugin/opencode/src/index.ts';" > .opencode/plugins/postman.ts
```

Restart OpenCode after either. Install it one way, not both — two clones
register every skill twice.

To update, pull the clone:

```bash
git -C ~/.config/opencode/postman-plugin pull
```

To uninstall, delete `plugins/postman.ts` and the `postman-plugin` clone.

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
one of them. OpenCode 2 keeps the one already defined; on OpenCode 1 which one
wins is not guaranteed, so rename one of the two.

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

The plugin lives in the
[postmanlabs/postman-plugin](https://github.com/postmanlabs/postman-plugin)
repository, which serves the same skills to every agent it supports. See its
README's "The OpenCode plugin" section for tests and releases.

## License

Apache-2.0
