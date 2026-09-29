#!/usr/bin/env node
import fs from 'node:fs';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { HOSTS } from './hosts/index.js';
import type { HostId } from './hosts/types.js';
import { type Command, EXIT, run } from './run.js';
import { createSystem } from './system.js';

const COMMANDS: Record<string, Command> = { install: 'install', status: 'status', remove: 'remove', uninstall: 'remove' },
    HOST_IDS = HOSTS.map((host) => host.id),
    USAGE = `Install the Postman plugin into every coding agent on this machine.

Usage: npx @postman/postman-plugin [command] [options]

Commands:
  install     Install into each detected agent, or update it there (default)
  status      Show which agents are detected and whether Postman is installed
  remove      Uninstall from each detected agent (alias: uninstall)

Options:
  --agent <id>  Only these agents; repeat or comma-separate: ${HOST_IDS.join(', ')}
  -y, --yes     Don't ask for confirmation (required when not in a terminal)
  --dry-run     Print what would change without changing anything
  -h, --help    Show this help
  -v, --version Show the version`;

function version (): string {
    const manifest = new URL('../package.json', import.meta.url);

    return (JSON.parse(fs.readFileSync(manifest, 'utf8')) as { version: string }).version;
}

async function confirm (question: string): Promise<boolean> {
    const readline = createInterface({ input: stdin, output: stdout });

    try {
        return !/^n/i.test((await readline.question(question)).trim());
    }
    finally {
        readline.close();
    }
}

function fail (message: string): number {
    console.error(`${message}\n\n${USAGE}`);

    return EXIT.usage;
}

async function main (argv: string[]): Promise<number> {
    let parsed;

    try {
        parsed = parseArgs({
            args: argv,
            allowPositionals: true,
            options: {
                agent: { type: 'string', multiple: true },
                yes: { type: 'boolean', short: 'y' },
                'dry-run': { type: 'boolean' },
                help: { type: 'boolean', short: 'h' },
                version: { type: 'boolean', short: 'v' }
            }
        });
    }
    catch (error) {
        return fail((error as Error).message);
    }

    const { values, positionals } = parsed;

    if (values.help) {
        console.log(USAGE);

        return EXIT.ok;
    }

    if (values.version) {
        console.log(version());

        return EXIT.ok;
    }

    const command = COMMANDS[positionals[0] ?? 'install'],
        agents = (values.agent ?? []).flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean),
        unknown = agents.filter((agent) => !HOST_IDS.includes(agent as HostId));

    if (!command || positionals.length > 1) {
        return fail(`Unknown command: ${positionals.join(' ')}`);
    }

    // An empty selection would mean "every agent", the opposite of what `--agent` asked for.
    if (values.agent && !agents.length) {
        return fail('--agent was given no agent id');
    }

    if (unknown.length) {
        return fail(`Unknown agent: ${unknown.join(', ')}`);
    }

    return run(createSystem({ dryRun: Boolean(values['dry-run']) }), HOSTS, {
        command,
        agents: agents as HostId[],
        yes: Boolean(values.yes),
        isTTY: Boolean(stdin.isTTY),
        confirm
    });
}

process.exitCode = await main(process.argv.slice(2));
