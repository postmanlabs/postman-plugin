# Postman for OpenCode

Postman's agent skills for OpenCode, built on the Postman CLI: design, mock,
test, monitor and document APIs, and deploy and debug Postman Flows from your
OpenCode session, using the same `postman` commands you would run yourself.

## Install

Install it with OpenCode's own plugin command, from this repository:

```bash
opencode plugin add github:postmanlabs/postman-plugin
```

or from npm, which carries the latest installer release rather than `main`.
This works from the first installer release after 0.2.1, which is the first to
ship the plugin entrypoint:

```bash
opencode plugin add @postman/postman-plugin
```

Restart OpenCode after either. To check it loaded, ask OpenCode to "set up
Postman in this repo": it should load the `bootstrap` skill and run the Postman
CLI.

| | OpenCode 2 (`@opencode/cli`) | OpenCode 1 (`opencode-ai`) |
| --- | --- | --- |
| Command | `opencode plugin add <spec>` | `opencode plugin --global <spec>` |
| `github:postmanlabs/postman-plugin` needs | 2.0.4 | 1.14.33 |
| `@postman/postman-plugin` needs | 2.0.4 | 1.14.22 |
| Remove | `opencode plugin remove <spec>` | delete the entry from `plugin` in whichever of `~/.config/opencode/opencode.json` or `opencode.jsonc` holds it, then restart |

Both need `git` only for the `github:` form. Install it one way: the older
clone below, or `plugin add` twice, registers every skill twice.

### Install from a clone

Requires OpenCode 1.18.32 or later, and `git`. The plugin is a clone of this
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
