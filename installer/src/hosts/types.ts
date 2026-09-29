import type { System } from '../system.js';

export type HostId = 'claude-code' | 'codex' | 'cursor' | 'factory' | 'kimi' | 'opencode';

/** `installed: null` means the host's own listing could not be read, which is not the same as "absent". */
export type Status = { installed: boolean | null; detail: string; notes: string[] };

export type Outcome = 'done' | 'skipped' | 'manual' | 'blocked' | 'failed';
export type Result = { outcome: Outcome; message: string; next?: string };

export interface Host {
    id: HostId;
    name: string;
    /** The route in this repo the host reads: a `.<vendor>-plugin/` directory or a package manifest. */
    route: string;
    detect (system: System): Promise<boolean>;
    status (system: System): Promise<Status>;
    /** Installs, or updates when already installed, and only then removes any copy that would load the same skills twice. */
    install (system: System): Promise<Result>;
    remove (system: System): Promise<Result>;
}

export function result (outcome: Outcome, message: string, next?: string): Result {
    return next ? { outcome, message, next } : { outcome, message };
}
