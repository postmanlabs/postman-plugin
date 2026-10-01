import { versionWarning } from './hosts/minimum-versions.js';
import type { Host, HostId, Outcome, Result, Status } from './hosts/types.js';
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

type Target = { host: Host; status: Status; warning: string | null };
type Report = { host: Host; result: Result };

export const EXIT = { ok: 0, failed: 1, usage: 2, manual: 3 } as const;

const FAILED: Outcome[] = ['failed', 'blocked'];

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
    for (const { host, status, warning } of targets) {
        system.log(`  ${padEnd(host.name, width)}${padEnd(stateLabel(status), 15)}${status.installed === false ? '' : status.detail}`.trimEnd());

        if (warning) {
            system.log(`  ${' '.repeat(width)}warning: ${warning}`);
        }

        for (const note of status.notes) {
            system.log(`  ${' '.repeat(width)}note: ${note}`);
        }
    }
}

function printResult (system: System, { result }: Report): void {
    system.log(`  ${result.outcome}: ${result.message.replaceAll('\n', '\n    ')}`);

    if (result.next) {
        system.log(`  next: ${result.next}`);
    }
}

async function readStatus (system: System, host: Host): Promise<Status> {
    try {
        return await host.status(system);
    }
    catch (error) {
        return { installed: null, detail: `could not read its state: ${error instanceof Error ? error.message : String(error)}`, notes: [] };
    }
}

async function execute (system: System, command: 'install' | 'remove', host: Host): Promise<Result> {
    try {
        const outcome = await host[command](system);

        if (outcome.outcome !== 'done' || system.dryRun) {
            return outcome;
        }

        // An agent CLI that exits 0 without doing the work is caught here, not reported as done.
        const after = await readStatus(system, host),
            expected = command === 'install';

        if (after.installed === null) {
            return { outcome: 'failed', message: `${outcome.message}, but it could not be confirmed: ${after.detail}` };
        }

        return after.installed === expected ?
            outcome :
            { outcome: 'failed', message: `${outcome.message}, but ${host.name} still reports it as ${expected ? 'not installed' : 'installed'}` };
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
        let detected: boolean;

        try {
            detected = await host.detect(system);
        }
        catch (error) {
            const reason = error instanceof Error ? error.message : String(error);

            reports.push({ host, result: { outcome: 'failed', message: `could not check whether ${host.name} is here: ${reason}` } });
            continue;
        }

        if (detected) {
            const status = await readStatus(system, host),
                warning = options.command === 'remove' ? null : await versionWarning(system, host);

            targets.push({ host, status, warning });
        }
        else if (options.agents.length) {
            reports.push({ host, result: { outcome: 'blocked', message: `${host.name} was not found on this machine` } });
        }
    }

    if (!targets.length) {
        system.log(options.agents.length ?
            'None of the requested agents was found.' :
            `No supported coding agent found. Supported: ${joinNames(requested)}.`);
        reports.forEach((report) => system.log(`  ${report.result.message}`));

        // Nothing to remove is a clean remove; nothing to install into is not a successful install.
        return options.command === 'install' || (options.command === 'remove' && reports.length) ? EXIT.failed : EXIT.ok;
    }

    // "Found:" over "not installed" read to agents as "not found"; the header says both things.
    system.log(`Found ${targets.length} coding agent${targets.length === 1 ? '' : 's'}. Postman in each:`);
    printStatuses(system, targets, width);
    reports.forEach((report) => system.log(`  ${padEnd(report.host.name, width)}${report.result.message}`));

    if (options.command === 'status') {
        return EXIT.ok;
    }

    // Every detected adapter gets the command, even one whose status says "not installed":
    // remove also clears duplicates and half-finished installs that status doesn't count.
    const command = options.command;

    if (!options.yes && !system.dryRun) {
        const verb = command === 'install' ? 'install or update Postman in' : 'remove Postman from',
            names = joinNames(targets.map((target) => target.host));

        if (!options.isTTY) {
            system.log(`\nNothing changed: there is no terminal to confirm in. To ${verb} ${names}, re-run with --yes (add --agent <id> for only some).`);

            return EXIT.usage;
        }

        if (!(await options.confirm(`\n${verb[0].toUpperCase()}${verb.slice(1)} ${names}? [Y/n] `))) {
            system.log('Cancelled.');

            return EXIT.failed;
        }
    }

    for (const { host } of targets) {
        system.log(`\n${host.name}`);

        const report = { host, result: await execute(system, command, host) };

        printResult(system, report);
        reports.push(report);
    }

    system.log(`\n${system.dryRun ? 'Dry run, nothing changed' : 'Summary'}:`);

    for (const { host, result } of reports) {
        system.log(`  ${padEnd(host.name, width)}${padEnd(result.outcome, 9)}${result.message.split('\n')[0]}`);
    }

    if (reports.some(({ result }) => FAILED.includes(result.outcome))) {
        return EXIT.failed;
    }

    return reports.some(({ result }) => result.outcome === 'manual') ? EXIT.manual : EXIT.ok;
}
