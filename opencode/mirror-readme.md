# Postman for OpenCode

**API Engineering for Agents.** Postman brings agentic software development to
APIs. It equips OpenCode with specialized skills for the complete API lifecycle:
discover, design, test, document, mock, monitor, and improve APIs through
agent-friendly, filesystem-first workflows, built on the same `postman` CLI
commands you would run yourself.

## Install

<!-- The OpenCode section of postman-plugin's README.md goes here; scripts/build-mirror.js inserts it. -->

### Install from a clone

The older install, which still works. Requires OpenCode 1.18.32 or later, and
`git`. The plugin is a clone of
[postmanlabs/postman-plugin](https://github.com/postmanlabs/postman-plugin)
plus a one-line file in OpenCode's `plugins/` directory, which OpenCode loads at
startup. Nothing is installed from npm. Don't install it beside `plugin add`:
both register every skill.

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

Restart OpenCode after either.

To update, pull the clone:

```bash
git -C ~/.config/opencode/postman-plugin pull
```

To uninstall, delete `plugins/postman.ts` and the `postman-plugin` clone.

## What it adds

- **Skills** — every skill in
  [`skills/`](https://github.com/postmanlabs/postman-plugin/tree/main/skills),
  under OpenCode's own un-namespaced names. They do the work through the
  Postman CLI, which the `bootstrap` skill installs the first time a task needs
  it. `api-engineer` is the entry point and routes to the rest.
- **Session guidance** — a short system instruction that points API work at
  `api-engineer`. Your own instructions, such as `AGENTS.md` and direct
  requests, take precedence over it.

Where the CLI can't run, the skills fall back to Postman's hosted MCP server,
which the plugin registers as `postman`. The plugin never overwrites your
configuration: if you already define an MCP server named `postman`, it leaves
it as it is.

OpenCode skill names share one namespace. If another plugin or your own config
already provides a skill with the same name as one of these, OpenCode loads only
one of them. OpenCode 2 keeps the one already defined; on OpenCode 1 which one
wins is not guaranteed, so rename one of the two.

## Sign in

Local work, such as setting up a repository with `postman init` or running a
mock on your machine, needs no Postman account. When a task reaches your
Postman workspace, the `bootstrap` skill signs the CLI in. To sign in yourself:

```bash
postman login
```

## Data sent to Postman

The Postman CLI commands the skills run report usage by default, and calls
through the MCP fallback go to Postman's hosted server as
`postman-opencode-plugin`. See
[Data sent to Postman](https://github.com/postmanlabs/postman-plugin#data-sent-to-postman)
for what is sent and how to opt out.

## Contributing

The plugin lives in the
[postmanlabs/postman-plugin](https://github.com/postmanlabs/postman-plugin)
repository, which serves the same skills to every agent it supports. See its
[CONTRIBUTING.md](https://github.com/postmanlabs/postman-plugin/blob/main/CONTRIBUTING.md#the-opencode-plugin)
for tests and releases.

## License

Apache-2.0
