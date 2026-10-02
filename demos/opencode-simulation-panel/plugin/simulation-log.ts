export type FaultType = 'latency' | 'error' | 'rate_limit' | 'chaos';

export type Fault = { type: string; label: string; value?: number };

export type Mock = { name: string; port?: number; faults: Fault[]; stopped: boolean };

export type Request = {
    time: string;
    mock: string;
    method: string;
    path: string;
    status?: number;
    durationMs: number;
};

export type Simulation = {
    name?: string;
    mocks: Mock[];
    requests: Request[];
    logs: string[];
    error?: string;
};

export type Event =
    | { kind: 'simulation'; name: string }
    | { kind: 'mock-started'; mock: string; port: number }
    | { kind: 'mock-stopped'; mock: string }
    | { kind: 'fault'; mock: string; fault: Fault }
    | { kind: 'request'; request: Request }
    | { kind: 'log'; text: string }
    | { kind: 'error'; message: string };

export const MAX_REQUESTS = 500;
const MAX_LOGS = 50;

const ANSI = /\x1B\[[0-9;?]*[ -/]*[@-~]|\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g;
const EVENT_LINE = /^\s*(\d{2}:\d{2}:\d{2}\.\d{3})\s+(mock started|mock stopped|scenario applied|request completed)\s+(.*)$/;
const SIMULATION_HEADER = /^(?:║|▸)\s*Simulation:\s+(.*?)\s*║?\s*$/;
const MOCK_STARTED = /^.*?\s*Mock server "(.*)" active on :(\d+)$/;
const MOCK_STOPPED = /^.*?\s*Mock server "(.*)" stopped$/;
const FAULT_CONFIGURED = /^(.*?)\s+simulation configured — (\w+)(?: \((.*)\))?$/;
const REQUEST_COMPLETED = /^(.*?)\s+([A-Z]+) (\S+) (\d{3}|-) (\d+)ms$/;
const MOCK_CONSOLE = /^\s*\[(.+?)\] (.*)$/;
const CLI_ERROR = /^Error: (.*)$/;

export function emptySimulation (): Simulation {
    return { mocks: [], requests: [], logs: [] };
}

export function stripAnsi (text: string): string {
    return text.replace(ANSI, '');
}

/** Splits a new output chunk into complete lines; the trailing partial line is carried into the next call. */
export function takeLines (pending: string, chunk: string): { lines: string[]; pending: string } {
    const lines = (pending + chunk).replace(/\r\n?/g, '\n').split('\n');

    return { lines, pending: lines.pop() ?? '' };
}

function pathOf (url: string): string {
    try {
        const parsed = new URL(url);

        return parsed.pathname + parsed.search;
    }
    catch {
        return url;
    }
}

function faultLabel (type: string, value: number | undefined, detail: string | undefined): string {
    switch (type) {
        case 'latency': return `latency ${value}ms`;
        case 'error': return `error ${value}`;
        case 'rate_limit': return `rate limit ${value}/min`;
        case 'chaos': return `chaos ${value}%`;
        default: return detail ? `${type} ${detail}` : type;
    }
}

function parseFault (type: string, detail: string | undefined): Fault {
    const value = detail === undefined ? NaN : Number.parseFloat(detail),
        known = Number.isFinite(value) ? value : undefined;

    return { type, label: faultLabel(type, known, detail), value: known };
}

function parseEvent (time: string, type: string, rest: string): Event | undefined {
    let match: RegExpExecArray | null;

    if (type === 'mock started') {
        match = MOCK_STARTED.exec(rest);

        return match ? { kind: 'mock-started', mock: match[1], port: Number(match[2]) } : undefined;
    }

    if (type === 'mock stopped') {
        match = MOCK_STOPPED.exec(rest);

        return match ? { kind: 'mock-stopped', mock: match[1] } : undefined;
    }

    if (type === 'scenario applied') {
        match = FAULT_CONFIGURED.exec(rest);

        return match ? { kind: 'fault', mock: match[1].trim(), fault: parseFault(match[2], match[3]) } : undefined;
    }

    match = REQUEST_COMPLETED.exec(rest);

    if (!match) {
        return undefined;
    }

    return {
        kind: 'request',
        request: {
            time,
            mock: match[1].trim(),
            method: match[2],
            path: pathOf(match[3]),
            status: match[4] === '-' ? undefined : Number(match[4]),
            durationMs: Number(match[5])
        }
    };
}

export function parseLine (raw: string): Event | undefined {
    const line = stripAnsi(raw).trimEnd(),
        header = SIMULATION_HEADER.exec(line),
        error = CLI_ERROR.exec(line.trim()),
        event = EVENT_LINE.exec(line),
        log = MOCK_CONSOLE.exec(line);

    if (header) {
        return { kind: 'simulation', name: header[1] };
    }

    if (error) {
        return { kind: 'error', message: error[1] };
    }

    if (event) {
        return parseEvent(event[1], event[2], event[3]);
    }

    return log ? { kind: 'log', text: `${log[1]}: ${log[2]}` } : undefined;
}

function mockNamed (simulation: Simulation, name: string): Mock {
    let mock = simulation.mocks.find((candidate) => candidate.name === name);

    if (!mock) {
        mock = { name, faults: [], stopped: false };
        simulation.mocks.push(mock);
    }

    return mock;
}

function keepLast<T> (values: T[], limit: number): void {
    if (values.length > limit) {
        values.splice(0, values.length - limit);
    }
}

export function apply (simulation: Simulation, event: Event): void {
    let mock: Mock;

    switch (event.kind) {
        case 'simulation':
            simulation.name = event.name;
            break;
        case 'mock-started':
            mock = mockNamed(simulation, event.mock);
            mock.port = event.port;
            mock.stopped = false;
            break;
        case 'mock-stopped':
            mockNamed(simulation, event.mock).stopped = true;
            break;
        case 'fault':
            mock = mockNamed(simulation, event.mock);

            if (!mock.faults.some((fault) => fault.label === event.fault.label)) {
                mock.faults.push(event.fault);
            }

            break;
        case 'request':
            simulation.requests.push(event.request);
            keepLast(simulation.requests, MAX_REQUESTS);
            break;
        case 'log':
            simulation.logs.push(event.text);
            keepLast(simulation.logs, MAX_LOGS);
            break;
        case 'error':
            simulation.error = event.message;
            break;
    }
}

/** A dropped connection logs no status, so it counts as a failure too. */
export function isFailure (request: Request): boolean {
    return request.status === undefined || request.status >= 400;
}

/** `postman simulate run` logs a mock's configured faults, not which one fired on a request, so this infers it from the status. */
export function likelyCause (request: Request, mock: Mock | undefined): string | undefined {
    const faults = mock?.faults ?? [],
        find = (type: FaultType) => faults.find((fault) => fault.type === type),
        error = find('error'),
        latency = find('latency'),
        status = request.status;

    if (status === 429 && find('rate_limit')) {
        return 'rate limited';
    }

    if (error && status === error.value) {
        return 'injected error';
    }

    if (status !== undefined && status >= 500 && find('chaos')) {
        return 'chaos';
    }

    return latency ? `+${latency.value}ms latency` : undefined;
}
