import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
    apply, emptySimulation, likelyCause, MAX_REQUESTS, parseLine, takeLines, type Simulation
} from '../plugin/simulation-log.ts';

const fixture = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'simulate-run.log'), 'utf8'
);

function ingest (output: string, chunkSize = output.length): Simulation {
    const simulation = emptySimulation();
    let pending = '';

    for (let offset = 0; offset < output.length; offset += chunkSize) {
        const taken = takeLines(pending, output.slice(offset, offset + chunkSize));

        pending = taken.pending;

        for (const line of taken.lines) {
            const event = parseLine(line);

            if (event) {
                apply(simulation, event);
            }
        }
    }

    return simulation;
}

test('reads the simulation name, mocks, ports and configured faults from `simulate run` output', () => {
    const simulation = ingest(fixture);

    assert.equal(simulation.name, 'checkout-degraded');
    assert.deepEqual(simulation.mocks.map(({ name, port }) => ({ name, port })), [
        { name: 'cart', port: 4611 },
        { name: 'payments', port: 4612 }
    ]);
    assert.deepEqual(simulation.mocks.map((mock) => mock.faults.map((fault) => fault.label)), [
        ['latency 300ms'],
        ['chaos 40%', 'rate limit 5/min']
    ]);
});

test('records one entry per completed request, with status and duration', () => {
    const { requests } = ingest(fixture);

    assert.equal(requests.length, 10);
    assert.deepEqual(requests[0], {
        time: '13:15:21.672', mock: 'cart', method: 'GET', path: '/cart', status: 200, durationMs: 360
    });
    assert.deepEqual(requests.map((request) => request.status), [200, 404, 201, 201, 500, 400, 400, 500, 400, 500]);
});

test('marks mocks stopped when the simulation shuts down', () => {
    assert.deepEqual(ingest(fixture).mocks.map((mock) => mock.stopped), [true, true]);
});

test('gives the same result however the output is split into pages', () => {
    assert.deepEqual(ingest(fixture, 7), ingest(fixture));
});

test('strips ANSI colour codes before parsing', () => {
    const coloured = '  \x1B[90m13:15:21.672\x1B[39m  \x1B[32mrequest completed  \x1B[39m ' +
        '\x1B[1mcart           \x1B[22m GET http://localhost:4611/cart \x1B[32m200\x1B[39m \x1B[90m360ms\x1B[39m';

    assert.deepEqual(parseLine(coloured), {
        kind: 'request',
        request: { time: '13:15:21.672', mock: 'cart', method: 'GET', path: '/cart', status: 200, durationMs: 360 }
    });
});

test('parses mock names longer than the padded source column', () => {
    const line = '  13:15:18.172  mock started        inventory-service-v2 Mock server "inventory-service-v2" active on :4700';

    assert.deepEqual(parseLine(line), { kind: 'mock-started', mock: 'inventory-service-v2', port: 4700 });
});

test('surfaces a CLI error such as a port already in use', () => {
    assert.deepEqual(parseLine('Error: Port 4611 is already in use (needed by mock \'cart\')'), {
        kind: 'error', message: 'Port 4611 is already in use (needed by mock \'cart\')'
    });
});

test('infers which configured fault explains a response', () => {
    const [cart, payments] = ingest(fixture).mocks,
        request = { time: '', mock: 'payments', method: 'POST', path: '/checkout', durationMs: 0 };

    assert.equal(likelyCause({ ...request, status: 500 }, payments), 'chaos');
    assert.equal(likelyCause({ ...request, status: 429 }, payments), 'rate limited');
    assert.equal(likelyCause({ ...request, status: 400 }, payments), undefined);
    assert.equal(likelyCause({ ...request, mock: 'cart', status: 200 }, cart), '+300ms latency');
    assert.equal(likelyCause({ ...request, status: 503 }, {
        name: 'x', stopped: false, faults: [{ type: 'error', label: 'error 503', value: 503 }]
    }), 'injected error');
});

test('keeps only the most recent requests', () => {
    const simulation = emptySimulation();

    for (let index = 0; index < MAX_REQUESTS + 5; index++) {
        apply(simulation, {
            kind: 'request',
            request: { time: String(index), mock: 'cart', method: 'GET', path: '/', status: 200, durationMs: 1 }
        });
    }

    assert.equal(simulation.requests.length, MAX_REQUESTS);
    assert.equal(simulation.requests[0].time, '5');
});
