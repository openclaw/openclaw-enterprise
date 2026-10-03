# Slack tests

Use the [shipped QA matrix](qa-matrix.md) for single-message live Slack ingress and a
gateway-authored threaded reply through dedicated Codex. The focused suite below
retains credential-placement, proxy-isolation, and Socket Mode checks.
Prepare the [Kubernetes runtime setup](kubernetes.md#kubernetes-model-turns-and-secrets)
and [private credential file](README.md#requirements-and-credentials) first.

## Slack

Use the linked Kubernetes runtime prerequisites and model credential, plus an
authorized test channel. The gateway image must already contain the Slack plugin
and its runtime dependencies. Run the [runtime image smoke](images.md#images-and-helm)
before provisioning the cluster, and use a Codex app-server version accepted by
the gateway's installed Codex plugin. Successful `--version` commands alone do
not prove that the two runtimes are compatible.

Put the three Slack tokens in the private environment
file. Set `OCC_TEST_SLACK_CHANNEL_ID` and `OCC_TEST_SLACK_PROXY_URL`; the proxy URL
must have a literal IP and explicit port. Both bots must belong to the same
workspace and have joined the channel. Use an existing Socket Mode app configured
to receive the test messages.

```sh
OCC_TEST_SLACK_LIVE=1 \
  node --env-file="$TEST_ENV_FILE" --test tests/integration/harness-topology-k3d-slack-real.test.mjs
```

This focused test verifies credential placement and the authenticated connection.
The QA matrix posts real messages and verifies exact runtime/session evidence. The sender bot must differ from the
Agent bot; its credential remains with the test runner. Run this file and the
ordinary runtime file for both coverage groups. See [Slack test settings](#slack-test-environment).

### Two-bot fixture configuration

Slack is the only channel with live integration coverage; this suite does not
verify Teams. The test temporarily adds `allowBots: "mentions"`,
`users: ["<sender-bot-user-id>"]`, and a reply policy only on the exact test
channel. `requireMention` stays enabled. Do not enable bot access account-wide.

## Slack test environment

`OCC_TEST_SLACK_LIVE=1` enables
[`harness-topology-k3d-slack-real.test.mjs`](../../tests/integration/harness-topology-k3d-slack-real.test.mjs).
Run the ordinary runtime file separately for its coverage. The Slack case uses the same production k3d,
PostgreSQL, image, and model prerequisites. Delivery and duplicate observation
belong to the QA matrix, which leaves its messages in the authorized channel.

| Variable                          | Requirement                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------ |
| `OCC_TEST_SLACK_LIVE`             | Set to `1` to run the selected live Slack case instead of the ordinary real-runtime cases. |
| `OCC_TEST_SLACK_PROXY_URL`        | Approved exact literal-IP proxy URL with an explicit port for channel egress.              |
| `OCC_TEST_SLACK_CHANNEL_ID`       | Shared test channel joined by the gateway bot and the sender bot.                          |
| `SLACK_APP_TOKEN`                 | Gateway Socket Mode token; must start with `xapp-`.                                        |
| `SLACK_BOT_TOKEN`                 | Gateway bot token; must start with `xoxb-`.                                                |
| `OCC_TEST_SLACK_SENDER_BOT_TOKEN` | Distinct sender bot token in the same Slack workspace; must start with `xoxb-`.            |

See the [Slack testing guide](#slack) for setup and cleanup
expectations before selecting the live case.

## Related

- [Choose another test suite](README.md).
- [Results, cleanup, and troubleshooting](README.md#results-cleanup-and-troubleshooting).
