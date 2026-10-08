import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildMirror, MIRROR_PATHS } from '../scripts/build-mirror.js';
import PostmanPluginDefinition, {
    applyPostmanConfig, assetRoot, mcpConfigFile, PostmanPlugin, sessionContextFile,
    skillsDirectory, toOpenCodeSessionContext
} from '../dist/index.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    packageVersion = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version,
    manifestSkills = JSON.parse(fs.readFileSync(path.join(assetRoot, 'manifest.json'), 'utf8')).skills;

test('mcp.opencode.json carries this package version in both headers', () => {
    const { headers } = JSON.parse(fs.readFileSync(mcpConfigFile, 'utf8')).mcp.postman;

    assert.equal(headers['X-Source'], 'postman-opencode-plugin');
    assert.equal(headers['X-Plugin-Version'], packageVersion);
    assert.equal(headers['User-Agent'], `postman-opencode-plugin/${packageVersion}`);
});

test('the mirror is a package `opencode plugin add` can install, versioned with this one', (t) => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-mirror-'));

    t.after(() => fs.rmSync(out, { recursive: true, force: true }));
    buildMirror(out);

    const mirror = JSON.parse(fs.readFileSync(path.join(out, 'package.json'), 'utf8'));

    assert.equal(mirror.name, '@postman/opencode-plugin');
    assert.equal(mirror.version, packageVersion);
    assert.equal(mirror.private, undefined);
    assert.equal(mirror.main, mirror.exports['./server']);
    assert.equal(mirror.scripts, undefined, 'npm runs prepare/install scripts of a Git dependency in every user\'s install');
    assert.equal(mirror.dependencies, undefined);
    assert.equal(mirror.repository.url, 'git+https://github.com/postmanlabs/postman-plugin.git', 'npm provenance needs the repository it is published from');

    for (const file of [mirror.main, 'manifest.json', 'mcp.opencode.json', 'hooks/session-start-context.md', 'LICENSE']) {
        assert.ok(fs.existsSync(path.join(out, file)), `the mirror has no ${file}`);
    }

    assert.deepEqual(fs.readdirSync(path.join(out, 'skills')).sort(), manifestSkills.map((skill) => skill.name).sort());
    assert.equal(fs.readFileSync(path.join(out, 'src', 'index.ts'), 'utf8'), fs.readFileSync(path.join(packageRoot, 'src', 'index.ts'), 'utf8'));
});

test('a sync replaces what the mirror generates and keeps the mirror\'s own files', (t) => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-mirror-')),
        own = { 'README.md': '# Postman for OpenCode\n', 'SECURITY.md': '# Security policy\n', '.github/CODEOWNERS': '* @postmanlabs/headless-postman\n' };

    t.after(() => fs.rmSync(out, { recursive: true, force: true }));

    for (const [file, content] of Object.entries(own)) {
        fs.mkdirSync(path.dirname(path.join(out, file)), { recursive: true });
        fs.writeFileSync(path.join(out, file), content);
    }

    fs.mkdirSync(path.join(out, 'skills', 'removed-skill'), { recursive: true });
    fs.writeFileSync(path.join(out, 'skills', 'removed-skill', 'SKILL.md'), 'stale');
    fs.writeFileSync(path.join(out, 'manifest.json'), 'stale');
    buildMirror(out);

    for (const [file, content] of Object.entries(own)) {
        assert.equal(fs.readFileSync(path.join(out, file), 'utf8'), content, `the sync dropped the mirror's ${file}`);
    }

    assert.deepEqual(fs.readdirSync(path.join(out, 'skills')).sort(), manifestSkills.map((skill) => skill.name).sort());
    assert.equal(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'), fs.readFileSync(path.join(assetRoot, 'manifest.json'), 'utf8'));
});

test('MIRROR_PATHS names every top-level path the build writes', (t) => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-mirror-'));

    t.after(() => fs.rmSync(out, { recursive: true, force: true }));
    buildMirror(out);

    assert.deepEqual(fs.readdirSync(out).sort(), [...MIRROR_PATHS].sort());
});

test('the entrypoint reads the shared files beside itself in the mirror', async (t) => {
    // Resolved, as import.meta.url is: macOS's temporary directory is a symlink.
    const out = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-mirror-')));

    t.after(() => fs.rmSync(out, { recursive: true, force: true }));
    buildMirror(out);
    fs.copyFileSync(path.join(packageRoot, 'dist', 'index.js'), path.join(out, 'src', 'index.mjs'));

    const mirrored = await import(pathToFileURL(path.join(out, 'src', 'index.mjs')).href);

    assert.equal(mirrored.assetRoot, out);
    assert.equal(mirrored.skillsDirectory, path.join(out, 'skills'));
});

test('registers the skills directory and Postman MCP server', () => {
    const config = {};

    applyPostmanConfig(config);

    assert.deepEqual(config.skills.paths, [skillsDirectory]);
    assert.equal(config.mcp.postman.type, 'remote');
    assert.equal(config.mcp.postman.url, 'https://mcp.postman.com/minimal');
    assert.equal(config.mcp.postman.enabled, true);
    assert.equal(config.mcp.postman.headers['X-Source'], 'postman-opencode-plugin');
    assert.equal(config.mcp.postman.headers['X-Plugin-Version'], packageVersion);
});

test('preserves user configuration and stays idempotent', () => {
    const existingPostman = { enabled: false },
        config = {
            skills: { paths: ['/company/skills'] },
            mcp: { postman: existingPostman, github: { enabled: false } }
        };

    applyPostmanConfig(config);
    applyPostmanConfig(config);

    assert.deepEqual(config.skills.paths, ['/company/skills', skillsDirectory]);
    assert.equal(config.mcp.postman, existingPostman);
    assert.deepEqual(config.mcp.github, { enabled: false });
});

test('adapts the shared session mandate to native OpenCode skill ids', () => {
    const canonical = fs.readFileSync(sessionContextFile, 'utf8'),
        adapted = toOpenCodeSessionContext(canonical);

    assert.match(canonical, /postman:api-engineer/);
    assert.doesNotMatch(adapted, /postman:/);
    assert.match(adapted, /`api-engineer` skill/);
    assert.match(adapted, /`api-testing`/);
    assert.match(adapted, /User instructions .* take precedence/s);
});

test('rewrites only backticked skill references', () => {
    assert.equal(toOpenCodeSessionContext('see `postman:bootstrap`'), 'see `bootstrap`');
    assert.equal(toOpenCodeSessionContext('run /postman:bootstrap'), 'run /postman:bootstrap');
});

test('exposes config and system hooks through the public plugin export', async () => {
    const hooks = await PostmanPlugin({}),
        config = {},
        output = { system: ['existing system instruction'] };

    await hooks.config(config);
    await hooks['experimental.chat.system.transform']({}, output);
    await hooks['experimental.chat.system.transform']({}, output);

    assert.deepEqual(config.skills.paths, [skillsDirectory]);
    assert.equal(output.system[0], 'existing system instruction');
    assert.equal(output.system.length, 2);
    assert.match(output.system[1], /`api-engineer` skill/);
});

test('exposes a default v2 definition while retaining the v1 server entrypoint', async () => {
    const skills = new Map(),
        mcp = new Map(),
        sessionHooks = new Map(),
        registration = { async dispose () {} },
        context = {
            skill: {
                async transform (callback) {
                    callback({
                        get: (id) => skills.get(id),
                        add: (skill) => skills.set(skill.id, skill)
                    });

                    return registration;
                }
            },
            mcp: {
                async transform (callback) {
                    callback({
                        get: (name) => mcp.get(name),
                        set: (name, server) => mcp.set(name, server)
                    });

                    return registration;
                }
            },
            session: {
                async hook (name, callback) {
                    sessionHooks.set(name, callback);

                    return registration;
                }
            }
        };

    assert.equal(PostmanPluginDefinition.id, 'postman');
    assert.equal(PostmanPluginDefinition.server, PostmanPlugin);

    await PostmanPluginDefinition.setup(context);

    assert.equal(skills.size, manifestSkills.length);
    assert.equal(skills.get('api-mocking').path,
        path.join(skillsDirectory, 'api-mocking', 'SKILL.md'));
    assert.match(skills.get('api-mocking').content, /# API Mocking/);
    assert.equal(mcp.get('postman').url, 'https://mcp.postman.com/minimal');
    assert.equal(mcp.get('postman').disabled, false);
    assert.equal('enabled' in mcp.get('postman'), false);
    assert.equal(mcp.get('postman').headers['X-Plugin-Version'], packageVersion);

    const event = { system: [] };

    sessionHooks.get('context')(event);
    sessionHooks.get('context')(event);

    assert.equal(event.system.length, 1);
    assert.equal(event.system[0].type, 'text');
    assert.match(event.system[0].text, /`api-engineer` skill/);
});

test('manifest.json lists api-engineer first, the skill postman init names in AGENTS.md', () => {
    assert.equal(manifestSkills[0].name, 'api-engineer',
        '`postman init` routes API work to the first skill; see ENTRY_SKILL in scripts/build-manifest.js');
});

test('reads the shared files from the repository root in a clone', () => {
    assert.equal(assetRoot, path.dirname(packageRoot));
    assert.equal(fs.existsSync(path.join(skillsDirectory, 'api-engineer', 'SKILL.md')), true);
    assert.equal(fs.existsSync(sessionContextFile), true);
});
