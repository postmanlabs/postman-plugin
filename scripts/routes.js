'use strict';

/**
 * Every plugin route in this repository. .claude/hooks/validate-manifests.js
 * checks each one against its MCP config, and installer/test/routes.test.js
 * fails CI when one has no installer adapter.
 */

// Every manifest route, with its deviations from the default server and header
// keys. An unlisted `.*-plugin/` directory is reported, not checked against guesses.
const MANIFEST_ROUTES = {
        '.claude-plugin': {},
        '.codex-plugin': { headerKey: 'http_headers' },
        '.cursor-plugin': {},
        '.kimi-plugin': {}
    },
    MANIFEST_DIR_PATTERN = /^\..+-plugin$/,

    // Routes shipped as a registry package, so MANIFEST_DIR_PATTERN never matches
    // them. A route missing here is never checked, which looks exactly like passing.
    PACKAGE_ROUTES = [
        { manifest: 'opencode/package.json', mcpConfig: 'mcp.opencode.json', keys: { serverKey: 'mcp' } },
        // Pi installs the installer's own npm package, so the route versions with it.
        { manifest: 'installer/package.json', mcpConfig: 'mcp.pi.json' }
    ];

module.exports = { MANIFEST_ROUTES, MANIFEST_DIR_PATTERN, PACKAGE_ROUTES };
