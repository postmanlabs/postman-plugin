// A real terminal is required: piping directly to Codex never exercises hook review.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';

export function checkCodexTui ({ command = 'codex', args = [], env, cwd, expectReview = false, timeoutMs = 20000, settleMs = 2000 }) {
    assert.equal(process.platform, 'linux', 'the TUI check needs the Linux script utility');
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`,
        shell = `stty rows 40 cols 120; exec ${[command, ...args].map(quote).join(' ')}`,
        scriptArgs = ['-q', '-e', '-c', shell, '/dev/null'];

    return new Promise((resolve, reject) => {
        const child = spawn('script', scriptArgs, { cwd, env: { ...env, TERM: 'xterm-256color' }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
        let output = '',
            stopping = false,
            failure,
            settled,
            force;

        const stop = (error) => {
                if (stopping) {
                    return;
                }

                stopping = true;
                failure = error;
                clearTimeout(deadline);
                clearTimeout(settled);
                // Interrupt only this test's foreground TUI, never select a trust option.
                child.stdin.write('\x03\x03');
                force = setTimeout(() => {
                    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
                }, 1000);
            },
            deadline = setTimeout(() => stop(new Error(`Codex TUI did not show ${expectReview ? 'hook review' : 'a ready prompt'} before the deadline`)), timeoutMs),
            receive = (chunk) => {
                output += chunk;
                const text = stripVTControlCharacters(output);

                if (/Hooks need review|\d+ hooks? (?:is|are) new or changed/.test(text)) {
                    stop(expectReview ? undefined : new Error('Codex still shows its hook review warning after installation'));
                }
                else if (!expectReview && !settled && /OpenAI Codex/.test(text) && /\/status|harness default/.test(text)) {
                    // The initial loading screen can precede hook review. Wait for the
                    // command hints or the configured model's footer, then allow a
                    // later warning to arrive. A trusted project can omit the hints.
                    settled = setTimeout(() => stop(), settleMs);
                }
            };

        child.stdout.on('data', receive);
        child.stderr.on('data', receive);
        child.stdin.on('error', () => {});
        child.on('error', (error) => { clearTimeout(deadline); clearTimeout(settled); clearTimeout(force); reject(error); });
        child.on('close', () => {
            clearTimeout(deadline);
            clearTimeout(settled);
            clearTimeout(force);
            const text = stripVTControlCharacters(output);

            if (failure || !stopping) {
                reject(new Error(`${failure?.message ?? 'Codex TUI exited before startup was checked'}\n${text.slice(-5000)}`));
            }
            else {
                resolve(text);
            }
        });
    });
}
