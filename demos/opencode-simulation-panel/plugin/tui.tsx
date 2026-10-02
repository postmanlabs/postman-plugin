import fs from 'node:fs';
import path from 'node:path';
import { TextAttributes } from '@opentui/core';
import { Plugin, usePlugin } from '@opencode/plugin/tui';
import type { Context, PanelInput } from '@opencode/plugin/tui/context';
import { createEffect, For, Show } from 'solid-js';
import {
    apply, emptySimulation, isFailure, likelyCause, parseLine, takeLines, type Mock, type Request, type Simulation
} from './simulation-log.ts';

const PANEL = 'postman.simulation',
    SIMULATE_RUN = /(?:^|[;&|(]\s*)(?:\S*\/)?(?:npx\s+)?postman\s+simulate\s+run\b/,
    SIMULATIONS_DIRECTORY = path.join('postman', 'simulations'),
    PAGE_BYTES = 64 * 1024,
    POLL_MS = 250,
    FOCUS_RETURN_MS = 100,
    NO_SESSION_MESSAGE = 'Simulation running. The panel opens once you are in a session.';

type ShellStatus = 'running' | 'exited' | 'timeout' | 'killed';
type Shell = { id: string; command: string; cwd: string; status: ShellStatus; exit?: number };

type Watch = {
    shellID?: string;
    command?: string;
    status?: ShellStatus;
    exit?: number;
    cursor: number;
    pending: string;
    readError?: string;
    simulation: Simulation;
};

function idle (): Watch {
    return { cursor: 0, pending: '', simulation: emptySimulation() };
}

function isSimulation (shell: Shell, directory: string): boolean {
    const inProject = shell.cwd === directory || shell.cwd.startsWith(directory + path.sep);

    return inProject && SIMULATE_RUN.test(shell.command);
}

function simulationFiles (directory: string): string[] {
    try {
        return fs.readdirSync(path.join(directory, SIMULATIONS_DIRECTORY))
            .filter((file) => file.endsWith('.sim.yaml'))
            .map((file) => path.join(SIMULATIONS_DIRECTORY, file));
    }
    catch {
        return [];
    }
}

function shellQuote (value: string): string {
    return /^[\w./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function percentile (values: number[], fraction: number): number {
    const sorted = [...values].sort((a, b) => a - b);

    return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] : 0;
}

function fit (value: string, width: number): string {
    if (value.length <= width) {
        return value.padEnd(width);
    }

    return width > 1 ? `${value.slice(0, width - 1)}…` : value.slice(0, width);
}

function statusColor (context: Context, status: number | undefined) {
    const feedback = context.theme.text.feedback;

    if (status === undefined || status >= 500) {
        return feedback.error.base;
    }

    return status >= 400 ? feedback.warning.base : feedback.success.base;
}

function RequestRow (props: { request: Request; mock: Mock | undefined; mockWidth: number; width: number }) {
    const context = usePlugin(),
        theme = context.theme,
        cause = () => likelyCause(props.request, props.mock) ?? '',
        failed = () => isFailure(props.request),
        fixed = () => 9 + 4 + 7 + props.mockWidth + 1 + 7,
        pathWidth = () => Math.max(8, props.width - fixed() - cause().length - 1);

    return (
        <text wrapMode="none" height={1} flexShrink={0}>
            <span style={{ fg: theme.text.muted }}>{props.request.time.slice(0, 8)} </span>
            <span style={{ fg: statusColor(context, props.request.status), attributes: TextAttributes.BOLD }}>
                {String(props.request.status ?? '---')}{' '}
            </span>
            <span style={{ fg: theme.text.muted }}>{`${props.request.durationMs}ms`.padStart(6)} </span>
            <span style={{ fg: theme.text.base }}>{fit(props.request.mock, props.mockWidth)} </span>
            <span style={{ fg: theme.text.base, attributes: TextAttributes.BOLD }}>{fit(props.request.method, 7)}</span>
            <span style={{ fg: theme.text.base }}>{fit(props.request.path, pathWidth())} </span>
            <span style={{ fg: failed() ? theme.text.feedback.error.base : theme.text.feedback.info.base }}>{cause()}</span>
        </text>
    );
}

function MockLine (props: { mock: Mock; requests: Request[]; mockWidth: number; live: boolean }) {
    const theme = usePlugin().theme,
        own = () => props.requests.filter((request) => request.mock === props.mock.name),
        failed = () => own().filter(isFailure).length;

    return (
        <text wrapMode="none" height={1} flexShrink={0}>
            <span style={{ fg: props.live && !props.mock.stopped ? theme.text.feedback.success.base : theme.text.muted }}>● </span>
            <span style={{ fg: theme.text.base, attributes: TextAttributes.BOLD }}>{fit(props.mock.name, props.mockWidth)} </span>
            <span style={{ fg: theme.text.muted }}>{`:${props.mock.port ?? '?'}`.padEnd(7)}</span>
            <span style={{ fg: theme.text.feedback.warning.base }}>
                {props.mock.faults.map((fault) => fault.label).join(' · ') || 'no faults'}
            </span>
            <span style={{ fg: theme.text.muted }}>{`  ${own().length} req · ${failed()} failed`}</span>
        </text>
    );
}

function SimulationPanel (props: { panel: PanelInput; watch: Watch; stop: () => void; clear: () => void }) {
    const context = usePlugin(),
        theme = context.theme,
        simulation = () => props.watch.simulation,
        requests = () => simulation().requests,
        width = () => Math.max(20, props.panel.width - 2),
        mockWidth = () => Math.min(16, Math.max(4, ...simulation().mocks.map((mock) => mock.name.length))),
        mockNamed = (name: string) => simulation().mocks.find((mock) => mock.name === name),
        failed = () => requests().filter(isFailure).length,
        durations = () => requests().map((request) => request.durationMs),
        live = () => props.watch.status === 'running',
        state = () => {
            if (!props.watch.shellID) {
                return { label: 'no simulation', color: theme.text.muted };
            }

            if (live()) {
                return { label: '● live', color: theme.text.feedback.success.base };
            }

            return { label: props.watch.exit ? `stopped · exit ${props.watch.exit}` : 'stopped', color: theme.text.muted };
        },
        summary = () => {
            const total = requests().length,
                share = total ? Math.round((failed() / total) * 100) : 0,
                average = total ? Math.round(durations().reduce((sum, value) => sum + value, 0) / total) : 0;

            return `${total} request${total === 1 ? '' : 's'} · ${failed()} failed (${share}%) · avg ${average}ms · p95 ${percentile(durations(), 0.95)}ms`;
        },
        footer = () => {
            const focus = context.keymap.shortcuts('pane.focus.right')[0],
                back = context.keymap.shortcuts('pane.focus.left')[0];

            if (props.panel.focused) {
                return `s stop · f fullscreen · c clear${back ? ` · ${back} back` : ''}`;
            }

            return `${focus ? `${focus} or click` : 'click'} to focus · /simulation stop`;
        };

    context.keymap.layer(() => ({
        commands: [
            { id: 'postman.simulation.stop', title: 'Stop simulation', group: 'Postman', bind: 's', run: props.stop },
            { id: 'postman.simulation.fullscreen', title: 'Toggle fullscreen', group: 'Postman', bind: 'f', run: props.panel.toggleFullscreen },
            { id: 'postman.simulation.clear', title: 'Clear requests', group: 'Postman', bind: 'c', run: props.clear }
        ]
    }));

    return (
        <box flexDirection="column" flexGrow={1} minHeight={0} paddingLeft={1} paddingRight={1} gap={1}>
            <box flexDirection="row" gap={2} height={1} flexShrink={0}>
                <text fg={theme.text.base} attributes={TextAttributes.BOLD} wrapMode="none" flexGrow={1}>
                    {`Postman simulation${simulation().name ? ` · ${simulation().name}` : ''}`}
                </text>
                <text fg={state().color} wrapMode="none">{state().label}</text>
            </box>
            <Show
                when={props.watch.shellID}
                fallback={
                    <text fg={theme.text.muted} wrapMode="word">
                        No simulation is running. Ask the agent to start one in the background
                        (postman simulate run postman/simulations/NAME.sim.yaml), or run /simulation.
                    </text>
                }
            >
                <Show when={simulation().error ?? props.watch.readError}>
                    {(message) => <text fg={theme.text.feedback.error.base} wrapMode="word">{message()}</text>}
                </Show>
                <box flexDirection="column" flexShrink={0} height={simulation().mocks.length}>
                    <For each={simulation().mocks}>
                        {(mock) => <MockLine mock={mock} requests={requests()} mockWidth={mockWidth()} live={live()} />}
                    </For>
                </box>
                <text fg={theme.text.muted} wrapMode="none" height={1} flexShrink={0}>{summary()}</text>
                <scrollbox flexGrow={1} minHeight={0} stickyScroll stickyStart="bottom" scrollbarOptions={{ visible: false }}>
                    <Show
                        when={requests().length}
                        fallback={<text fg={theme.text.muted}>{live() ? 'Waiting for traffic…' : 'No requests recorded.'}</text>}
                    >
                        <For each={requests()}>
                            {(request) => (
                                <RequestRow request={request} mock={mockNamed(request.mock)} mockWidth={mockWidth()} width={width()} />
                            )}
                        </For>
                    </Show>
                </scrollbox>
            </Show>
            <text fg={theme.text.muted} wrapMode="none" height={1} flexShrink={0}>{footer()}</text>
        </box>
    );
}

export default Plugin.define({
    id: 'postman.simulation-panel',
    setup (context) {
        const location = { directory: (context.location ?? context.data.location.default()).directory },
            [watch, update] = context.storage.memory<Watch>('watch', { initial: idle() });
        let timer: ReturnType<typeof setTimeout> | undefined,
            disposed = false,
            openWhenInSession = false;

        function schedule (delay: number) {
            clearTimeout(timer);

            if (!disposed) {
                timer = setTimeout(poll, delay);
            }
        }

        async function poll () {
            const id = watch.shellID;
            let more = false;

            if (!id || disposed) {
                return;
            }

            try {
                const page = (await context.client.shell.output({ id, location, cursor: watch.cursor, limit: PAGE_BYTES })).data;

                if (disposed || watch.shellID !== id) {
                    return;
                }

                update((draft) => {
                    const taken = takeLines(draft.pending, page.output);

                    draft.cursor = page.cursor;
                    draft.pending = taken.pending;
                    draft.readError = undefined;

                    for (const line of taken.lines) {
                        const event = parseLine(line);

                        if (event) {
                            apply(draft.simulation, event);
                        }
                    }
                });
                more = page.cursor < page.size;
            }
            catch (error) {
                if (watch.status !== 'running') {
                    return;
                }

                update((draft) => {
                    draft.readError = `Unable to read simulation output: ${error instanceof Error ? error.message : String(error)}`;
                });
            }

            if (more || watch.status === 'running') {
                schedule(more ? 0 : POLL_MS);
            }
        }

        // Opening a panel focuses it; hand focus back so the prompt keeps taking input.
        // `pane.focus.left` only becomes reachable once the host has mounted the panel, hence the delay.
        function openPanel (): boolean {
            const opened = context.ui.panel.open(PANEL);

            openWhenInSession = !opened;

            if (opened) {
                setTimeout(() => context.keymap.dispatch('pane.focus.left'), FOCUS_RETURN_MS);
            }

            return opened;
        }

        function attach (shell: Shell, announce: boolean) {
            if (watch.shellID !== shell.id) {
                update((draft) => {
                    Object.assign(draft, idle(), { shellID: shell.id, command: shell.command, status: shell.status, exit: shell.exit });
                });
            }

            schedule(0);

            if (!announce) {
                return;
            }

            context.ui.toast.show({
                title: 'Postman simulation',
                message: openPanel() ? 'Streaming live traffic · /simulation' : NO_SESSION_MESSAGE,
                variant: 'info'
            });
        }

        function markEnded (id: string, status: ShellStatus, exit?: number) {
            if (watch.shellID !== id) {
                return;
            }

            update((draft) => {
                draft.status = status;
                draft.exit = exit;
            });
            schedule(0);
        }

        async function start (file: string) {
            await context.client.shell.create({
                location,
                command: `postman simulate run ${shellQuote(file)}`,
                cwd: location.directory,
                timeout: 0,
                metadata: { source: 'postman.simulation-panel' }
            });
        }

        async function chooseAndStart () {
            const files = simulationFiles(location.directory),
                file = files.length > 1 ?
                    await context.ui.dialog.select({
                        title: 'Start a Postman simulation',
                        options: files.map((value) => ({ title: path.basename(value, '.sim.yaml'), value, description: value }))
                    }) :
                    files[0];

            if (file) {
                return start(file);
            }

            if (!files.length) {
                context.ui.toast.show({
                    title: 'Postman simulation',
                    message: `No *.sim.yaml under ${SIMULATIONS_DIRECTORY}. Run /simulation <file>, or ask the agent to start one.`,
                    variant: 'warning'
                });
            }
        }

        async function runningSimulations (): Promise<Shell[]> {
            await context.data.shell.sync(location);

            return (context.data.shell.list(location) ?? []).filter((shell) => shell.status === 'running' && isSimulation(shell, location.directory));
        }

        async function stopAll () {
            const running = await runningSimulations();

            await Promise.all(running.map((shell) => context.client.shell.remove({ id: shell.id, location })));

            if (!running.length) {
                context.ui.toast.show({ title: 'Postman simulation', message: 'No simulation is running.', variant: 'info' });
            }
        }

        async function command (input: string) {
            let running: Shell | undefined;

            if (input === 'stop') {
                return stopAll();
            }

            if (input) {
                return start(input);
            }

            if (watch.status !== 'running') {
                running = (await runningSimulations()).at(-1);

                if (!running) {
                    // The new shell's `shell.created` event attaches it and opens the panel.
                    return chooseAndStart();
                }

                attach(running, false);
            }

            if (!openPanel()) {
                context.ui.toast.show({ title: 'Postman simulation', message: NO_SESSION_MESSAGE, variant: 'info' });
            }
        }

        const unsubscribe = [
            context.data.on('shell.created', (event) => {
                if (isSimulation(event.data.info, location.directory)) {
                    attach(event.data.info, true);
                }
            }),
            context.data.on('shell.exited', (event) => markEnded(event.data.id, event.data.status, event.data.exit)),
            context.data.on('shell.deleted', (event) => markEnded(event.data.id, 'killed')),
            context.ui.slot({
                append: 'session.panel',
                render: (panel) => (
                    <Show when={panel.name === PANEL}>
                        <SimulationPanel
                            panel={panel}
                            watch={watch}
                            stop={() => void stopAll()}
                            clear={() => update((draft) => { draft.simulation.requests = []; })}
                        />
                    </Show>
                )
            }),
            context.ui.slot({
                append: 'app',
                render: () => {
                    createEffect(() => {
                        // The session frame mounts after the route changes, so give it a beat before opening.
                        if (context.ui.router.current().type === 'session' && openWhenInSession) {
                            setTimeout(openPanel, FOCUS_RETURN_MS);
                        }
                    });

                    context.keymap.layer(() => ({
                        mode: 'global',
                        commands: [{
                            id: 'postman.simulation',
                            title: 'Postman simulation panel',
                            description: 'Show live traffic from a running `postman simulate run`',
                            group: 'Postman',
                            palette: true,
                            slash: { name: 'simulation', aliases: ['sim'], arguments: true },
                            run: (input) => command(input?.trim() ?? '')
                        }]
                    }));

                    return null;
                }
            })
        ];

        void runningSimulations().then((running) => {
            const current = running.find((shell) => shell.id === watch.shellID) ?? running.at(-1);

            if (current) {
                attach(current, false);
            }
            else if (watch.shellID && watch.status === 'running') {
                markEnded(watch.shellID, 'exited');
            }
        }).catch(() => undefined);

        return () => {
            disposed = true;
            clearTimeout(timer);

            for (const stop of unsubscribe) {
                stop();
            }
        };
    }
});
