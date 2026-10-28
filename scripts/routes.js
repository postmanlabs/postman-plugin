'use strict';

/**
 * Every plugin route in this repository. .claude/hooks/validate-manifests.js
 * checks each one against its MCP config, and installer/test/routes.test.js
 * fails CI when one has no installer adapter.
 */

// Every manifest route, with its deviations from the default server and header
// keys. An unlisted `.*-plugin/` directory is reported, not checked against guesses.
// `defaultMcpConfig` is the file the vendor loads when the manifest names none.
const MANIFEST_ROUTES = {
        '.claude-plugin': {},
        '.codex-plugin': { headerKey: 'http_headers' },
        '.cursor-plugin': { defaultMcpConfig: 'mcp.json' },
        '.factory-plugin': { mcpConfig: 'mcp.json' },
        '.kimi-plugin': {},
        // agy 1.3.5 ignores the manifest's `mcpServers` path and reads only its
        // default, mcp_config.json; the manifest names that file too.
        '.antigravity-plugin': { mcpConfig: 'mcp_config.json' },
        // GitHub Copilot CLI's legacy manifest. It sits inside `.github/`, so
        // MANIFEST_DIR_PATTERN cannot find it; NESTED_MANIFEST_DIRS lists it instead.
        '.github/plugin': {},
        // Kiro's power manifest must be a root-level plugin.json, which this repo cannot have
        // (Codex would take it for its own); a `kiro/` subfolder is imported as a power instead.
        kiro: { mcpConfig: 'kiro/mcp.json' }
    },
    MANIFEST_DIR_PATTERN = /^\..+-plugin$/,

    // Manifest routes whose directory is not a top-level `.*-plugin/`.
    NESTED_MANIFEST_DIRS = ['.github/plugin', 'kiro'],

    // Routes shipped as a registry package, so MANIFEST_DIR_PATTERN never matches
    // them. A route missing here is never checked, which looks exactly like passing.
    PACKAGE_ROUTES = [
        { manifest: 'opencode/package.json', mcpConfig: 'mcp.opencode.json', keys: { serverKey: 'mcp' } },
        // Pi installs the installer's own npm package, so the route versions with it.
        { manifest: 'installer/package.json', mcpConfig: 'mcp.pi.json' }
    ];

module.exports = { MANIFEST_ROUTES, MANIFEST_DIR_PATTERN, NESTED_MANIFEST_DIRS, PACKAGE_ROUTES };
