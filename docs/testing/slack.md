# Slack and ChatGPT service-account tests

## Overview

Run live Slack and ChatGPT service-account integration checks. Both need the [Kubernetes runtime](kubernetes.md#kubernetes-model-turns-and-secrets) and a [private environment file](README.md#requirements-and-credentials).

## Slack

The [QA matrix](ci.md#qa-matrix) checks live ingress and a threaded reply. The focused test below checks root replies, credential placement, proxy isolation, and Socket Mode. Prepare an authorized model credential.

Use an authorized test channel in one Slack workspace. Both the gateway bot and a distinct sender bot must join it. Use an existing Socket Mode app, an immutable `OCC_TEST_PRODUCTION_CONTROLLER_IMAGE`, a gateway image containing the Slack plugin and its dependencies, and a compatible Codex app-server. Run the [image smoke](docker.md#images-and-helm) first; version output alone does not prove compatibility.

Put these settings in the private environment file:

| Variable                          | Value                                                                            |
| --------------------------------- | -------------------------------------------------------------------------------- |
| `OCC_TEST_SLACK_PROXY_URL`        | Approved literal IP URL with explicit port; the API and gateway use this proxy.  |
| `OCC_TEST_SLACK_CHANNEL_ID`       | Shared test channel.                                                             |
| `SLACK_APP_TOKEN`                 | Gateway Socket Mode token, starting with `xapp-`.                                |
| `SLACK_BOT_TOKEN`                 | Gateway bot token, starting with `xoxb-`.                                        |
| `OCC_TEST_SLACK_SENDER_BOT_TOKEN` | Distinct sender bot token, starting with `xoxb-`; it stays with the test runner. |

```sh
OCC_TEST_SLACK_LIVE=1 \
  node --env-file="$TEST_ENV_FILE" --test tests/integration/harness-topology-k3d-slack-real.test.mjs
```

The test posts a real message and leaves it in the channel. It checks the reply and delayed duplicates. Run live Slack suites serially so Socket Mode consumers do not compete. The fixture enables bot mentions only for the test channel and keeps `requireMention` enabled. Do not enable bot access account-wide. Run the ordinary runtime file separately for its coverage; this Slack test does not verify Teams.

## ChatGPT service accounts

This test creates a real ChatGPT service account and credential, then runs a dedicated Codex model turn. Prepare a migrated disposable database and immutable images.

Use an authorized workspace and an admin-key file with mode `0600`. The environment file must not contain `OCC_TEST_CHATGPT_ADMIN_KEY`: that value takes precedence over the key file. Select a model supported by the issued account with `OCC_TEST_OPENAI_MODEL`; API-key model availability does not prove support. The default is `gpt-6-astra`. This test uses the issued credential and does not require `OPENAI_API_KEY`.

```sh
(
  unset OCC_TEST_CHATGPT_ADMIN_KEY
  export OCC_TEST_CHATGPT_ADMIN_KEY_PATH=/absolute/path/to/private/chatgpt-admin-key
  export OCC_TEST_CHATGPT_WORKSPACE_ID='<authorized-workspace-id>'
  OCC_TEST_CHATGPT_SERVICE_ACCOUNT_REAL=1 \
    node --env-file="$TEST_ENV_FILE" --test tests/integration/service-account-driver-real.test.mjs
)
```

The test attempts to delete the provider account and its scoped resources. Investigate any cleanup failure before rerunning. Selecting the test makes missing prerequisites fail; without the flag it skips. The protected CI lane builds and imports its runtime image if either gateway or Agent image is unset; direct local runs must import immutable images first.

## Local and provider coverage

`tests/conformance/service-account-driver.test.mjs` and `tests/integration/occ-api.test.mjs` cover lifecycle and API behavior with synthetic providers. The loopback HTTPS Backend regression requires `openssl`. [PostgreSQL tests](postgresql.md) cover persistence and deletion constraints. These do not prove live provider credential revocation or a model turn.

[`postgres-service-account-issuance-recovery.test.mjs`](../../tests/integration/postgres-service-account-issuance-recovery.test.mjs)
runs the ChatGPT ServiceAccount Driver through OCC over PostgreSQL after an
issuance that never committed. The next issuance and account deletion reclaim
the leftover Secret and credential. Ending a session during reclamation must
preserve a later issuance. The provider and Secret store are in-memory; conformance
tests cover their behavior. Use the [PostgreSQL setup](postgresql.md).
