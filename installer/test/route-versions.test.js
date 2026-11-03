import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
    script = path.join(repoRoot, 'scripts', 'route-versions.js'),
    ROUTE_FILES = ['.claude-plugin', '.codex-plugin', '.cursor-plugin', '.factory-plugin', '.kimi-plugin', '.antigravity-plugin',
        '.github/plugin', '.app.json', 'mcp.json', 'mcp_config.json', 'mcp.claude-code.json', 'mcp.codex.json', 'mcp.copilot.json',
        'mcp.cursor.json', 'mcp.opencode.json', 'mcp.pi.json', 'package.json', 'opencode/package.json', 'opencode/package-lock.json',
        'installer/package.json', 'assets'],
    GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

/** A repository holding only this checkout's route files, committed once, so every route starts current. */
function fixture (t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-versions-'));

    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    for (const file of ROUTE_FILES) {
        fs.cpSync(path.join(repoRoot, file), path.join(dir, file), { recursive: true });
    }

    fs.mkdirSync(path.join(dir, 'skills', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'skills', 'demo', 'SKILL.md'), 'demo\n');

    const git = (...args) => {
        const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });

        assert.equal(result.status, 0, result.stderr);

        return result.stdout.trim();
    };

    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-q', '-m', 'chore: routes');

    return {
        dir,
        git,
        commit (file, content, message) {
            fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
            fs.writeFileSync(path.join(dir, file), content);
            git('add', '-A');
            git('commit', '-q', '-m', message);
        },
        run: (...args) => spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: 'utf8' }),
        json: (file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
    };
}

const versionOf = (repo, file) => repo.json(file).version;

test('every route is current right after its version is set', (t) => {
    const repo = fixture(t),
        result = repo.run('--check');

    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /every route is current/);
});

test('a skill change makes the version-keyed routes stale, and leaves the commit-tracked ones current', (t) => {
    const repo = fixture(t);

    repo.commit('skills/demo/SKILL.md', 'changed\n', 'feat(demo): a new section');

    const result = repo.run('--check'),
        failed = result.stdout.split('\n').filter((line) => line.startsWith('FAIL')).map((line) => line.split(/\s+/)[1]);

    assert.equal(result.status, 1);
    assert.deepEqual(failed.sort(), ['claude-code', 'codex', 'copilot', 'cursor', 'kimi']);
});

test('a change to one route\'s own files makes only that route stale', (t) => {
    const repo = fixture(t),
        config = repo.json('mcp.json');

    config.mcpServers.postman.url += '?x';
    repo.commit('mcp.json', `${JSON.stringify(config, null, 2)}\n`, 'fix(factory): a new url');

    const failed = repo.run('--check').stdout.split('\n').filter((line) => line.startsWith('FAIL')).map((line) => line.split(/\s+/)[1]);

    assert.deepEqual(failed, ['factory']);
});

test('a file the manifest names, such as a logo, belongs to that route', (t) => {
    const repo = fixture(t);

    repo.commit('assets/logo.svg', '<svg/>\n', 'fix: a new logo');

    const failed = repo.run('--check').stdout.split('\n').filter((line) => line.startsWith('FAIL')).map((line) => line.split(/\s+/)[1]);

    assert.ok(failed.includes('antigravity'), failed.join(', '));
});

test('reformatting a version line is not a version change, so earlier changes stay unreleased', (t) => {
    const repo = fixture(t),
        manifest = '.claude-plugin/plugin.json',
        text = fs.readFileSync(path.join(repo.dir, manifest), 'utf8');

    repo.commit('skills/demo/SKILL.md', 'changed\n', 'feat(demo): a new section');
    repo.commit(manifest, text.replace(/"version": "/, '"version":  "'), 'style: spacing');

    assert.match(repo.run('--check').stdout, /FAIL claude-code/);
});

test('--write bumps each stale route by its commits, keeps its strings in step, and leaves current routes alone', (t) => {
    const repo = fixture(t),
        claude = versionOf(repo, '.claude-plugin/plugin.json'),
        factory = versionOf(repo, '.factory-plugin/plugin.json');

    repo.commit('skills/demo/SKILL.md', 'changed\n', 'fix(demo): wording');
    assert.equal(repo.run('--write').status, 0);

    const [major, minor, patch] = claude.split('.').map(Number),
        bumped = `${major}.${minor}.${patch + 1}`,
        headers = repo.json('mcp.claude-code.json').mcpServers.postman.headers,
        kimi = repo.json('.kimi-plugin/plugin.json');

    assert.equal(versionOf(repo, '.claude-plugin/plugin.json'), bumped);
    assert.equal(headers['X-Plugin-Version'], bumped);
    assert.equal(headers['User-Agent'], `postman-claude-code-plugin/${bumped}`);
    assert.equal(kimi.mcpServers.postman.headers['X-Plugin-Version'], kimi.version);
    assert.equal(versionOf(repo, '.factory-plugin/plugin.json'), factory);

    repo.git('add', '-A');
    repo.git('commit', '-q', '-m', 'release: routes');
    assert.equal(repo.run('--check').status, 0);
});

test('--write takes a version for a route, and moves every OpenCode string with it', (t) => {
    const repo = fixture(t);

    assert.equal(repo.run('--write', 'claude-code=9.0.0', 'opencode=0.9.0').status, 0);
    assert.equal(versionOf(repo, '.claude-plugin/plugin.json'), '9.0.0');

    const lock = repo.json('opencode/package-lock.json');

    assert.deepEqual([versionOf(repo, 'opencode/package.json'), versionOf(repo, 'package.json'), lock.version, lock.packages[''].version],
        ['0.9.0', '0.9.0', '0.9.0', '0.9.0']);
    assert.equal(repo.json('mcp.opencode.json').mcp.postman.headers['X-Plugin-Version'], '0.9.0');
    assert.equal(repo.run('--write', 'nope=1.0.0').status, 2);
});

test('--write refuses a version that does not move a route forward, and writes nothing', (t) => {
    const repo = fixture(t),
        current = versionOf(repo, '.claude-plugin/plugin.json'),
        [major] = current.split('.').map(Number);

    repo.commit('skills/demo/SKILL.md', 'changed\n', 'fix(demo): wording');

    for (const version of [current, `${Math.max(major - 1, 0)}.0.0`]) {
        const result = repo.run('--write', `claude-code=${version}`);

        assert.equal(result.status, 2, result.stdout);
        assert.match(result.stderr, /must move it forward/);
    }

    assert.equal(repo.git('status', '--porcelain'), '');
});

test('--base fails a release that moves a route\'s version back', (t) => {
    const repo = fixture(t),
        base = repo.git('rev-parse', 'HEAD'),
        manifest = repo.json('.claude-plugin/plugin.json');

    repo.commit('.claude-plugin/plugin.json', `${JSON.stringify({ ...manifest, version: '0.0.1' }, null, 2)}\n`, 'release: downgrade');

    const result = repo.run('--check', '--base', base);

    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /FAIL claude-code moves back/);
});

test('--base checks only a change that moves a version, which makes it a release', (t) => {
    const repo = fixture(t),
        base = repo.git('rev-parse', 'HEAD');

    repo.commit('skills/demo/SKILL.md', 'changed\n', 'feat(demo): a new section');

    const content = repo.run('--check', '--base', base);

    assert.equal(content.status, 0, content.stdout);
    assert.match(content.stdout, /not a release/);

    const installer = repo.json('installer/package.json');

    repo.commit('installer/package.json', `${JSON.stringify({ ...installer, version: '99.0.0' }, null, 2)}\n`, 'release: installer');

    const release = repo.run('--check', '--base', base);

    assert.equal(release.status, 1);
    assert.match(release.stdout, /FAIL claude-code/);
});
