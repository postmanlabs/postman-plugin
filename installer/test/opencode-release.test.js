// Reads postmanlabs/opencode-plugin over the network: the release the installer's range resolves to must be installable.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { OPENCODE_REPO } from '../dist/source.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
    sourceVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, 'opencode', 'package.json'), 'utf8')).version,
    url = `https://github.com/${OPENCODE_REPO}.git`,
    git = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }),
    listed = git(['ls-remote', '--tags', '--refs', url, 'v*']),
    // What `#semver:*` matches: release tags only, never a prerelease.
    releases = listed.stdout.split('\n').map((line) => line.split('refs/tags/')[1]).filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag ?? '')),
    skip = listed.status !== 0 ? `${OPENCODE_REPO} is not readable from here` : releases.length === 0 && `${OPENCODE_REPO} has no release tag yet`;

/** True when dotted version `a` is `b` or an earlier release. */
function notAfter (a, b) {
    const [x, y] = [a, b].map((version) => version.split('.').map(Number)),
        differing = x.findIndex((part, at) => part !== y[at]);

    return differing === -1 || x[differing] < y[differing];
}

test('the newest release tag on the mirror is an installable package, no newer than this source', { skip }, (t) => {
    const newest = releases.map((tag) => tag.slice(1)).reduce((a, b) => (notAfter(a, b) ? b : a)),
        clone = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-release-'));

    t.after(() => fs.rmSync(clone, { recursive: true, force: true }));
    assert.ok(notAfter(newest, sourceVersion), `the mirror's v${newest} is newer than opencode/package.json's ${sourceVersion}`);
    assert.equal(git(['clone', '--quiet', '--depth', '1', '--branch', `v${newest}`, url, clone]).status, 0);

    const released = JSON.parse(fs.readFileSync(path.join(clone, 'package.json'), 'utf8'));

    assert.equal(released.version, newest, `v${newest} holds a package.json for ${released.version}`);
    assert.equal(released.main, './src/index.ts');
    assert.equal(released.exports['./server'], './src/index.ts');
    assert.equal(released.scripts, undefined, 'npm would run its lifecycle scripts in every user\'s install');
    assert.equal(released.dependencies, undefined);

    for (const file of [released.main, 'manifest.json', 'mcp.opencode.json', 'hooks/session-start-context.md']) {
        assert.ok(fs.existsSync(path.join(clone, file)), `v${newest} has no ${file}`);
    }
});
