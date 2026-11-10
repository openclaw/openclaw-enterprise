---
status: Proposed
implementation_status: Not implemented
author: uggy-ug
---

# Proposal: Native Telegram polling for dedicated Agents

- **ID:** RFC-0034
- **Created:** 2026-11-10

## Summary

Allow an operator to enable the bundled OpenClaw Telegram channel on a
dedicated Agent managed by Kubernetes Compute. The Agent's Gateway polls
Telegram and handles messages, commands, and replies. The Gateway receives
the bot token through an existing Secret binding and reaches Telegram
through a proxy that accepts connections only to `api.telegram.org:443`.

## Motivation

Kubernetes Compute accepts Slack and Teams as external channels today. An
operator can relay Telegram text through a separate bot process, but then
that process owns Telegram behavior. Each feature, such as command menus,
reply context, or attachments, needs its own relay logic. The
[bundled OpenClaw channel](https://docs.openclaw.ai/channels/telegram) already
handles these interactions. The missing Enterprise contract is how to admit
that channel, deliver its credentials, and restrict its network access.

## Scope

Start with one bot per Agent and Telegram long polling in private chats. An
operator chooses the allowed Telegram user IDs. The same Agent keeps its
dedicated Harness and model authentication. This proposal does not qualify
group chats, webhooks, multiple bot accounts per Agent, or embedded execution.

## Proposal

The Installation operator opts in to a Telegram proxy profile for
[Kubernetes Compute](../../docs/reference/drivers/kubernetes-compute.md).
Reuse the exact proxy endpoint and workload peer checks for
`runtime.channels`. The first delivery uses one channel proxy profile per
Installation: selecting Telegram does not change the destinations allowed by
the existing Slack and Teams profiles, and cannot be combined with them.
Reject a profile change that would invalidate an enabled channel on a deployed
Agent. This keeps the destination set separate without adding proxy selection
to Agent Configuration.

An Agent operator saves `channels.telegram` in the OpenClaw Configuration
with `dmPolicy: allowlist`, a nonempty list of numeric user IDs, and
`groupPolicy: disabled`. The same Configuration can come from a Git
reconciler using the Enterprise API. Save and deployment admission reject
Telegram unless the Installation opts in and the Agent uses a dedicated
Harness. Reject alternate API roots, custom proxy settings, webhook settings,
token files, and named bot accounts in this profile.

Require the Telegram `botToken` to use an environment SecretRef with a
matching [Configuration Secret binding](../../docs/flows/secret-storage-and-delivery.md).
Use the existing same Namespace authorization and revision checks. Reject
inline tokens and implicit environment fallbacks. The Gateway receives the
token; the Harness receives its separate model credentials. Git and Agent
revisions contain only references to the token.

Compute sets the approved HTTPS proxy on the Gateway and restricts Gateway
channel traffic to that proxy using a NetworkPolicy. The Harness gets no
Telegram proxy access. The proxy accepts CONNECT only to the exact hostname
and port, resolves the hostname itself, and connects only to public
addresses. It does not terminate Telegram TLS or log request paths, which
can contain the bot token. If the proxy is unavailable, channel traffic fails
without a direct Internet fallback. Verify that the cluster enforces these
policies before enabling the profile.

OpenClaw owns the Telegram chat sessions, update offsets, and retries. The
deployment must stop the previous Gateway before its replacement begins
polling for the same bot. When migrating from a bridge, the operator stops
the bridge before starting native polling. For rollback, stop the native
poller before restarting the bridge. Telegram retains the existing bot chat;
the bridge's Agent session and the native Telegram session can differ.

## Acceptance Criteria

- **AC-1 — Native chat:** On Kubernetes with an enforcing network policy and
  a real test bot, deploy a dedicated Agent from a Configuration and Secret
  binding. From an allowed Telegram account verify a reply to a message, a
  slash command, a progressive reply, and an attachment. Verify that an
  account outside the allowlist cannot invoke the Agent. Check voice input
  with a supported transcription setup before claiming voice support.
- **AC-2 — Admission and isolation:** Through the Enterprise API, verify
  that missing opt-in, an unbound or inline token, and transport overrides
  are refused. In the deployed Agent, verify that the Harness gets neither the
  token nor the proxy path. From the Gateway verify that direct Telegram
  connections fail and the proxy rejects other hosts and IP addresses.
- **AC-3 — Replacement and rollback:** Change the Configuration through
  the same Git reconciler and verify that the replacement Gateway resumes
  receiving Telegram messages without concurrent pollers. Rehearse bridge
  cutover and rollback with the test bot before moving an existing bot.

## Delivery and verification

Connect the Compute admission and proxy profile to the existing Gateway
configuration and Secret binding flow. Then qualify the dedicated Agent
workflow against Telegram on a disposable installation with an enforcing
network policy. Use a separate bot on Docker Desktop for the operator
workflow. Source inspection supports the proposed integration; the
acceptance criteria have not run.

## Rationale and alternatives

Keeping the relay avoids a Driver change but retains a second implementation
of Telegram message behavior. Adding Telegram to the existing Slack proxy
would widen the destinations of existing Gateways. A separate, opt-in
profile keeps those destinations unchanged. If an Installation needs Slack
and Telegram together, qualify per-channel routing and proxy access before
adding that combination.
