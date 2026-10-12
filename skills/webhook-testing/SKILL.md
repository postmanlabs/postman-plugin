---
name: webhook-testing
description: Tests webhooks end to end with a Postman webhook — a stable public URL that records every request sent to it — by forwarding deliveries to a handler on localhost, inspecting the exact headers and body that arrived, replaying a captured event after a fix or to check idempotency, and asserting on every delivery with an `onEvent` script. Works in both directions — developing a handler for a provider's webhooks (Stripe, GitHub, Slack, …) and checking the webhooks your own API sends. Use when the user asks to "test my webhook handler," "get Stripe/GitHub webhooks to localhost," "forward webhooks to my local server," "see what the webhook actually sent," "replay that event," "verify the webhook signature," or "check the webhooks our API sends."
---

# Webhook Testing

## Overview

A Postman webhook is a hosted listener at `https://<webhookId>.webhook.pstmn.io`.
It records every request sent to it, with the raw headers and the raw body as
they arrived, never reformatted, in an event log the whole workspace shares.
The URL stays the same across sessions and across pause and start, so you
register it with a provider once.

That makes three jobs cheap that are otherwise slow:

- **Seeing what was actually sent.** `requests describe` shows the delivery
  as the sender made it, before your framework parses it.
- **Re-running an event without the sender.** `requests replay` re-sends a
  captured request with its exact headers and body, so you don't have to get
  Stripe or GitHub to fire the same event again after a fix.
- **Asserting on every delivery.** An `onEvent` script runs `pm.test` against
  each incoming request, and `requests describe` shows the results in the same
  report format a collection run uses.

The command is singular: `postman webhook`. Every subcommand needs a signed-in
session. As a guest it fails with `Authentication required. Run postman login
or provide --api-key.` and exit 1, so route to `bootstrap` first.

## Commands

| Command | Does | Takes |
| --- | --- | --- |
| `create -t <title>` | Creates a webhook and prints its URL. It starts capturing immediately | `-w`, falls back to the linked workspace |
| `list` | Lists the workspace's webhooks with ids and status | `-w`, falls back to the linked workspace |
| `status <webhookId>` | Gets title, active or inactive state, invoke URL, creation date | id |
| `start` / `pause <webhookIdOrUrl>` | Starts or stops accepting requests. The URL doesn't change | id or URL |
| `forward <webhookIdOrUrl> <port>` | Relays incoming requests to `localhost:<port>` until stopped | id or URL |
| `requests list <webhookId>` | Recent requests: id, event type, method, path, response status, time. 20 per page; pass the printed cursor to `--cursor` for the next page | id |
| `requests describe <webhookId> <requestId>` | Headers, body, recorded responses and the script test report. `--verbose` adds script logs | ids |
| `requests replay <webhookId> <requestId>` | Re-sends that request through the webhook's routing | ids |
| `scripts set <webhookId> <file> --event onEvent\|onResponse` | Creates or replaces a JavaScript or TypeScript script | id |
| `delete <webhookId>` | Deletes the webhook and its URL, permanently | id |

Without `-w`, `create`, `list`, `requests` and `scripts set` use the workspace
in `.postman/resources.yaml` or `.postman/config.json`, which `bootstrap`
records. When a command takes only an id and you have the URL, the id is the
URL's subdomain. Request ids come from `requests list`.

Run `postman webhook <command> -h` before using a flag this table doesn't show.
Postman's docs page gives `forward` a different argument order from the one
the CLI accepts; the CLI's `-h` is authoritative.

## Process: testing a handler that receives webhooks

1. **Reuse a webhook before creating one.** Run `postman webhook list`. If one
   is already registered with this provider, use it; a new one is a new URL the
   provider doesn't know. Otherwise create one named for its job:

   ```bash
   postman webhook create --title "stripe-dev"
   ```

2. **Point the sender at it.** Register the URL with the provider, as the
   endpoint in Stripe's or GitHub's webhook settings, for example. Use the
   provider's test mode, because the payload lands in a log your whole
   workspace can read (rule 5). The path after the host is recorded, so
   `https://<webhookId>.webhook.pstmn.io/stripe` keeps one provider's
   deliveries apart from another's.

3. **Forward to the handler.** Start the handler, then forward to the localhost port.
   `forward` runs until it's stopped, so run it in the background:

   ```bash
   postman webhook forward <webhookId> 3000 > forward.log 2>&1 &
   ```

   Stop it with `pkill -INT -f "webhook forward <webhookId>"`, using the id or
   URL you passed. That sends the same signal as Ctrl+C. In a terminal of its own, Ctrl+C works too. Keep
   `forward.log` out of commits.

4. **Send an event, then compare both ends.** Fire a real test event from the
   provider, such as `stripe trigger <event>` in test mode or a redelivery from
   GitHub's webhook settings. Without a provider, post a fixture yourself. That
   checks your parsing, but not the provider's real payload or signature:

   ```bash
   postman request POST https://<webhookId>.webhook.pstmn.io/stripe \
     -H "Content-Type:application/json" -d @fixtures/payment_intent.succeeded.json
   ```

   Then find the delivery and read it:

   ```bash
   postman webhook requests list <webhookId>
   postman webhook requests describe <webhookId> <requestId>
   ```

   Compare that with what your handler logged for the same request: method,
   path, headers and body. If they match and the handler still fails, the bug
   is in the handler. If they don't match, the problem is in forwarding or
   routing. If a delivery isn't on the first page, page through with
   `--cursor` before deciding it never arrived.

5. **Fix, then replay the same event.** Create the fix,
   keep `forward` running, and run
   `postman webhook requests replay <webhookId> <requestId>`. Confirm the
   replay in the handler's own log, not only in `requests list`. Run the replay
   twice to test idempotency: the second run must not apply the event again.
   An event that arrived while the webhook was active but nothing was
   forwarding was still recorded, so you can replay it now.

6. **Assert on every delivery.** Once you know what a correct event looks
   like, write that down as an `onEvent` script so every later delivery is
   checked (see [Scripts](#scripts)). This step is optional, but it's what turns
   a run you checked by eye into a check that repeats.

7. **Leave it tidy.** Stop `forward`. Pause the webhook if nothing should
   reach it for now: `pause` is reversible and keeps the URL the provider is
   registered with. Delete it only when the user asks (rule 4).

## Testing the webhooks your API sends

Here the Postman webhook stands in for a subscriber. Register its URL as the
subscriber endpoint in your app, through its config or your subscription API,
and trigger the action that emits the event. Call it with `postman request`
or the collection that already covers it (see `api-testing`). Then read the
delivery with `requests describe` and check it against the event contract you
publish:

- the event type and the body's shape;
- the signature header, recomputed from the raw body with the secret your
  subscriber holds;
- the delivery or idempotency id, and that it's unique per event and stable
  across retries.

Put those checks in an `onEvent` script so each delivery gets a test report.

To test retries, the subscriber has to fail. Either set the webhook's routing to
respond with a 5xx in the Postman app (routing isn't a CLI command), or forward
to a local endpoint that returns one. Check that `requests list` records the
failing response status before you read the repeated deliveries as retries.

## Scripts

```bash
postman webhook scripts set <webhookId> ./webhooks/stripe-on-event.js --event onEvent
```

- **`onEvent`** runs when a request arrives, before Postman forwards or
  responds. Use it to validate the payload, verify the signature, or modify
  the request. **`onResponse`** runs after Postman has responded to the
  sender. Use it for logging and follow-up work.
- **The file in the repo is the only copy you can read.** The CLI has
  `scripts set` but no command that reads a script back, and a second `set`
  replaces the first. Commit the script beside the handler it guards, and set
  it again after you edit it.
- **No state carries over between deliveries.** Each run gets a fresh sandbox.
  `pm.globals`, `pm.collectionVariables`, `pm.iterationData`,
  `pm.execution.setNextRequest` and `pm.visualizer` aren't available. A script
  can't remember which event ids it has already seen, so test duplicate
  handling with replay (step 5), in your handler.
- **Secrets come from the linked environment.** Read a signing secret with
  `pm.environment.get` in your webhook scripts and never write it into the file.
  An environment is linked to a webhook in its settings in the Postman app.
  See `variables` for where a secret belongs.
- **Results are per delivery.** `requests describe` shows the script's test
  report, and `--verbose` adds its console output, capped at 25 KB per event.
- **A script is a test, not your handler's guard.** Postman doesn't document
  that a failing `pm.test` stops the request from being routed. Your handler
  verifies signatures itself, whatever the script reports.

Payload assertions and signature checks for GitHub, Stripe and Slack are in
[reference/webhook_scripts.md](reference/webhook_scripts.md).

## Critical Rules

1. **Sign in first.** Every `postman webhook` command is gated. A missing or
   guest session is `bootstrap`'s job: route there rather than improvising a
   login. Don't pass `--api-key` on the command line, where shell history and
   process lists keep it.
2. **Resolve ids; never infer them.** Webhook ids come from `list` or `status`,
   or from the URL's subdomain. Request ids come from `requests list`. When a
   title matches more than one webhook, show the candidates and ask.
3. **Don't create a webhook per session.** The stable URL is the point. A
   second webhook for the same provider means registering it again and splits
   the event history in two.
4. **Confirm before `delete`.** It can't be undone. The URL stops working, and
   any provider still configured to send to it starts failing. Show
   `status` (title and URL) when you ask. `pause`, `start`, `create` and
   `scripts set` are reversible and need no approval.
5. **The event log is shared with the workspace, and the URL accepts requests
   from anyone who has it.** Captured requests can carry customer data and
   tokens. Use provider test modes, summarize a delivery rather than pasting
   `describe` output into a PR, issue, commit or `postman feedback`, and never
   put a real signing secret in a script.
6. **An old signed event fails verification on replay, by design.** Stripe
   signs a timestamp (`t=` in `Stripe-Signature`) and Slack sends
   `X-Slack-Request-Timestamp`. Their SDKs reject a signature older than about
   five minutes. That rejection means your handler works. Send
   a fresh event from the provider; never loosen verification to make a replay
   pass. GitHub's `X-Hub-Signature-256` has no timestamp, so its replays still
   verify.
7. **A webhook isn't a load-test target.** It accepts 100 requests a minute
   from one IP. Load-test your handler directly with `performance-testing`.

## Not this skill

- **Triggering a deployed Postman Flow** over its webhook is `flows trigger`.
  See `flows`.
- **Starting a collection run when an event happens** uses collection webhooks,
  which the Postman API creates. That's a different feature, not
  `postman webhook`.

## Verification

An exit code from `forward`, `replay` or `scripts set` proves nothing about
the handler. The evidence is the handler's own log next to
`requests describe` for the same request id.

Report:

- **The webhook:** its title, id and URL, and whether you left it active,
  paused or deleted.
- **Each delivery you tested:** request id, method, path and the response
  status recorded, and what the handler did with it, from its own log or state.
- **Replays:** which request ids you replayed, how many times, and whether the
  handler stayed idempotent.
- **Script results:** pass and fail counts from `requests describe`, when a
  script is set.
- **What's still running:** confirm `forward` has stopped, or say that it's
  still running and how to stop it.

## Reference

- [Webhook scripts](reference/webhook_scripts.md): payload assertions and
  GitHub, Stripe and Slack signature checks for an `onEvent` script.
- `bootstrap` skill: CLI install, `postman login` and the workspace id that
  `-w` falls back to.
- `variables` skill: where a signing secret lives so it never lands in a
  script or a committed file.
- `api-testing` skill: `postman request` and collection runs to trigger the
  action that sends a webhook.
