# Feature Spec: Development end-to-end guide

**Date:** 2026-08-31
**Status:** Completed
**Owner:** OCC development documentation and Docker runtime integration
**Source baseline:** `4acfa258a5d9c1757199c83fd558ed19c8392543`

## Problem and Decision

The [quickstart](../../docs/guides/quickstart.md) ends at an authenticated Installation
read. Developers need a reproducible terminal journey that creates a Namespace,
deploys an Agent and its gateway, and keeps an interactive OpenClaw TUI open for
real model conversations. The [existing Docker integration](../../tests/integration/docker-compute-real.test.mjs)
exercises these platform operations and HTTP messaging, but does not verify TUI.

Add a development end-to-end section to [Deploy](../../docs/guides/deploy.md), linked
from the quickstart. Provision through Compose and the OCC API, then launch the
pinned native TUI inside the Agent's gateway container. Keep curl as an optional
diagnostic. No new public API or setup CLI is needed.

## Scope

- Document setup prerequisites, authenticated provisioning, asynchronous readiness,
  exact gateway discovery, interactive TUI conversations, and explicit client exit.
- Retain existing Namespace/IAM, immutable revision, credential, and loopback boundaries.
- Defer dedicated Codex walkthroughs, Kubernetes, external messaging channels,
  host-installed TUI setup, new deletion APIs, and one-command installers.

## Contract

### Prerequisites and ownership

Run from the repository root with Docker Engine/Compose, an interactive terminal,
`curl` for OCC requests, and Python 3 for JSON handling and test PTY support.
Reuse the runtime-image recipe and sign-in procedure; do not duplicate bootstrap.
Name the tested model and how to select another model authorized for the developer.
Provide `OPENAI_API_KEY` through the Compose-starting environment or protected `.env`
before deployment; recreate the worker if it previously started without the key.
Do not load personal OpenClaw/Codex sessions implicitly.

A [Namespace](../../docs/reference/drivers/docker-compute.md#namespace-lifecycle) provisions
a network. Deployment creates the Agent-owned gateway with its embedded Harness;
there is no separate Gateway resource. OCC owns immutable AgentRevisions, and the
worker reconciles their [runtime lifecycle](../../docs/reference/drivers/docker-compute.md#agentrevision-lifecycle).

### Provisioning journey

Use the quickstart's private session cookie for OCC requests. Resource responses
have `{data,meta}` envelopes. Generate unique demo names and retain each returned ID.

| Step | Existing request and required result |
| --- | --- |
| Create Namespace | `POST /namespaces` with `{name}`; HTTP 201, save `data.id`. |
| Wait for infrastructure | `GET /namespaces/:namespaceId`; require `data.status === "ready"`. |
| Create Configuration | `POST /namespaces/:namespaceId/configurations` with `{kind:"agent",values:<native configuration>}`; HTTP 201, save `data.id`. |
| Create Agent | `POST /namespaces/:namespaceId/agents` with `{name,configurationId,executionMode:"embedded"}`; HTTP 201, save `data.id`. |
| Deploy | Bodyless `POST /namespaces/:namespaceId/agents/:agentId/deploy`; HTTP 202, save revision `data.id`. |
| Wait for activation | `GET /namespaces/:namespaceId/agents/:agentId`; require `data.activeRevisionId` to equal that revision ID. |

Copy the embedded native configuration from [the runtime configuration helper](../../tests/helpers/harness-configuration.mjs)
into a complete, editable guide example. It selects `openai/<model>` with runtime
`openclaw`, enables `gateway.http.endpoints.chatCompletions`, and preserves the
literal `${OPENCLAW_GATEWAY_TOKEN}` reference. Shell expansion must not replace it.
Set native `agents.defaults.skipBootstrap: true` for this disposable demo so
first-run workspace onboarding does not replace the requested model reply.
Model credentials never enter Configuration payloads or revision snapshots.

Bound polling and report the last nonsecret state on timeout. Stop on failed/deleting
Namespaces or HTTP failure; a deployment's HTTP 202 alone does not permit messaging.

### Discover the gateway and attach the TUI

The OCC API exposes no gateway URL or token. The guide uses the developer's existing
Docker-host access to select exactly one running container with labels matching
managed=true, compute-driver=docker, Namespace ID, Agent ID, active revision ID,
and role=gateway, all under `org.openclaw.enterprise.*`. Follow the exact label
selection in [Docker integration discovery](../../tests/integration/docker-compute-real.test.mjs).
Reject missing, multiple, or foreign matches. Never use the first unscoped container.

Launch from a dedicated terminal, using a fresh native session name and test nonce:

```bash
docker exec -it -e OPENCLAW_STATE_DIR=/tmp/occ-tui-client \
  "$GATEWAY_CONTAINER" node /app/openclaw.mjs tui \
  --session "$E2E_SESSION" --message "Reply exactly: $NONCE"
```

The [Docker runtime](../../apps/controller/src/drivers/compute/docker/index.ts) supplies
the config path, gateway port, and gateway token. TUI inherits
them and authenticates over `ws://127.0.0.1:8080` inside the container. Its separate
client state directory avoids the host's personal OpenClaw state. Do not extract
credentials into argv, print full Docker inspection, or weaken device authentication.
Normal authenticated local pairing applies; if pairing is rejected, surface it.

Use `tui`, without `--local`, `chat`, or `terminal`, which select local execution
in the pinned version. Do not pass `--url` or `--token`: inherited configuration
selects the deployed gateway. The native session targets its default OpenClaw
agent, not the OCC Agent UUID. Omit `--deliver` for terminal-only conversation.
Use the [pinned runtime recipe](../../deploy/runtime/README.md); [TUI reference](https://docs.openclaw.ai/cli/tui) documents the client.

`--message` sends the first prompt and leaves TUI open. The developer can omit it
and type the first prompt instead. After the assistant replies, keep the same TUI
process and session open for follow-up messages; do not wrap it in an automatic
exit or session-lifetime timeout. Ctrl+D explicitly exits only TUI, leaving the
gateway and Agent running. Rediscover the active container before attaching again.

Revoke the OCC session and remove its private cookie after discovery, before TUI
launch; the TUI has separate gateway authentication. Clean up temporary OCC/curl
credentials on failures too. Explain that `docker compose down` leaves Driver-created
workloads, and populated Namespaces cannot currently be deleted through the API; link
[safe-stop guidance](../../docs/guides/deploy/local-operations.md#stop-development-safely). Do not add a
destructive reset. Optional curl diagnostics retain exact loopback-port discovery,
private mode-0600 token configuration, and the existing chat-completions request.

## Implementation

1. Add `Development end-to-end` beneath the development section of `docs/guides/deploy.md`.
   Include runnable shell/JSON examples for the contract above.
2. Link the section from `docs/guides/quickstart.md`, `docs/README.md`, and the root
   README. Keep the basic quickstart usable without a model credential and retain
   the repository's two-guide layout.
3. Extend the embedded case in `tests/integration/docker-compute-real.test.mjs` to
   run the exact TUI launch under a pseudoterminal using `tests/helpers/tui-pty.py`, built
   on Python's standard-library PTY support. Reuse its provisioned Agent; retain
   existing HTTP checks, both topologies, ownership checks, and teardown.
   Bound each test response wait to 240 seconds; test cleanup sends Ctrl+D only
   after proving continued interaction, or terminates its own client on failure.

## Verification

| Required outcome | Proof |
| --- | --- |
| Fresh developer completes the guide | Rehearse the exact commands with a real image/key/model; record revision, versions, nonsecret IDs, and TUI-rendered assistant nonce response. |
| Platform lifecycle is real | Observe Namespace ready, matching active revision, and exactly owned gateway with a loopback binding; run the existing opted-in Docker integration with no skips. |
| TUI stays interactive through real model turns | Observe connected state and the assistant's fresh nonce reply, assert the TUI process remains running, type a second distinct nonce prompt in the same session, and observe its reply. Echoed prompts, `/status`, or HTTP replies are not model proof. |
| Authentication and explicit exit work | A TUI client with fresh device state and an invalid token cannot connect; normal auth succeeds without bypasses. After two replies, Ctrl+D exits the client and the gateway remains ready. |
| Missing prerequisites fail honestly | Missing image/key or an unavailable model prevents passing proof; report the failed boundary instead of substituting a mock or health response. |
| Secrets and surrounding work stay intact | Inspect captured output for leaks; verify OCC/curl temporary credentials are removed and unrelated Docker resources/volumes remain unchanged. |

A local probe of OpenClaw 2026.7.1 verified TUI connection, normal local pairing,
`/status`, and Ctrl+D exit with the gateway still running. It had no provider key
or external network; the implementation proof below completes the model boundary.

## Delivery evidence

Implemented in `c208e48a46353050427ae80affc864a4895a6c8e`. Current procedures
live in the [development TUI guide](../../docs/guides/deploy/local-operations.md#development-end-to-end-tui)
and [Docker test settings](../../docs/testing/docker.md#docker-compose-development-test-environment).
The real Docker integration passed with `gpt-5.1` in 55.9 seconds, zero skips,
including invalid-token rejection, two TUI replies, Ctrl+D, gateway readiness,
and embedded/dedicated HTTP model turns. The exact guide also passed with a fresh
`gpt-4.1` Agent. HTTP-error, missing-key, and missing-owned-gateway cleanup passed.
Independent review and local verification passed. Dedicated TUI and production
walkthroughs remain outside this specification.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- [2026-08-31 16:18]: Completed implementation, real two-turn TUI proof, review, and independent verification. (01a059cc-39b5-7ff1-b277-258d90fb4634 - c208e48a46353050427ae80affc864a4895a6c8e)

- [2026-08-31 15:29]: Made the approved native TUI path primary and required continued interactive use until explicit exit. (01a059cc-39b5-7ff1-b277-258d90fb4634 - 4acfa258a5d9c1757199c83fd558ed19c8392543)
- [2026-08-31 15:15]: Drafted the development provisioning and CLI model-turn guide specification. (01a059cc-39b5-7ff1-b277-258d90fb4634 - 4acfa258a5d9c1757199c83fd558ed19c8392543)
