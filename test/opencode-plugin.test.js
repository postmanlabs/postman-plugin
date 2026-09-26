import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
    applyPostmanConfig, packageRoot, PostmanPlugin, sessionContextFile, skillsDirectory,
    toOpenCodeSessionContext
} from '../dist/index.js';

const packageVersion = JSON.parse(
    fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')
).version;

test('registers the packaged skills directory and Postman MCP server', () => {
    const config = {};

    applyPostmanConfig(config);

    assert.deepEqual(config.skills.paths, [skillsDirectory]);
    assert.equal(config.mcp.postman.type, 'remote');
    assert.equal(config.mcp.postman.url, 'https://mcp.postman.com/minimal');
    assert.equal(config.mcp.postman.headers['X-Source'], 'postman-opencode-plugin');
    assert.equal(config.mcp.postman.headers['X-Plugin-Version'], packageVersion);
    assert.equal(
        config.mcp.postman.headers['User-Agent'],
        `postman-opencode-plugin/${packageVersion}`
    );
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

test('resolves package assets in both source and published layouts', () => {
    assert.equal(fs.existsSync(path.join(packageRoot, 'package.json')), true);
    assert.equal(fs.existsSync(path.join(skillsDirectory, 'api-engineer', 'SKILL.md')), true);
    assert.equal(fs.existsSync(sessionContextFile), true);
});
