// Asks the real npm registry, so it needs the network: the release the installer pins must exist and be installable.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { specToInstall } from '../dist/hosts/opencode.js';
import { OPENCODE_PACKAGE } from '../dist/source.js';
import { createSystem } from '../dist/system.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
    sourceVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, 'opencode', 'package.json'), 'utf8')).version,
    npmView = (args) => spawnSync('npm', ['view', ...args, '--json'], { encoding: 'utf8', shell: process.platform === 'win32' }),
    neverPublished = /E404/.test(npmView([OPENCODE_PACKAGE, 'version']).stderr);

/** True when dotted version `a` is `b` or an earlier release. */
function notAfter (a, b) {
    const [x, y] = [a, b].map((version) => version.split('.').map(Number)),
        differing = x.findIndex((part, at) => part !== y[at]);

    return differing === -1 || x[differing] < y[differing];
}

test('the installer pins a published @postman/opencode-plugin release that OpenCode can install', { skip: neverPublished && `${OPENCODE_PACKAGE} has no release on npm yet` }, async () => {
    const spec = await specToInstall(createSystem({ log: () => {} })),
        version = spec.slice(`${OPENCODE_PACKAGE}@`.length);

    assert.match(spec, /^@postman\/opencode-plugin@\d+\.\d+\.\d+$/);
    assert.ok(notAfter(version, sourceVersion), `npm's latest ${version} is newer than opencode/package.json's ${sourceVersion}`);

    const published = JSON.parse(npmView([spec]).stdout);

    assert.equal(published.version, version);
    assert.equal(published.main, './src/index.ts');
    assert.equal(published.exports['./server'], './src/index.ts');
    assert.equal(published.scripts, undefined, 'npm would run its lifecycle scripts in every user\'s install');
    assert.equal(published.dependencies, undefined);
    assert.ok(published.dist?.attestations, `${spec} was published without provenance`);
});
