import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
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

test('the repo root is installable with `opencode plugin add github:...` and versions with this package', () => {
    const root = JSON.parse(fs.readFileSync(path.join(assetRoot, 'package.json'), 'utf8'));

    assert.equal(root.version, packageVersion);
    assert.equal(root.exports['./server'], './opencode/src/index.ts');
    assert.equal(root.main, root.exports['./server']);
    assert.equal(root.scripts, undefined, 'npm runs prepare/install scripts of a Git dependency in every user\'s install');
    assert.equal(root.dependencies, undefined);

    for (const file of [path.posix.normalize(root.main), 'opencode/package.json', 'skills', 'hooks/session-start-context.md', 'manifest.json', 'mcp.opencode.json']) {
        assert.ok(fs.existsSync(path.join(assetRoot, file)), `${file} does not exist`);
        assert.ok(root.files.some((entry) => file === entry.replace(/\/$/, '') || file.startsWith(entry)), `the installed package leaves out ${file}, which the entrypoint reads`);
    }
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
