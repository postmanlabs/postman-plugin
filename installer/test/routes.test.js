import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { HOSTS } from '../dist/hosts/index.js';
import { OPENCODE_SHIM } from '../dist/source.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
    // The same two kinds of route .claude/hooks/validate-manifests.js checks.
    PACKAGE_ROUTES = ['opencode/package.json'],
    manifestRoutes = fs.readdirSync(repoRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^\..+-plugin$/.test(entry.name))
        .map((entry) => entry.name);

test('every route in this repo has an installer adapter', () => {
    const covered = HOSTS.map((host) => host.route);

    for (const route of [...manifestRoutes, ...PACKAGE_ROUTES]) {
        assert.ok(covered.includes(route), `${route} has no adapter in installer/src/hosts/ - add one (see add-marketplace)`);
    }
});

test('every adapter names a route that exists', () => {
    for (const host of HOSTS) {
        assert.ok(fs.existsSync(path.join(repoRoot, host.route)), `${host.id} names ${host.route}, which does not exist`);
    }
});

test('the OpenCode shim is the one opencode/README.md tells users to write', () => {
    const readme = fs.readFileSync(path.join(repoRoot, 'opencode', 'README.md'), 'utf8'),
        documented = readme.match(/echo "(export \{ default \} from [^"]+)" > ~\/\.config\/opencode\/plugins\/postman\.ts/);

    assert.ok(documented, 'opencode/README.md no longer shows the global shim command');
    assert.equal(OPENCODE_SHIM, `${documented[1]}\n`);
});
