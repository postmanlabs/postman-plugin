# Postman for Agents

Postman's skills for coding agents, built on the Postman CLI. Design, mock,
test, monitor and document APIs, run checks in CI, and deploy and debug Postman
Flows from your agent, using the same `postman` commands you would run yourself.

**Install for your agent:**
[Claude Code](#claude-code) ·
[Cursor](#cursor) ·
[Codex](#codex) ·
[Kimi Code](#kimi-code) ·
[OpenCode](#opencode)

## What you get

- **Skills that drive the Postman CLI.** Your agent loads them when a task
  needs them: setting up Postman in a repository, mocking an API before it
  exists, testing and load-testing it, monitoring a live endpoint, adding
  Postman checks to CI, publishing API docs, scoring a spec for AI readiness,
  and running Postman Flows. The work happens as real `postman` commands, so
  you can read them, rerun them, and put them in CI as they are.
  `api-engineer` is the entry point and routes to the rest; see
  [`skills/`](skills/) for the full set.
- **The Postman CLI, set up for you.** You don't install it first. The
  `bootstrap` skill installs it the first time a task needs it, with npm or
  Postman's platform installer
  ([install options](skills/bootstrap/reference/cli_installation.md)), and
  links the repository to a Postman workspace when you want one.
- **Session guidance.** On agents that support it, a short always-on
  instruction that points API work at `api-engineer`. Your own instructions,
  such as `AGENTS.md`, take precedence.

Where the CLI can't run at all, such as a hosted session with no shell or no
Node.js, the skills fall back to Postman's hosted MCP server, which the plugin
also registers.

## Install

Pick your agent. Each one gets the same skills.

| Agent | How it installs |
| --- | --- |
| [Claude Code](#claude-code) | Plugin marketplace |
| [Cursor](#cursor) | `npx plugins add` |
| [Codex](#codex) | Plugin marketplace |
| [Kimi Code](#kimi-code) | `npx plugins add` |
| [OpenCode](#opencode) | Local plugin: a clone of this repository plus a one-line loader file |

### Claude Code

```
/plugin marketplace add postmanlabs/postman-plugin
/plugin install postman@postman
```

### Cursor

```bash
npx plugins add postmanlabs/postman-plugin
```

### Codex

```bash
codex plugin marketplace add postmanlabs/postman-plugin
```

```bash
codex plugin add postman@postman
```

The `marketplace add` step is required.

### Kimi Code

```bash
npx plugins add postmanlabs/postman-plugin
```

### OpenCode

**OpenCode installs this as a local plugin, not from npm.** You clone this
repository into OpenCode's config directory and add a one-line file that tells
OpenCode to load it. Nothing else is installed.

**You need:** OpenCode 1.18.29 or later, and `git`.

1. Clone this repository into OpenCode's config directory:

   ```bash
   git clone https://github.com/postmanlabs/postman-plugin ~/.config/opencode/postman-plugin
   ```

2. Add the loader file to OpenCode's `plugins/` directory:

   ```bash
   mkdir -p ~/.config/opencode/plugins && echo "export { default } from '../postman-plugin/opencode/src/index.ts';" > ~/.config/opencode/plugins/postman.ts
   ```

3. Restart OpenCode.

4. Check it loaded: open a repository in OpenCode and ask it to "set up
   Postman in this repo". It should load the `bootstrap` skill and run the
   Postman CLI.

That installs it for every project. To update it, pull the clone:

```bash
git -C ~/.config/opencode/postman-plugin pull
```

To install it for a single project instead, or to uninstall it, see the
[OpenCode install guide](opencode/README.md). Install it one way only: two
copies register every skill twice.

## Sign in to Postman

Local work needs no Postman account: setting up a repository with
`postman init`, or generating and running a mock on your machine, works signed
out. When a task reaches
your Postman workspace, the `bootstrap` skill signs the CLI in, with
`POSTMAN_API_KEY` if it is set and in your browser otherwise. To sign in
yourself:

```bash
postman login
```

## Get started

Open a repository in your agent and describe the API work you want done, for
example:

- "Set up Postman in this repo."
- "Mock this OpenAPI spec so the frontend can start today."
- "Add a Postman collection run to our CI."
- "Set up a monitor for our production health endpoint."

The agent picks the right skill on its own.

## Data sent to Postman

Postman CLI commands these skills run report to Postman by default. There are
two separate paths, and only one of them can be turned off.

### Declinable: `--no-report-events`

Seven commands send analytics — and in `application test`'s case the run
results too — unless you opt out:

| Command | Sent by default |
| --- | --- |
| `postman collection run` | Run analytics (see the note below on run history) |
| `postman application test` | Run results and analytics |
| `postman spec lint` | Lint analytics (violation counts, pass/fail) |
| `postman workspace push` | Push analytics |
| `postman runner start` | Runner analytics |
| `postman flows run` | Flow run analytics |
| `postman request` | Request analytics |

**Use the command-specific opt-out spelling shown above.** `application test`
uses `--report-events=false`; `runner start` and `flows run` use
`--no-report-events`. Do not substitute one spelling for another.

**`collection run` uploads its run history either way.** The opt-out covers
analytics only — the upload is gated on a separate internal flag that
`--no-report-events` does not touch. What the flag does affect is git-native v3
collections specifically: it selects the execution engine that lets *their*
results upload, which is why the command's `--report-events` help text reads
"Upload results for git-native v3 collection runs. Analytics are sent by
default." Contrast `application test`, whose opt-out does cover both.

The exception is `postman init`, which the `bootstrap` skill runs. There
`--report-events` is opt-*in* (it gates one richer analytics row and needs a
login), and `init` declares no negated form — so `--report-events=false` on
`init` is rewritten to an option it does not have, and the command exits
non-zero with `unknown option`. Don't copy the opt-out onto `init`.

### Not declinable: client-events

Independently of any flag, the CLI emits a one-line "this command ran" event to
Postman's unauthenticated client-events collector. It does not depend on
`--report-events` and does not depend on being logged in, so
`--no-report-events` does not stop it. `postman collection run`,
`spec lint`, `workspace push` and `init` emit it in addition to the table
above, as do the `postman mock` subcommands and `postman performance run`.

The one thing that does suppress it: the collector is only wired for the US
region, and emission no-ops in other regions (EU included).

### The MCP fallback

Every route also registers Postman's hosted MCP server at `mcp.postman.com`,
the fallback for environments where the CLI can't run. Tool calls made through
it reach Postman too, and none of the CLI flags above apply to them; declining
that traffic means not installing the MCP server. See
[The MCP server config](CONTRIBUTING.md#the-mcp-server-config).

## Contributing

How the routes are wired, the per-agent MCP configs, tests, and how to add,
change or release a skill are in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0 — see [LICENSE](LICENSE).
