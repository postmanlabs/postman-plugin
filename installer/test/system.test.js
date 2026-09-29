import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSystem } from '../dist/system.js';

const system = createSystem({ log: () => {} }),
    permissionsApply = process.platform !== 'win32' && process.getuid?.() !== 0;

test('output split in the middle of a UTF-8 character still decodes', async () => {
    // Writes the two bytes of "é" separately, so they arrive as two chunks.
    const script = 'process.stdout.write(Buffer.from([0xc3])); setTimeout(() => process.stdout.write(Buffer.from([0xa9])), 50);',
        { code, stdout } = await system.probe(process.execPath, ['-e', script]);

    assert.equal(code, 0);
    assert.equal(stdout, 'é');
});

test('a command that reads stdin gets EOF instead of waiting for input', { timeout: 10000 }, async () => {
    const script = "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('eof'));",
        { code, stdout } = await system.probe(process.execPath, ['-e', script]);

    assert.equal(code, 0);
    assert.equal(stdout, 'eof');
});

test('readFile is null only for a file that does not exist', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postman-plugin-system-'));

    fs.writeFileSync(path.join(dir, 'a-file'), '');

    assert.equal(await system.readFile(path.join(dir, 'missing.ts')), null);
    assert.equal(await system.readFile(path.join(dir, 'a-file', 'below-it.ts')), null);
    await assert.rejects(system.readFile(dir));
});

test('exists is false only for a path that does not exist', { skip: !permissionsApply && 'needs POSIX permissions and a non-root user' }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postman-plugin-system-')),
        locked = path.join(dir, 'locked');

    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(dir, 'a-file'), '');
    fs.chmodSync(locked, 0o000);

    try {
        assert.equal(await system.exists(path.join(dir, 'missing')), false);
        assert.equal(await system.exists(path.join(dir, 'a-file', 'below-it')), false);
        await assert.rejects(system.exists(path.join(locked, 'inside')), { code: 'EACCES' });
    }
    finally {
        fs.chmodSync(locked, 0o700);
    }
});

test('readFile throws for a file that exists but cannot be read', { skip: !permissionsApply && 'needs POSIX permissions and a non-root user' }, async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'postman-plugin-system-')), 'write-only.ts');

    fs.writeFileSync(file, 'export default {};\n', { mode: 0o200 });

    await assert.rejects(system.readFile(file), { code: 'EACCES' });
});

test('an npm-style .cmd shim on PATH runs through cmd.exe with its arguments intact', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
    // A space in the directory exercises quoting of the shim's own path, as under "Program Files".
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postman plugin cmd-')),
        previous = process.env.PATH;

    fs.writeFileSync(path.join(dir, 'fakecli.cmd'), '@echo off\r\necho [%1] [%2] [%3]\r\nexit /b 3\r\n');
    process.env.PATH = `${dir}${path.delimiter}${previous}`;

    try {
        const windows = createSystem({ log: () => {} }),
            probed = await windows.probe('fakecli', ['plugin', 'two words', 'x@y']),
            ran = await windows.run('fakecli', ['list'], { env: { DO_NOT_TRACK: '1' } });

        assert.match(await windows.which('fakecli'), /fakecli\.cmd$/i);
        assert.equal(probed.code, 3);
        assert.equal(probed.stdout.trim(), '[plugin] ["two words"] [x@y]');
        assert.equal(ran.code, 3);
        assert.equal(ran.stdout.trim(), '[list] [] []');
    }
    finally {
        process.env.PATH = previous;
    }
});
