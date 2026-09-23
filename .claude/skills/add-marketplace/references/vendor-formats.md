# What the existing routes actually do

Reference for Step 0. These routes disagree on every structural key, because
each vendor specified its own — so this table is a record of what was verified
per vendor, never a template to copy from. The disagreement extends to whether a
vendor has a manifest at all.

| | Claude Code | Cursor | Kimi Code | Codex | opencode |
| --- | --- | --- | --- | --- | --- |
| Route kind | manifest | manifest | manifest | manifest | **config-only** |
| Manifest | `.claude-plugin/plugin.json` | `.cursor-plugin/plugin.json` | `.kimi-plugin/plugin.json` | `.codex-plugin/plugin.json` | **none** — `opencode.json` at the repo root |
| Skills pointer | *(implicit — no key)* | `"skills": "skills"` | `"skills": ["./skills"]` | `"skills": "./skills/"` | `"skills": {"paths": ["./skills"]}` |
| MCP config | `"mcpServers": "./mcp.claude-code.json"` | `"mcpServers": "./mcp.cursor.json"` | inline object | `"mcpServers": "./mcp.codex.json"` | inline under `mcp` — no path form |
| MCP header key | `headers` | `headers` | `headers` | `http_headers` | `headers` |
| Transport key | `"type": "http"` | *(none)* | `"transport": "http"`, `"auth": "oauth"` | `"type": "http"` | `"type": "remote"`, `"enabled": true` |
| URL mode segment | `/mcp` | `/mcp` | `/minimal` | `/mcp` | `/minimal` |
| `version` key | yes | yes | yes | yes | **none possible** — root is `additionalProperties: false` |
| Hooks | `hooks/hooks.json` discovered | manifest `hooks`, falls back to `hooks/hooks.json` | inline `hooks` array only — **no file discovery** | manifest `hooks`, falls back to `hooks/hooks.json` | **no hooks** — `instructions` array instead |
| Published schema | SchemaStore | `cursor/plugins` repo | none | none — prose docs only | `opencode.ai/config.json`, draft2020, `$ref`s `models.dev` |
| Extras | `$schema` | — | `interface` block | `interface` block | `$schema` |

## Per-route notes worth knowing before you add a fifth

**Codex falls back to other routes' manifests.** Its
`DISCOVERABLE_PLUGIN_MANIFEST_PATHS` is `.codex-plugin`, `.claude-plugin`,
`.cursor-plugin`, in that order, so it loaded this repo before it had a route of
its own. That fallback is not a substitute for one: it would read
`mcp.claude-code.json`, whose `headers` key Codex does not understand, and the
traffic arrives with no `X-Source` at all.

**`http_headers` is the sharpest edge in the repo.** Codex deserializes a
plugin's MCP config into its own `RawMcpServerConfig`, which has only
`http_headers` and carries `#[schemars(deny_unknown_fields)]` — schemars, for
schema generation, not serde. So serde ignores unknown keys: a `headers` block
in `mcp.codex.json` is dropped without an error, the server still connects, and
every request goes out unattributed. It looks exactly like success. `headers` is
right for the other three; do not normalize across all four.

**Kimi's `interface` block and Codex's are not the same thing** even though they
share a name — each vendor defines its own fields. Check the vendor's docs
rather than copying the block.

**opencode's pointer is in its schema but not its docs.** `skills.paths` does
not appear on the docs site, so a docs-only pass concludes no pointer exists and
discovery is fixed-path only. It does exist: entries resolve against the project
root, a missing directory logs a warning and continues, and the glob is
`{*.md,**/SKILL.md}`, so a container directory behaves exactly like Cursor's
pointer. Enumerate the schema's properties; do not infer absence from prose.

**No route expands `${...}` inside an MCP URL.** `claude plugin list --json`
reports the registered URL with any placeholder still in the path, Cursor has no
such plugin variable in a URL, and the Agent Plugins spec is explicit that only
`${PLUGIN_ROOT}`/`${PLUGIN_DATA}` expand and never in a URL. If the mode ever
needs to be configurable, resolve it at build time or behind a stdio wrapper.
