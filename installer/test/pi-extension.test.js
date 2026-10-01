import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { postmanExtension, toPiSessionContext } from '../dist/pi-extension.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
    { mcpServers } = JSON.parse(fs.readFileSync(path.join(repoRoot, 'mcp.pi.json'), 'utf8')),
    mandate = fs.readFileSync(path.join(repoRoot, 'hooks', 'session-start-context.md'), 'utf8');

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

function startAgent (host, skills) {
    const event = { systemPromptOptions: { sections: {}, skills: skills.map((name) => ({ name })) } };

    for (const handler of host.handlers.before_agent_start ?? []) {
        handler(event);
    }

    return event.systemPromptOptions.sections;
}

test('registers the MCP servers exactly as mcp.pi.json declares them', () => {
    assert.deepEqual(loadExtension().servers, mcpServers);
});

test('adds the session-start mandate as a prompt section, naming skills as Pi does', () => {
    const { postman } = startAgent(loadExtension(), ['api-engineer', 'api-testing']);

    assert.equal(postman, toPiSessionContext(mandate));
    assert.match(postman, /load the `api-engineer` skill/);
    assert.doesNotMatch(postman, /`postman:[a-z0-9-]+`/);
});

test('leaves the prompt alone when api-engineer is not loaded', () => {
    assert.deepEqual(startAgent(loadExtension(), ['api-testing']), {});
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
