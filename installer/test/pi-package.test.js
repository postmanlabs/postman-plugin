import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PI_SOURCE } from '../dist/source.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    repoRoot = path.dirname(packageRoot),
    manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')),
    skillIndex = JSON.parse(fs.readFileSync(path.join(repoRoot, 'manifest.json'), 'utf8')).skills,
    TOP_LEVEL = ['LICENSE', 'README.md', 'dist', 'hooks', 'manifest.json', 'mcp.opencode.json', 'mcp.pi.json', 'opencode', 'package.json', 'skills'],
    // What `pi.extensions` and the extension itself read from the tarball.
    PI_FILES = ['dist/pi-extension.js', 'hooks/session-start-context.md', 'mcp.pi.json'],
    // Pi's own limits, from the Agent Skills spec; a skill past them loads with a warning on every start.
    SKILL_NAME = /^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/,
    MAX_DESCRIPTION = 1024;

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

const stage = (step) => run(process.execPath, ['scripts/pack-repo-files.js', step]);

// Stages by hand with --ignore-scripts: prepack's rebuild would rewrite dist/ under the
// test files running in parallel. npm_execpath is npm's own CLI under `npm test`.
function packDryRun () {
    const npm = process.env.npm_execpath ? [process.execPath, [process.env.npm_execpath]] : ['npm', []];

    assert.equal(stage('stage').status, 0);

    try {
        return run(npm[0], [...npm[1], 'pack', '--dry-run', '--json', '--ignore-scripts']);
    }
    finally {
        stage('clean');
    }
}

test('declares itself a Pi package: the repo\'s skills/ and the extension', () => {
    assert.ok(manifest.keywords.includes('pi-package'), 'Pi\'s gallery lists npm packages carrying the pi-package keyword');
    assert.deepEqual(manifest.pi.skills, ['./skills']);
    assert.deepEqual(manifest.pi.extensions, ['./dist/pi-extension.js']);
    assert.ok(manifest.files.includes('skills/'));
    assert.equal(PI_SOURCE, `npm:${manifest.name}`);
});

test('mcp.pi.json reports the version this package declares', () => {
    const { mcpServers } = JSON.parse(fs.readFileSync(path.join(repoRoot, 'mcp.pi.json'), 'utf8'));

    for (const [name, { headers }] of Object.entries(mcpServers)) {
        assert.equal(headers['X-Plugin-Version'], manifest.version, `set mcp.pi.json (${name}) to ${manifest.version} in the same release`);
        assert.equal(headers['User-Agent'], `${headers['X-Source']}/${manifest.version}`);
    }
});

test('every skill passes the frontmatter checks Pi runs on load', () => {
    for (const { name, description } of skillIndex) {
        assert.match(name, SKILL_NAME, `skills/${name}: not a valid Agent Skills name`);
        assert.ok(description?.trim(), `skills/${name}: no description, so Pi skips the skill`);
        assert.ok(description.length <= MAX_DESCRIPTION, `skills/${name}: description is ${description.length} characters; Pi warns past ${MAX_DESCRIPTION}`);
    }
});

test('the tarball carries every skill file, what the extension reads, and nothing else', () => {
    const packed = packDryRun();

    assert.equal(packed.status, 0, packed.stderr);

    const files = JSON.parse(packed.stdout)[0].files.map((file) => file.path),
        skills = files.filter((file) => file.startsWith('skills/')).sort();

    assert.deepEqual(skills, repoSkillFiles().sort());
    assert.deepEqual(PI_FILES.filter((file) => !files.includes(file)), []);
    assert.deepEqual(files.filter((file) => file.startsWith('hooks/')), ['hooks/session-start-context.md']);
    assert.deepEqual([...new Set(files.map((file) => file.split('/')[0]))].sort(), TOP_LEVEL);
    assert.equal(fs.existsSync(path.join(packageRoot, 'skills')), false, 'clean left the staged skills/ behind');
});

test('staging replaces a staged copy left behind by an interrupted pack', () => {
    const leftover = path.join(packageRoot, 'skills', 'deleted-skill', 'SKILL.md');

    fs.mkdirSync(path.dirname(leftover), { recursive: true });
    fs.writeFileSync(leftover, '---\nname: deleted-skill\n---\n');

    try {
        assert.equal(stage('stage').status, 0);
        assert.equal(fs.existsSync(leftover), false);
    }
    finally {
        stage('clean');
    }
});

test('ships the OpenCode plugin entrypoint and the files it reads, for `opencode plugin add @postman/postman-plugin`', () => {
    assert.equal(manifest.main, './opencode/src/index.ts');

    const listed = JSON.parse(packDryRun().stdout)[0].files.map((file) => file.path);

    for (const file of ['opencode/src/index.ts', 'manifest.json', 'mcp.opencode.json', 'hooks/session-start-context.md', 'skills/api-engineer/SKILL.md']) {
        assert.ok(listed.includes(file), `the tarball does not ship ${file}`);
    }
});
