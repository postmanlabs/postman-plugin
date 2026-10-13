---
name: webhook-testing
description: Gives anything that sends webhooks — Stripe, GitHub, Slack, a payment processor, or your own API — a stable public URL that records every request and forwards it to a handler running locally, so you can see exactly what was sent, replay a delivery after a fix instead of re-triggering the sender, and assert on every delivery. Use when the user asks to "test my webhook handler," "get Stripe/GitHub webhooks to localhost," "forward this webhook to my local server," "see what the webhook actually sent," "replay that event," "verify the webhook signature," or "check the webhooks our API sends.", to see what a webhook actually sent, to replay an event, to verify a webhook signature, or to check the webhooks their own API sends, whether or not they mention Postman.
---

# Webhook Testing

`postman webhook` gives a sender a hosted URL,
`https://<webhookId>.webhook.pstmn.io`, that records every request it gets,
with the raw headers and body as they were sent, and forwards each one to a
port on this machine. You don't need a separate tunnel. Two properties shape
how to use it:

- **The URL is stable.** It survives new sessions, pause and start, so the
  sender is registered once. Reuse a webhook when the user names one or says
  the sender already posts to one, and ask if it isn't clear which. Otherwise
  create a new one. Each new webhook is another URL to register and a second
  event history.
- **Every request is recorded,** including requests that arrive while nothing
  is forwarding. `requests describe` shows a delivery exactly as it was sent.
  After a fix, `requests replay` sends it again, so you don't need the sender
  to fire it again.

The command is singular, and every subcommand needs a signed-in session. Run what you need,
and read `bootstrap` only if a command fails with a setup error such as `Authentication required`.
When all you have is the URL, its subdomain is the webhook id.

## The cheap path

To give the user a URL a sender can post to, four steps prove it works. Do
them in this order, because the request in step 4 passes through each of the others:

1. **Make sure the route exists.** A URL that forwards to a service with no
   matching route only ever returns 404. Check the service for a handler for
   this event, and add one if it's missing, even a minimal one. Senders retry,
   and a replay re-sends an identical request, so key the handler on the
   event's id. Answer event types it doesn't handle with a 2xx, so the sender
   stops retrying them.
2. **Create the webhook** with `postman webhook create --title <name>`. Don't run `list` first.
   It's only for finding a webhook the user mentioned.
3. **Start the service, then forward to its port** with
   `postman webhook forward <webhookId> <port>`. `forward` runs until it's
   stopped, so run it in the background. Stop it with
   `pkill -INT -f "webhook forward <webhookId>"`; `kill $!` may reach only the
   `postman` launcher and leave forwarding running.
4. **Send one request to the URL, at the route's path.** Check that a 2xx came
   back and that the handler logged the request. `requests list` shows whether
   the request reached the webhook at all, which separates a wrong URL from a
   forwarding or routing problem.

Stop there unless the user asked for more. One request through the whole path
proves the URL works. A second scenario, replays and scripts are for when the
handler's behaviour is the work.

## Judgement calls

- **Build the test event from the sender's contract, not from your handler.**
  A payload written to match the handler you just wrote only proves the two
  agree with each other. Take it from the sender's documented event schema.
  Better, use a real delivery: send one from the sender's test mode (such as
  `stripe trigger <event>` or a GitHub redelivery), then replay that recorded
  request as you iterate.
- **A permission error is not a sign-in problem.** `You do not have permission
to perform this action` means this account can't use the workspace the repo
  is linked to in `.postman/resources.yaml`, which is common in a cloned repo.
  Signing in again, switching accounts or creating a workspace won't fix it,
  and leaves resources behind on the user's account. Ask which workspace to
  use and pass `-w`.
- **Some old signed events fail verification on replay, by design.** Stripe
  (`t=` in `Stripe-Signature`) and Slack (`X-Slack-Request-Timestamp`) sign a
  timestamp, and their SDKs reject one older than about five minutes.
  Send a fresh event instead of loosening verification. GitHub's signature has no
  timestamp, so its replays still verify.
- **The event log is shared with the workspace, and anyone with the URL can**
  post to it.\*\* Use the sender's test mode. Summarize a delivery instead of
  pasting `describe` output into a PR, issue, commit or `postman feedback`.
- **Confirm before `delete`.** It's permanent, and a sender still registered
  to the URL starts failing. Every other command here can be undone.

## Handing over

Leave the webhook active, because the user is about to point a sender at it.
Forwarding stops when the `forward` process does, and anything that arrives in
the meantime is recorded and can be replayed. Give the user:

- the URL with the route's path;
- the two commands that start the loop again: start the service, then
  `postman webhook forward <webhookId> <port>`;
- what you added to the service;
- what the end-to-end request returned.

To assert on every delivery with a `pm.test` script, see
[reference/webhook_scripts.md](reference/webhook_scripts.md). To test the
webhooks your own API sends, with a Postman webhook as the subscriber, see
[reference/outbound_webhooks.md](reference/outbound_webhooks.md).
