import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    repoRoot = path.dirname(packageRoot),
    manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')),
    TOP_LEVEL = ['LICENSE', 'README.md', 'dist', 'package.json', 'skills'];

function repoSkillFiles (dir = path.join(repoRoot, 'skills')) {
    return fs.readdirSync(dir, { withFileTypes: true })
        .filter((entry) => !entry.name.startsWith('.'))
        .flatMap((entry) => entry.isDirectory() ?
            repoSkillFiles(path.join(dir, entry.name)) :
            [path.relative(repoRoot, path.join(dir, entry.name)).split(path.sep).join('/')]);
}

function run (command, args) {
    return spawnSync(command, args, {
        cwd: packageRoot,
        encoding: 'utf8',
        shell: command === 'npm' && process.platform === 'win32'
    });
}

// Stages by hand with --ignore-scripts: prepack's rebuild would rewrite dist/ under the
// test files running in parallel. npm_execpath is npm's own CLI under `npm test`.
function packDryRun () {
    const npm = process.env.npm_execpath ? [process.execPath, [process.env.npm_execpath]] : ['npm', []],
        stage = (step) => run(process.execPath, ['scripts/pack-repo-files.js', step]);

    assert.equal(stage('stage').status, 0);

    try {
        return run(npm[0], [...npm[1], 'pack', '--dry-run', '--json', '--ignore-scripts']);
    }
    finally {
        stage('clean');
    }
}

test('declares itself a Pi package whose skills are the repo\'s skills/', () => {
    assert.ok(manifest.keywords.includes('pi-package'), 'Pi\'s gallery lists npm packages carrying the pi-package keyword');
    assert.deepEqual(manifest.pi, { skills: ['./skills'] });
    assert.ok(manifest.files.includes('skills/'));
});

test('the tarball carries every skill file and nothing outside the package\'s own entries', () => {
    const packed = packDryRun();

    assert.equal(packed.status, 0, packed.stderr);

    const files = JSON.parse(packed.stdout)[0].files.map((file) => file.path),
        skills = files.filter((file) => file.startsWith('skills/')).sort();

    assert.deepEqual(skills, repoSkillFiles().sort());
    assert.deepEqual([...new Set(files.map((file) => file.split('/')[0]))].sort(), TOP_LEVEL);
    assert.equal(fs.existsSync(path.join(packageRoot, 'skills')), false, 'clean left the staged skills/ behind');
});
