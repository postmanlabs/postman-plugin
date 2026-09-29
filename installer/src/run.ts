import type { Host, HostId, Result, Status } from './hosts/types.js';
import type { System } from './system.js';

export type Command = 'install' | 'status' | 'remove';

export type RunOptions = {
    command: Command;
    /** Empty means every host this installer supports. */
    agents: HostId[];
    yes: boolean;
    isTTY: boolean;
    confirm: (question: string) => Promise<boolean>;
};

type Target = { host: Host; status: Status };
type Report = { host: Host; result: Result };

export const EXIT = { ok: 0, failed: 1, usage: 2 } as const;

function padEnd (text: string, width: number): string {
    return text + ' '.repeat(Math.max(1, width - text.length));
}

function stateLabel (status: Status): string {
    if (status.installed === null) {
        return 'unknown';
    }

    return status.installed ? 'installed' : 'not installed';
}

function printStatuses (system: System, targets: Target[], width: number): void {
    for (const { host, status } of targets) {
        system.log(`  ${padEnd(host.name, width)}${padEnd(stateLabel(status), 15)}${status.installed === false ? '' : status.detail}`.trimEnd());

        for (const note of status.notes) {
            system.log(`  ${' '.repeat(width)}note: ${note}`);
        }
    }
}

function printResult (system: System, { result }: Report): void {
    system.log(`  ${result.outcome}: ${result.message}`);

    if (result.next) {
        system.log(`  next: ${result.next}`);
    }
}

async function execute (system: System, command: 'install' | 'remove', host: Host): Promise<Result> {
    try {
        const outcome = await host[command](system);

        if (command === 'install' && outcome.outcome === 'done' && !system.dryRun &&
            (await host.status(system)).installed === false) {
            return { outcome: 'failed', message: `${outcome.message}, but ${host.name} still reports it as not installed` };
        }

        return outcome;
    }
    catch (error) {
        return { outcome: 'failed', message: error instanceof Error ? error.message : String(error) };
    }
}

function joinNames (hosts: Host[]): string {
    const names = hosts.map((host) => host.name);

    return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names.join('');
}

/** Returns the process exit code. */
export async function run (system: System, hosts: readonly Host[], options: RunOptions): Promise<number> {
    const requested = options.agents.length ? hosts.filter((host) => options.agents.includes(host.id)) : [...hosts],
        width = Math.max(...hosts.map((host) => host.name.length)) + 2,
        reports: Report[] = [],
        targets: Target[] = [];

    for (const host of requested) {
        if (await host.detect(system)) {
            targets.push({ host, status: await host.status(system) });
        }
        else if (options.agents.length) {
            reports.push({ host, result: { outcome: 'blocked', message: `${host.name} was not found on this machine` } });
        }
    }

    if (!targets.length) {
        system.log(`No supported coding agent found. Supported: ${joinNames(requested)}.`);
        reports.forEach((report) => system.log(`  ${report.result.message}`));

        return reports.length && options.command !== 'status' ? EXIT.failed : EXIT.ok;
    }

    system.log('Found:');
    printStatuses(system, targets, width);
    reports.forEach((report) => system.log(`  ${padEnd(report.host.name, width)}${report.result.message}`));

    if (options.command === 'status') {
        return EXIT.ok;
    }

    const command = options.command,
        selected = command === 'remove' ? targets.filter((target) => target.status.installed !== false) : targets;

    if (!selected.length) {
        system.log('\nNothing to remove.');

        return reports.length ? EXIT.failed : EXIT.ok;
    }

    if (!options.yes && !system.dryRun) {
        if (!options.isTTY) {
            system.log('\nNot running in a terminal, so there is no one to confirm. Re-run with --yes.');

            return EXIT.usage;
        }

        const verb = command === 'install' ? 'Install or update Postman in' : 'Remove Postman from';

        if (!(await options.confirm(`\n${verb} ${joinNames(selected.map((target) => target.host))}? [Y/n] `))) {
            system.log('Cancelled.');

            return EXIT.failed;
        }
    }

    for (const { host } of selected) {
        system.log(`\n${host.name}`);

        const report = { host, result: await execute(system, command, host) };

        printResult(system, report);
        reports.push(report);
    }

    system.log(`\n${system.dryRun ? 'Dry run, nothing changed' : 'Summary'}:`);

    for (const { host, result } of reports) {
        system.log(`  ${padEnd(host.name, width)}${padEnd(result.outcome, 9)}${result.message.split('\n')[0]}`);
    }

    return reports.some(({ result }) => result.outcome === 'failed' || result.outcome === 'blocked') ? EXIT.failed : EXIT.ok;
}
