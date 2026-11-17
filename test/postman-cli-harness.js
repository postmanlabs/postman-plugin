#!/usr/bin/env node
// Serves this checkout as the skills origin and points a released Postman CLI (`POSTMAN_BIN`, else
// `postman` on PATH) at it through POSTMAN_SKILLS_URL, under a throwaway home. It checks the CLI
// installs and keeps current the skills this checkout ships, in a repository with none and in one
// `postman init` has set up. Every CLI fetches `main`, so a merge here reaches all of them at once: a
// bundle a released CLI refuses has to be caught before the merge, not by a CLI release.
//
// When the fetch fails the CLI installs the skills compiled into it and still exits 0, so each install
// is checked against .postman/skills.json to prove its skills came from this checkout.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { copyCheckout, readJson, repoRoot, runAgent, skills, workspace } from './lib/harness.js';

const postman = process.env.POSTMAN_BIN || 'postman',
    { root, home, remove } = workspace('postman-cli'),
    origin = path.join(root, 'origin'),
    manifest = readJson(path.join(repoRoot, 'manifest.json')),
    EXIT = { OK: 0, BEHIND: 3 };

// Serves files concurrently, as raw.githubusercontent does: the CLI fetches them in parallel against a
// timeout, and a one-at-a-time server makes it give up and fall back to its cache.
function serve (dir) {
    const server = http.createServer((request, response) => {
        const file = path.join(dir, decodeURIComponent(new URL(request.url, 'http://origin').pathname));

        if (!file.startsWith(dir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
            response.writeHead(404).end();

            return;
        }
        response.writeHead(200).end(fs.readFileSync(file));
    });

    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** Every file under `dir`, with a hash of its bytes, so a before/after comparison proves nothing changed. */
function snapshot (dir) {
    return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => path.join(entry.parentPath, entry.name))
        .map((file) => `${path.relative(dir, file)}:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`)
        .sort();
}

copyCheckout(origin);

const server = await serve(origin),
    url = `http://127.0.0.1:${server.address().port}/`,
    env = { ...process.env, HOME: home, USERPROFILE: home, POSTMAN_SKILLS_URL: url };

delete env.POSTMAN_SKILLS_OFFLINE;

async function cli (project, args, expected = EXIT.OK) {
    const { code, stdout, stderr } = await runAgent(postman, args, { env, cwd: project });

    assert.equal(code, expected, [`postman ${args.join(' ')} exited ${code}, not ${expected}`, stdout, stderr].filter(Boolean).join('\n'));
}

/** The skills on disk are this checkout's, every file the manifest lists, not the CLI's bundled copy. */
function assertFromCheckout (project, step) {
    const stamp = readJson(path.join(project, '.postman', 'skills.json'));

    assert.equal(stamp.origin, 'remote', `${step} installed the skills from ${stamp.origin}, not this checkout, so nothing here was tested`);
    assert.equal(stamp.source, url, `${step} fetched the skills from ${stamp.source}, not this checkout`);
    assert.deepEqual(Object.keys(stamp.skills).sort(), [...skills].sort(), `${step} installed a different skill set from manifest.json`);

    for (const skill of manifest.skills) {
        for (const { target } of skill.files) {
            assert.ok(fs.existsSync(path.join(project, 'postman', 'skills', skill.name, target)), `${step} did not write postman/skills/${skill.name}/${target}`);
        }
    }
}

function project (name) {
    const dir = path.join(root, name);

    fs.mkdirSync(dir);

    return dir;
}

try {
    // A repository with no skills: behind, until `skills update` adds them.
    const bare = project('no-skills');

    await cli(bare, ['skills', 'status', '--strict'], EXIT.BEHIND);
    await cli(bare, ['skills', 'update']);
    assertFromCheckout(bare, 'skills update');
    await cli(bare, ['skills', 'status', '--strict']);

    // A repository init set up: current, and init, status and update all still accept what init wrote.
    // --json skips the workspace step, so nothing reaches Postman.
    const initialized = project('initialized');

    await cli(initialized, ['init', '--json']);
    assertFromCheckout(initialized, 'init');
    await cli(initialized, ['skills', 'status', '--strict']);
    await cli(initialized, ['init', '--json']);

    const before = snapshot(path.join(initialized, 'postman'));

    await cli(initialized, ['skills', 'update']);
    assert.deepEqual(snapshot(path.join(initialized, 'postman')), before, 'skills update changed skills that were already current');
    await cli(initialized, ['skills', 'status', '--strict']);

    const { stdout } = await runAgent(postman, ['--version'], { env });

    console.log(`postman ${stdout.trim()} installed and kept current ${skills.length} skills from ${url}, with and without init`);
}
finally {
    server.close();
    remove();
}
