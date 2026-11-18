import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSystem } from '../dist/system.js';

for (const shim of [false, true]) {
    for (const timeout of [false, true]) {
        test(`Windows RPC ${shim ? 'cmd shim' : 'native process'} releases descendants after ${timeout ? 'a timeout' : 'success'}`, {
            skip: process.platform !== 'win32' && 'Windows only', timeout: 20000
        }, async (t) => {
            const root = fs.mkdtempSync(path.join(os.tmpdir(), 'postman rpc tree-')),
                locked = path.join(root, 'working-directory'),
                server = path.join(root, 'server.cjs'),
                launcher = path.join(root, 'server.cmd'),
                system = createSystem({ log: () => {} });
            let pids = [];

            t.after(() => {
                for (const pid of pids) {
                    spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', timeout: 5000 });
                }
                fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
            });

            fs.mkdirSync(locked);
            // The descendant's working directory cannot be removed while it is alive on Windows.
            fs.writeFileSync(server, `
                const {spawn} = require('node:child_process');
                const leaf = spawn(process.execPath, ['-e', 'process.send(process.pid); setInterval(()=>{}, 1000);'], {
                    cwd: ${JSON.stringify(locked)}, stdio: ['ignore', 'ignore', 'ignore', 'ipc']
                });
                const ready = new Promise(resolve => leaf.once('message', resolve));
                require('node:readline').createInterface({input: process.stdin}).on('line', async line => {
                    const request = JSON.parse(line);
                    const pid = await ready;
                    if (request.method !== 'hang') {
                        process.stdout.write(JSON.stringify({id: request.id, result: [process.pid, pid]}) + '\\n');
                    }
                });
                // Reproduces a launcher that exits on EOF before taskkill can find its descendants.
                process.stdin.on('end', () => process.exit(0));
            `);
            fs.writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "${server}"\r\n`);

            const session = system.withJsonRpc(shim ? launcher : process.execPath, shim ? [] : [server], async (rpc) => {
                pids = await rpc.request('pids', {});
                if (timeout) {
                    await rpc.request('hang', {});
                }
            }, 2000);

            if (timeout) {
                await assert.rejects(session, /timed out/);
            }
            else {
                await session;
            }

            assert.equal(pids.length, 2);
            for (const pid of pids) {
                assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `process ${pid} survived RPC teardown`);
            }
            fs.rmSync(locked, { recursive: true });
        });
    }
}
