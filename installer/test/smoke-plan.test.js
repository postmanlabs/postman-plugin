import assert from 'node:assert/strict';
import test from 'node:test';
import { planSmoke } from '../../scripts/smoke-plan.mjs';

const push = { ref: 'refs/heads/main', after: 'release-parent', head_commit: { message: 'fix: installer' } },
    candidate = { id: 42, head_sha: push.after, event: 'push', status: 'in_progress', conclusion: null };

test('only an active or successful candidate for this exact push suppresses duplicate smoke', () => {
    for (const status of ['queued', 'requested', 'waiting', 'pending', 'in_progress', 'completed']) {
        const plan = planSmoke('push', push, (sha) => {
            assert.equal(sha, push.after);
            return [{ ...candidate, status, conclusion: status === 'completed' ? 'success' : null }];
        });

        assert.equal(plan.run, false);
        assert.match(plan.reason, /run 42/);
    }
});

test('non-RC pushes, failed candidates and uncertain API results retain full smoke coverage', () => {
    for (const candidates of [
        [],
        [{ ...candidate, head_sha: 'older-commit' }],
        [{ ...candidate, event: 'workflow_dispatch' }],
        ...['failure', 'cancelled', 'skipped', 'timed_out', 'action_required'].map((conclusion) => [{ ...candidate, status: 'completed', conclusion }]),
        undefined
    ]) {
        assert.equal(planSmoke('push', push, () => candidates).run, true);
    }
    assert.equal(planSmoke('push', push, () => { throw new Error('API unavailable'); }).run, true);
});

test('PR, nightly and exact-release dispatches always run without consulting the candidate workflow', () => {
    for (const event of ['pull_request', 'schedule', 'workflow_dispatch']) {
        assert.equal(planSmoke(event, push, () => assert.fail('must not look up a candidate')).run, true);
    }
    // rc.yml intentionally skips release commits, even if GitHub lists that run as successful.
    assert.equal(planSmoke('push', { ...push, head_commit: { message: 'release: 1.0.0' } }, () => assert.fail('release skipped')).run, true);
});
