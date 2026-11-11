---
status: Proposed
implementation_status: Partially implemented
author: uggy-ug
---

# Proposal: Native Telegram polling for dedicated Agents

- **ID:** RFC-0034
- **Created:** 2026-11-10
- **Last updated:** 2026-11-11
- **RFC PR:** [#5289](https://github.com/openclaw/openclaw-enterprise/pull/5289)
- **Implementation plan:** [Telegram primary-channel qualification](../plans/0034-native-telegram-polling.md)

## Summary

Allow an operator to enable the bundled OpenClaw Telegram channel on a
dedicated Agent managed by Kubernetes Compute. The Agent's Gateway polls
Telegram and handles messages, commands, and replies. The Gateway receives
the bot token through an existing Secret binding and reaches Telegram
through a proxy that accepts connections only to `api.telegram.org:443`.
Qualify Telegram as a primary channel through native commands, document and
image exchange, voice-message transcription, progressive replies, and recovery
after a Gateway or dedicated Harness failure.

## Motivation

Kubernetes Compute accepts Slack and Teams as external channels today. An
operator can relay Telegram text through a separate bot process, but then
that process owns Telegram behavior. Each feature, such as command menus,
reply context, or attachments, needs its own relay logic. The
[bundled OpenClaw channel](https://docs.openclaw.ai/channels/telegram) already
handles these interactions. The missing Enterprise contract is how to admit
that channel, deliver its credentials, and restrict its network access.

## Scope

Support one bot per Agent and Telegram long polling in private chats. An
operator chooses the allowed Telegram user IDs. The same Agent keeps its
dedicated Harness and model authentication. This proposal does not qualify
group chats, webhooks, multiple bot accounts per Agent, or embedded execution.
These boundaries do not qualify all features of another OpenClaw version.
Record the bundled source pin and verify each required capability against that pin.

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

### Commands, media, and progressive delivery

Use the bundled Telegram plugin for native commands, reply routing, attachments,
and streaming. Command registration alone does not establish command execution.
Verify the result in the Telegram client and correlate it with the Gateway's
native session and the dedicated Harness turn where model execution is required.

Inbound documents and images must reach the consuming Harness through the existing
workspace/file-transfer path. Check the contents with an independently chosen
marker. Outbound attachments must be retrievable in Telegram with matching
contents. Report unsupported formats and limits to the user.

Voice messages require an explicit transcription backend using OpenClaw's native
media configuration. Keep model credentials in their authorized consumer.
Do not copy ChatGPT OAuth material into the Gateway to provide transcription.
Prefer an available local transcription backend when it preserves the existing
runtime and network boundaries. A remote backend requires its own scoped
credential and approved destination. Verify both transcription and the Agent's
response using a known spoken phrase.

A progressive reply must visibly change before the terminal response. Verify
the final content and the absence of an additional duplicate final message.
An ordinary reply delivered at completion does not qualify streaming.

### Failure and recovery

Kubernetes Compute owns Gateway and Harness health observation and delegates
provider-owned recovery to the selected Sandbox Driver. Reuse the Agent revision
lifecycle and existing exact ownership checks. A Git reconciler may request
reconciliation through supported APIs. It must not rewrite provider-owned runtime
objects or deploy replacements for an intentionally stopped Agent.

Keep Telegram ingestion independent of optional remote skill discovery.
While the Harness is unavailable, preserve admitted inbound work in the native
durable queue and expose the unavailable execution state. Once execution
recovers, resume pending work without starting a second poller. Preserve the
Agent's workspace, sessions, channel token binding, and Harness authentication.

Recover an unavailable provider supervisor through the provider's supported
lifecycle. Use bounded retries and one recovery attempt at a time for the exact
Agent revision. An authentication refusal requires actionable operator status
instead of repeated replacement deployments. If recovery cannot succeed, retain
the failure and pending work for inspection. Measure detection and recovery time
in the installed environment.

Keep the Gateway's Linux process namespace stable across container restarts
inside one Pod. This lets native state ownership checks prove that a crashed
process has exited. It does not permit a second Gateway or automatic removal of
an unverifiable foreign lock after Pod replacement. Test process crashes and
whole-Pod replacement separately; record the latter's fencing requirement.

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
  receiving Telegram messages without concurrent pollers. Rehearse cutover
  and rollback with a test bot, or an operator-authorized existing bot.
- **AC-4 — Commands:** From the allowed Telegram account, execute a native
  help command, inspect model/session status, and start a new session.
  Verify observable command results and isolation between the earlier and
  new session. Verify refusal for an unauthorized account.
- **AC-5 — Attachments:** Send a text document and a known image from the
  Telegram client. Verify that the real Agent reads their contents. Ask
  the Agent to return a file and verify the downloaded contents. Exercise
  one refused or unsupported attachment and its visible result.
- **AC-6 — Voice:** Send a Telegram voice message with an independently
  chosen spoken phrase. Verify the transcript and a correct model response.
  Exercise unavailable transcription and verify an actionable response.
  Record whether outgoing voice is configured and qualified separately.
- **AC-7 — Streaming:** Send a prompt that produces a sufficiently long
  response. Observe at least two successive content states in Telegram
  before completion. Check terminal content, formatting, and duplicate delivery.
- **AC-8 — Recovery:** During native polling, interrupt the Gateway and,
  separately, the dedicated provider supervisor. Send a uniquely marked
  message during the outage. Verify automatic recovery, delivery of the
  pending message, preserved context, and one terminal reply. Record recovery
  times. Check that an intentionally stopped Agent stays stopped.

## Delivery and verification

The operator's local installation has demonstrated native private chat, a real
Codex response, Secret projection isolation, proxy admission and denial, and Git
reconciliation. The change remains outside the shipped upstream release.
The first observed provider-supervisor failure required a manual deployment.
On 2026-11-11, `/help`, `/status`, and model reasoning selection worked through
the native channel. The operator confirmed document read/return, image
interpretation, incoming voice transcription with a model reply, and progressive
text delivery in Telegram. Local Russian transcription also passed in a
network-disabled container. Codex ordinary replies require native automatic
delivery rather than completed text sent through the message tool.

Later fault injection observed retained supervisor recovery in about 64 seconds
and Gateway process recovery in about 36 seconds. The revision stayed unchanged
and a workspace marker survived. An intentionally stopped Agent stayed stopped
for 67 seconds. After the supported start operation, a real model turn generated
a control reply and native Telegram reported one successful delivery.

These observations do not establish complete command or attachment coverage.
Unsupported inputs, missing transcription, outgoing voice, a marked inbound
message queued during an outage, rollback, and complete denial qualification
remain incomplete. The new disposable-cluster recovery scenario is registered;
its complete credentialed run remains outstanding.

The [implementation plan](../plans/0034-native-telegram-polling.md) owns delivery
steps and acceptance results. Use an operator-authorized bot for live checks.
Keep credentials, private chats, local paths, and user IDs outside public evidence.
Register real-runtime scenarios in the existing QA matrix and retain failure
evidence. Complete the criteria before declaring the primary channel qualified.

## Rationale and alternatives

Keeping the relay avoids a Driver change but retains a second implementation
of Telegram message behavior. Adding Telegram to the existing Slack proxy
would widen the destinations of existing Gateways. A separate, opt-in
profile keeps those destinations unchanged. If an Installation needs Slack
and Telegram together, qualify per-channel routing and proxy access before
adding that combination.
