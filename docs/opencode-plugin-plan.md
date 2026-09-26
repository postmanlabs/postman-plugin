# OpenCode plugin plan

## Goal

Publish `@postman/opencode-plugin` so any OpenCode user can install Postman's
canonical skills, shared session guidance and hosted MCP server with one
command:

```bash
opencode plugin @postman/opencode-plugin --global
```

The npm artifact includes the repository's existing `skills/` directory. It
does not create a second copy or fork of the skill content.

## Implemented architecture

1. `opencode/index.ts` exports an OpenCode plugin.
2. Its `config` hook appends the package's absolute `skills/` directory and the
   Postman MCP server. Existing user paths and an existing `mcp.postman` entry
   win.
3. Its system-transform hook loads `hooks/session-start-context.md` and adapts
   namespaced `postman:<skill>` references to OpenCode's native `<skill>` IDs.
4. `.opencode/plugins/postman.ts` lets a repository clone load the same source
   through OpenCode's documented local-plugin directory.
5. TypeScript compiles to the npm entry point in `dist/index.js`.

The first release declares OpenCode `>=1.18.32`, the version used by the unit,
harness and live-model tests. Broaden that range only after running the same
checks against the older version.

## Verification layers

Run all deterministic checks before review:

```bash
npm ci
npm test
npm run test:harness
npm run eval:skills:validate
node .claude/hooks/validate-manifests.js
```

`npm test` checks config merging, attribution headers, namespace adaptation and
asset resolution. `test:harness` creates a tarball, installs it into a clean
temporary project, launches the pinned OpenCode CLI from a nested directory,
verifies every shipped file against `manifest.json`, and confirms that
OpenCode discovers all published skill IDs.

The live routing loop uses an actual configured model:

```bash
npm run eval:skills
npm run eval:skills -- --case api-mocking
npm run eval:skills -- --model provider/model --output evals/opencode/results/latest.json
```

Each case instructs OpenCode to choose at most one native skill. The evaluator
reads OpenCode's JSON event stream and compares completed `skill` tool calls to
the expected set. Every manifest skill needs at least one positive case, and
negative cases ensure unrelated work does not invoke Postman. Add a failing
case before changing routing language; adjust the canonical skill description
or shared session context; then rerun the targeted case and the full set.

## Public release gates

- Confirm the `@postman` npm organization owns the unclaimed package name.
- Review the package with `npm pack --dry-run` and inspect the tarball contents.
- Land the implementation and CI checks without changing existing vendor-route
  versions.
- In a separate release change, choose the package version, create provenance
  from the trusted CI workflow and publish with Postman's npm credentials.
- Install from the public registry in a clean environment and repeat the
  harness with `plugin: ["@postman/opencode-plugin@<version>"]`.
- Add the package to OpenCode's community ecosystem directory after the public
  npm install succeeds.

Publishing is intentionally not performed by the test suite: it is an
irreversible external action requiring Postman's npm authorization.

## Follow-up plugin surface

The first public release should stay deliberately small: skill discovery,
shared context and MCP configuration. Later versions can add OpenCode-native
commands, notifications or custom tools only when they provide behavior that
the canonical skills and MCP tools cannot already express. Each addition needs
unit coverage, a packed-install harness assertion and at least one eval case.
