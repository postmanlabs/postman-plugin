import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { HOSTS } from '../dist/hosts/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
    { MANIFEST_ROUTES, MANIFEST_DIR_PATTERN, PACKAGE_ROUTES } = createRequire(import.meta.url)(path.join(repoRoot, 'scripts', 'routes.js')),
    // The pre-commit guard reports a `.*-plugin/` directory missing from the registry,
    // but only where someone installed it, so the directories count here too.
    manifestDirs = fs.readdirSync(repoRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && MANIFEST_DIR_PATTERN.test(entry.name))
        .map((entry) => entry.name),
    routes = [...new Set([...Object.keys(MANIFEST_ROUTES), ...manifestDirs, ...PACKAGE_ROUTES.map((route) => route.manifest)])];

test('every route in scripts/routes.js, and every .*-plugin/ directory, has an installer adapter', () => {
    const covered = HOSTS.map((host) => host.route),
        missing = routes.filter((route) => !covered.includes(route));

    assert.deepEqual(missing, [], `no adapter in installer/src/hosts/ for ${missing.join(', ')} - add one (see add-marketplace)`);
});

test('every adapter names a route that exists', () => {
    for (const host of HOSTS) {
        assert.ok(routes.includes(host.route), `${host.id} names ${host.route}, which is not a route in scripts/routes.js or a .*-plugin/ directory`);
        assert.ok(fs.existsSync(path.join(repoRoot, host.route)), `${host.id} names ${host.route}, which does not exist`);
    }
});
