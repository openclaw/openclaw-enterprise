---
tags: [human_verified]
# Backfilled from the verification tag recorded in 17ff921c5.
last_verified: "2026-11-04"
---

# Slack and ChatGPT service-account tests

## Overview

Run live Slack integration checks with the [Kubernetes runtime](kubernetes.md#kubernetes-model-turns-and-secrets) and a [private environment file](README.md#requirements-and-credentials).

## Slack

The [QA matrix](ci/qa-advisory.md) checks live ingress and a threaded reply. The focused test below checks root replies, credential placement, proxy isolation, and Socket Mode. Prepare an authorized model credential.

Use an authorized test channel in one Slack workspace. The gateway bot and the authorized sender must join it. Use a distinct authorized sender bot. Use an existing Socket Mode app and compatible controller, Gateway, and Codex app-server images. CI builds the controller and the runtime with the pinned OpenClaw source, Codex, and Slack plugin when image overrides are absent. To select existing runtime images, supply both `OCC_TEST_KUBERNETES_GATEWAY_IMAGE` and `OCC_TEST_KUBERNETES_AGENT_IMAGE` as digest references; omit both to use the CI build. Direct test execution requires the imported immutable image references from [runtime preparation](kubernetes.md#kubernetes-model-turns-and-secrets). Run the [image smoke](docker.md#images-and-helm) first; version output alone does not prove compatibility.

Install Helm and yq. Enable EnvoyPatchPolicy on the selected Envoy Gateway.
The fixture renders the production chart's separate egress fleet, listener,
network and RBAC resources. It verifies the assigned Gateway listener and
Harness denial, OCC credential and directory requests, and failure with the
actual Envoy Pods stopped. This proves rendered resources and real API/worker Pods, not
an entire Helm release installation or upgrade lifecycle.

`channel-egress-helm-real.test.ts` supplies that separate installation proof. It
installs the actual OCC chart and a disposable PostgreSQL Helm fixture, binds the
chart's tenant roles, uses a permitted HTTPS operator peer, and exercises dedicated
model turns across revision cutover plus Slack delivery. PostgreSQL uses the
repository's pinned fixture image unless `OCC_TEST_PRODUCTION_POSTGRES_IMAGE`
selects another qualified immutable reference.

Before provisioning the Slack-enabled topology or posting, the focused test checks each bot’s existing `conversations.info` response. Each response must identify the exact configured public or private channel and explicitly report boolean `false` for both `is_im` and `is_mpim`. This rule also applies to legacy private channels. The test rejects malformed or contradictory type flags. The separate membership check reports which bot needs a channel invitation.

Put these settings in the private environment file:

| Variable                          | Value                                                                            |
| --------------------------------- | -------------------------------------------------------------------------------- |
| `OCC_TEST_SLACK_CHANNEL_ID`       | Shared test channel.                                                             |
| `SLACK_APP_TOKEN`                 | Gateway Socket Mode token, starting with `xapp-`.                                |
| `SLACK_BOT_TOKEN`                 | Gateway bot token, starting with `xoxb-`.                                        |
| `OCC_TEST_SLACK_SENDER_BOT_TOKEN` | Distinct sender bot token, starting with `xoxb-`; it stays with the test runner. |

```sh
OCC_TEST_SLACK_LIVE=1 \
  node --env-file="$TEST_ENV_FILE" --test tests/integration/harness-topology-k3d-slack-real.test.mjs
```

`OCC_TEST_SLACK_EVIDENCE_PATH` optionally retains the nonsecret delivery receipt
outside the checkout. The test verifies the sender against Slack history and
correlates the reply with one completed native Codex turn.

The same lane runs `channel-egress-kubernetes-real.test.ts` through normal Agent
APIs and real workers. It covers distinct Driver generations, concurrent
allocation, rejected allocation writes, capacity refusal, retry, channel disable,
port reuse and deletion. A unique DNS name in the disposable cluster points first
to a public Slack address, then to private and mixed answers. The test restores
its DNS configuration during teardown. Private addresses are negative cases only.
Its controlled endpoint checks are transport proof, not a second provider integration.

The test posts a real message and leaves it in the channel. It checks the reply and delayed duplicates. Run live Slack suites serially so Socket Mode consumers do not compete. The fixture enables bot mentions only for the test channel and keeps `requireMention` enabled. Do not enable bot access account-wide. Run the ordinary runtime file separately for its coverage; this Slack test does not verify Teams.

## Service-account coverage

The [ServiceAccount Driver conformance suite](../../tests/conformance/service-account-driver.test.ts)
covers the provider contract with synthetic data. The
[ServiceAccount HTTP suite](../../tests/integration/occ-service-account-lifecycle.test.ts)
covers native accounts, credential privacy, and Namespace access.
The [PostgreSQL compensation suite](../../tests/integration/postgres-service-account-compensation.test.ts)
checks forced deletion and audit details with PostgreSQL and loopback HTTPS
fixtures. It requires `openssl`. Use the [PostgreSQL setup](postgresql.md).
Live provider revocation and model turns require separate verification.

[`postgres-service-account-issuance-recovery.test.ts`](../../tests/integration/postgres-service-account-issuance-recovery.test.ts)
runs the ChatGPT ServiceAccount Driver through OCC over PostgreSQL after an
issuance that never committed. The next issuance and account deletion reclaim
the leftover Secret and credential. Ending a session during reclamation must
preserve a later issuance. The provider and Secret store are in-memory; conformance
tests cover their behavior. Use the [PostgreSQL setup](postgresql.md).

## One-off channel upgrade proof

Use the explicit `channel-egress-upgrade` QA scenario with Kubernetes and Codex. Supply the Slack lane inputs plus `OCC_TEST_CHANNEL_EGRESS_SOURCE_CONTROLLER_IMAGE` and `OCC_TEST_CHANNEL_EGRESS_SOURCE_CHART` for the matching pre-PR-6529 source. Supply
`OCC_TEST_CHANNEL_EGRESS_NEXT_CONTROLLER_IMAGE` for the subsequent ordinary image
upgrade; that image must be built from the target source commit with a different
image digest. This operator-selected scenario runs the actual script and regular Agent workflow; it is outside the default advisory matrix.

Run the one-off scenario once with `OCC_TEST_CHANNEL_EGRESS_DATABASE_MODE=hook`
and once with `separate`. The separate case executes the chart-selected migrator
and its require-current check during each handoff.
