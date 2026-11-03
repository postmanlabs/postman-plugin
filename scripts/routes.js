'use strict';

/**
 * Every plugin route in this repository. .claude/hooks/validate-manifests.js
 * checks each one against its MCP config, installer/test/routes.test.js
 * fails CI when one has no installer adapter, and scripts/route-versions.js
 * says when each one needs a version bump.
 */

// Every manifest route, with its deviations from the default server and header
// keys. An unlisted `.*-plugin/` directory is reported, not checked against guesses.
// `defaultMcpConfig` is the file the vendor loads when the manifest names none.
// `updatesBy` is what the agent compares to update an install: 'version' means a
// release that doesn't bump delivers nothing. Codex, Copilot, Kimi and Cursor are
// unverified and counted as 'version'. `owns` lists files beyond the route's
// directory and MCP config that only this route ships.
const MANIFEST_ROUTES = {
        '.claude-plugin': { updatesBy: 'version' },
        '.codex-plugin': { headerKey: 'http_headers', updatesBy: 'version', owns: ['.app.json'] },
        '.cursor-plugin': { defaultMcpConfig: 'mcp.json', updatesBy: 'version' },
        '.factory-plugin': { mcpConfig: 'mcp.json', updatesBy: 'commit' },
        '.kimi-plugin': { updatesBy: 'version' },
        // agy 1.3.5 ignores the manifest's `mcpServers` path and reads only its
        // default, mcp_config.json; the manifest names that file too.
        '.antigravity-plugin': { mcpConfig: 'mcp_config.json', updatesBy: 'commit' },
        // GitHub Copilot CLI's legacy manifest. It sits inside `.github/`, so
        // MANIFEST_DIR_PATTERN cannot find it; NESTED_MANIFEST_DIRS lists it instead.
        '.github/plugin': { updatesBy: 'version' }
    },
    MANIFEST_DIR_PATTERN = /^\..+-plugin$/,

    // Manifest routes whose directory is not a top-level `.*-plugin/`.
    NESTED_MANIFEST_DIRS = ['.github/plugin'],

    // Routes shipped as a registry package, so MANIFEST_DIR_PATTERN never matches
    // them. A route missing here is never checked, which looks exactly like passing.
    // `mirrors` repeat the manifest's version.
    PACKAGE_ROUTES = [
        {
            manifest: 'opencode/package.json',
            mcpConfig: 'mcp.opencode.json',
            keys: { serverKey: 'mcp' },
            updatesBy: 'commit',
            owns: ['opencode/src', '.opencode', 'package.json'],
            mirrors: ['package.json']
        },
        // Pi installs the installer's own npm package, so the route versions with it,
        // through the release-installer skill's `bump`.
        { manifest: 'installer/package.json', mcpConfig: 'mcp.pi.json', updatesBy: 'installer' }
    ];

module.exports = { MANIFEST_ROUTES, MANIFEST_DIR_PATTERN, NESTED_MANIFEST_DIRS, PACKAGE_ROUTES };
