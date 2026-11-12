import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
    CLAUDE_MCP = 'mcp.claude-code.json';

function copyOfRepo (t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-manifests-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: repoRoot, encoding: 'utf8' })
        .split('\0').filter((file) => file && fs.existsSync(path.join(repoRoot, file)));
    for (const file of files) {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        fs.copyFileSync(path.join(repoRoot, file), path.join(dir, file));
    }
    execFileSync('git', ['init', '-q'], { cwd: dir });
    return dir;
}

function setClaudeUserAgent (dir, userAgent) {
    const file = path.join(dir, CLAUDE_MCP),
        config = JSON.parse(fs.readFileSync(file, 'utf8'));
    config.mcpServers.postman.headers['User-Agent'] = userAgent;
    fs.writeFileSync(file, JSON.stringify(config, null, 2));
}

function userAgentErrors (dir) {
    const { stderr } = spawnSync(process.execPath, [path.join(dir, '.claude', 'hooks', 'validate-manifests.js')], { cwd: dir, encoding: 'utf8' });
    return stderr.split('\n').filter((line) => line.includes('User-Agent is'));
}

test('the Claude route\'s User-Agent passes as postman-<vendor>-plugin/<manifest version>', (t) => {
    assert.deepEqual(userAgentErrors(copyOfRepo(t)), []);
});

for (const suffix of ['/extra', ' extra', '/']) {
    test(`a User-Agent-only route rejects a User-Agent with trailing ${JSON.stringify(suffix)}`, (t) => {
        const dir = copyOfRepo(t),
            { version } = JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8'));
        setClaudeUserAgent(dir, `postman-claude-code-plugin/${version}${suffix}`);
        assert.equal(userAgentErrors(dir).length, 1);
    });
}
