// A main push may already be covered by rc.yml's smoke of the versioned commit.
// Consult the actual run instead of duplicating rc.yml's path filters here.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export function planSmoke (eventName, event, listCandidates) {
    if (eventName !== 'push' || event.ref !== 'refs/heads/main' || event.head_commit?.message?.startsWith('release:')) {
        return { run: true, reason: 'PR, scheduled, manual and release-commit smoke coverage is unchanged.' };
    }

    try {
        const candidates = listCandidates(event.after),
            covering = candidates.find((run) => run.head_sha === event.after && run.event === 'push' &&
                (['queued', 'requested', 'waiting', 'pending', 'in_progress'].includes(run.status) ||
                    (run.status === 'completed' && run.conclusion === 'success')));

        if (covering) {
            return { run: false, reason: `Release candidate run ${covering.id} owns smoke coverage and gates publishing on its exact release commit.` };
        }

        return { run: true, reason: 'No active or successful release candidate run for this push; run the full smoke matrix.' };
    }
    catch {
        return { run: true, reason: 'Could not confirm release candidate coverage; run the full smoke matrix.' };
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')),
        plan = planSmoke(process.env.GITHUB_EVENT_NAME, event, (sha) => {
            const endpoint = `repos/${process.env.GITHUB_REPOSITORY}/actions/workflows/rc.yml/runs?event=push&head_sha=${encodeURIComponent(sha)}&per_page=100`;

            return JSON.parse(execFileSync('gh', ['api', endpoint], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] })).workflow_runs;
        });

    console.log(plan.reason);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `run=${plan.run}\n`);
}
