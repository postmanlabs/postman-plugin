import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { postmanExtension, toPiSessionContext } from '../dist/pi-extension.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
    { mcpServers } = JSON.parse(fs.readFileSync(path.join(repoRoot, 'mcp.pi.json'), 'utf8')),
    mandate = fs.readFileSync(path.join(repoRoot, 'hooks', 'session-start-context.md'), 'utf8'),
    postmanDirMandate = fs.readFileSync(path.join(repoRoot, 'hooks', 'session-start-postman-dir.md'), 'utf8'),
    // Session directories: one without a postman/ directory, one with it, and one with Postman/.
    [noProject, project, upperProject] = ['none', 'repo', 'upper'].map((name) => fs.mkdtempSync(path.join(os.tmpdir(), `postman-pi-${name}-`)));

fs.mkdirSync(path.join(project, 'postman'));
fs.mkdirSync(path.join(upperProject, 'Postman'));

/** A Pi host that records what the extension registers. Pi before 0.99.0 has no `registerMcpServer`. */
function loadExtension ({ registersMcp = true } = {}) {
    const host = {
        servers: {},
        handlers: {},
        registerMcpServer (name, config) {
            host.servers[name] = config;
        },
        on (event, handler) {
            (host.handlers[event] ||= []).push(handler);
        }
    };

    if (!registersMcp) {
        delete host.registerMcpServer;
    }

    postmanExtension(repoRoot)(host);

    return host;
}

/** What the extension shows the user when a session starts. */
function startSession (host) {
    const notices = [],
        ui = { notify: (message, type) => notices.push({ message, type }) };

    for (const handler of host.handlers.session_start ?? []) {
        handler({ type: 'session_start', reason: 'startup' }, { ui });
    }

    return notices;
}

/** What Pi sends `before_agent_start`. Prompt sections arrived in Pi 0.86.0. */
function agentStartEvent (skills, { sections = true } = {}) {
    return {
        systemPrompt: 'base',
        systemPromptOptions: { ...(sections && { sections: {} }), skills: skills.map((name) => ({ name })) }
    };
}

/** What each `before_agent_start` handler returns. */
function agentStartResults (host, event, cwd = noProject) {
    return (host.handlers.before_agent_start ?? []).map((handler) => handler(event, { cwd }));
}

function startAgent (host, skills, cwd) {
    const event = agentStartEvent(skills);

    agentStartResults(host, event, cwd);

    return event.systemPromptOptions.sections;
}

test('registers the MCP servers exactly as mcp.pi.json declares them', () => {
    assert.deepEqual(loadExtension().servers, mcpServers);
});

test('adds the light note as a prompt section in a project without postman/, naming skills as Pi does', () => {
    const { postman } = startAgent(loadExtension(), ['api-engineer', 'api-testing']);

    assert.equal(postman, toPiSessionContext(mandate));
    assert.match(postman, /`api-engineer` skill/);
    assert.doesNotMatch(postman, /`postman:[a-z0-9-]+`/);
});

test('adds the postman/ mandate in a project with a postman/ directory, and not for Postman/', () => {
    const host = loadExtension();

    assert.equal(startAgent(host, ['api-engineer'], project).postman, toPiSessionContext(postmanDirMandate));
    assert.match(startAgent(host, ['api-engineer'], project).postman, /load the `api-engineer` skill/);
    assert.equal(startAgent(host, ['api-engineer'], upperProject).postman, toPiSessionContext(mandate));
});

test('leaves the prompt alone when api-engineer is not loaded', () => {
    assert.deepEqual(startAgent(loadExtension(), ['api-testing']), {});
});

test('returns no prompt to a Pi with prompt sections, where it would replace them', () => {
    assert.deepEqual(agentStartResults(loadExtension(), agentStartEvent(['api-engineer'])), [undefined]);
});

test('on a Pi without prompt sections, appends the mandate to the system prompt as a <postman> block', () => {
    const host = loadExtension({ registersMcp: false });

    assert.deepEqual(agentStartResults(host, agentStartEvent(['api-engineer'], { sections: false })), [{ systemPrompt: `base\n\n<postman>\n${toPiSessionContext(mandate)}\n</postman>` }]);
    assert.deepEqual(agentStartResults(host, agentStartEvent(['api-testing'], { sections: false })), [undefined]);
});

test('shows no notice when Pi can register the MCP server', () => {
    assert.deepEqual(startSession(loadExtension()), []);
});

test('on a Pi without registerMcpServer, still adds the mandate and warns that the MCP server needs 0.99.0', () => {
    const host = loadExtension({ registersMcp: false });

    assert.equal(startAgent(host, ['api-engineer']).postman, toPiSessionContext(mandate));
    assert.deepEqual(startSession(host), [{ message: 'Postman\'s MCP server needs Pi 0.99.0 or later; run `pi update` to upgrade Pi.', type: 'warning' }]);
});

test('rewrites only backticked postman:<skill> names', () => {
    assert.equal(toPiSessionContext('use `postman:api-mocking`, not postman:bootstrap'), 'use `api-mocking`, not postman:bootstrap');
});
