<div align="center">

<a href="https://www.postman.com/"><img src="https://assets.getpostman.com/common-share/postman-logo-horizontal-320x132.png" alt="Postman" width="240" /></a>

# Postman Plugin
**Powering API engineering for agents**

The Postman plugin brings filesystem-first API development and organization-wide
API context to coding agents. It enables agents to design, mock, test, document,
monitor, and ship APIs directly from Claude Code, Cursor, and Codex. Every
operation produces inspectable files or CLI commands that fit naturally into
Git and CI, while the Postman Context Graph helps agents understand
dependencies, ownership, runtime behavior, and the likely impact of a change.

[Install](#install) · [Highlights](#highlights)

</div>

## Install

Install Postman in every compatible coding agent detected on your machine:

```bash
npx @postman/postman-plugin
```

One command configures **Claude Code, Codex, Cursor, Factory Droid, Kimi Code,
OpenCode and Pi**. Run it again to update, `status` to see what's installed,
and `remove` to uninstall; `--agent <id>` limits any of them to one agent.

You can also use the following commands to install individually:

### Claude Code

[View Postman on Claude Plugins](https://claude.com/plugins/postman)

```bash
claude plugin marketplace add anthropics/claude-plugins-official
claude plugin install postman@claude-plugins-official
```

The first command registers Anthropic's official marketplace, which a fresh
Claude Code doesn't have until an interactive session gets past sign-in. It
does nothing where the marketplace is already registered.

### Codex

[View Postman on ChatGPT Plugins](https://chatgpt.com/plugins/postman?open_in_app)

```bash
codex plugin marketplace add postmanlabs/postman-plugin
codex plugin add postman@postman
```

### Cursor

[View Postman on the Cursor Marketplace](https://cursor.com/marketplace/postman)

```text
/add-plugin postman
```

### Factory Droid

```bash
droid plugin marketplace add https://github.com/postmanlabs/postman-plugin.git
droid plugin install postman@postman-plugin --scope user
```

`droid plugin marketplace update postman-plugin`, then
`droid plugin update postman@postman-plugin --scope user`, updates it. Sign in
to Postman's MCP server with `/mcp` inside a Droid session.

### Kimi Code

Inside a Kimi Code session:

```text
/plugins install https://github.com/postmanlabs/postman-plugin/tree/main
```

Then run `/new` to start a session with the plugin. Run the same command again,
then `/new`, to update; `/plugins remove postman` removes it. Sign in to
Postman's MCP server with `/mcp-config login plugin-postman:postman`.

### OpenCode

OpenCode installs Postman from the newest release of
[postmanlabs/opencode-plugin](https://github.com/postmanlabs/opencode-plugin):

```bash
opencode plugin add "github:postmanlabs/opencode-plugin#semver:*"
```

Keep the quotes: without them your shell expands the `*`. Restart OpenCode
afterwards. OpenCode 1 picks up a new release each time it starts; OpenCode 2
marks the plugin "update available" in its plugins view, where you apply it.
To check it loaded, ask OpenCode to "set up
Postman in this repo": it should load the `bootstrap` skill and run the Postman
CLI.

| | OpenCode 2 (`@opencode/cli`) | OpenCode 1 (`opencode-ai`) |
| --- | --- | --- |
| Command | `opencode plugin add <spec>` | `opencode plugin --global <spec>` |
| Needs | 2.0.4 | 1.14.33 |
| Remove | `opencode plugin remove <spec>` | delete the entry from `plugin` in whichever of `~/.config/opencode/opencode.json` or `opencode.jsonc` holds it, then restart |

It needs `git`. Install it one way only: two installs register every skill
twice.

### Pi

[View Postman in Pi's package gallery](https://pi.dev/packages/@postman/postman-plugin)

```bash
pi install npm:@postman/postman-plugin
```

`pi update npm:@postman/postman-plugin` updates it. Sign in to Postman's MCP
server with `/mcp login postman` inside a Pi session. The shell's `pi mcp login`
doesn't load extensions, so it reports no server named `postman`.

## Highlights

### Filesystem-first API development

All postman resources have a filesystem representation, so your agent can work
with the API ecosystem through the interface it understands best: files. API
specifications, collections, environments, examples, mocks, documentation,
and Flows can live beside the application code.

The git-native [v3 collection schema](skills/collection-schema-v3/) makes this
especially agent-friendly. A collection is a directory tree under
`postman/collections/`, where every request, folder definition, and saved
example is its own YAML file. Environments use the same file-first model under
`postman/environments/`. HTTP, GraphQL, gRPC, WebSocket, Socket.IO, MQTT, MCP,
and LLM requests all have defined schemas the agent can follow.

That means the agent can:

- Read or change one request without rewriting a large collection export.
- Generate requests and examples directly from an API specification.
- Produce small, reviewable Git diffs and resolve changes with normal code
  review workflows.
- Lint and test the files locally before anything is shared with a Postman
  workspace.


### Context Graph: know what breaks before you make a change

A repository can show what an endpoint calls, but rarely who calls it, whether
those consumers are active in production, where they are deployed, or which
team owns them. The Context Graph fills that gap with a private, authenticated,
organization-wide map of your API ecosystem.

It reconciles signals from the systems where API knowledge already lives:

- **Postman workspaces:** specifications, collections, monitors, and mocks
- **GitHub:** repositories, API definitions, and source-level call sites
- **New Relic:** deployments, runtime traffic, latency, errors, and telemetry

The [`api-discovery`](skills/api-discovery/) skill lets the agent start with the
thing you plan to change and ask one natural-language question:

```bash
postman context-graph ask "What could break if we change the billing API?" --wait
```


The graph discovers the surrounding scope—including repositories that are not
checked out locally—before the agent starts editing code. It refreshes nightly
as services, deployments, ownership, and runtime relationships change.

In Postman's controlled benchmark across 468 repositories, starting with this
map used **up to 74% fewer tokens, 52% fewer tool calls, and 72% lower cost**.
Accuracy also improved in 18 of 21 scored prompt-model pairs. Most graph
queries completed in roughly 20–40 seconds. Read the methodology and results in
[Introducing the Context Graph API: One Map of Your API Ecosystem](https://blog.postman.com/introducing-the-context-graph-api-one-map-of-your-api-ecosystem/).

### File-first API mocks

The [`api-mocking`](skills/api-mocking/) skill creates a working mock from an
OpenAPI specification or collection and stores the implementation beside the
API code. The agent can run it locally, add success and failure scenarios, and
test consumers without waiting for the real service to be ready or available.

The mock stays local until you choose to push and deploy it. When teammates or
external systems need access, the same mock can become a durable hosted URL
without rebuilding it in another tool.

### Develop against simulated dependencies

The [`api-simulation`](skills/api-simulation/) skill is the local loop for a
service change: find every dependency the service calls, mock each one (reusing
the owning team's mock when they publish one), serve them on one port from one
`.sim.yaml`, run the real service against them, test, and push. It needs
Postman CLI 1.70.0 or later:

```bash
postman simulation run postman/simulations/orders-dev.sim.yaml --port 4900
```

The service under test is never mocked. It runs for real, so a passing run
shows the change works against what the mocks model; it doesn't replace a run
against the real upstreams. The simulation can also run in CI, and any
dependency can take injected latency, error, rate-limit, or chaos conditions to
exercise failure paths.


## How Postman builds context

Work done in a Postman folder produces artifacts: collection runs, lint
results, request history, mock deployments. When that folder is connected to a
Postman workspace after `postman init`, those artifacts are published to it as
they are produced. The workspace persists that context for future work and
enables teammates, reviewers, and other agents to share and build on what the
agent did.

What each command contributes to the connected workspace:

| Command | What it publishes |
| --- | --- |
| `postman collection run` | Run results and run history |
| `postman application test` | Test run results |
| `postman spec lint` | Lint results, including violation counts and pass/fail |
| `postman workspace push` | Local workspace contents, persisted as context for future work and sharing with others |
| `postman runner start` | Runner processing and health activity |
| `postman flows run` | Flow run results |
| `postman request` | Agent's API interaction activity |


Publishing happens by default. To change this workflow, you can set 
`--report-events=false` per invocation.

### Anonymous usage counts

The CLI records command usage surface — a minimal,
unauthenticated count with no workspace, user, or payload attached.

### The MCP fallback

The plugin registers Postman's hosted MCP server as a fallback for when the CLI
cannot run. MCP tool calls reach Postman by design and are not governed by the
CLI flags above; skip installing the MCP server if you do not want that path.

## License

Apache-2.0 — see [LICENSE](LICENSE).
