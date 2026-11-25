---
tags: [human_verified]
# Backfilled from the verification tag recorded in 17ff921c5.
last_verified: "2026-11-04"
---

# Manual tests

These lanes have no configured recurring GitHub runs and are excluded from
`ci`, `full`, and Full Integration dispatch. Select a lane explicitly after
completing its linked setup; see [lane execution and cleanup](ci/run-lanes.md#results-and-cleanup).

- [`channel-egress-upgrade`](../../scripts/ci/test-suites/channel-egress-upgrade.json): requires prepared source/target controller images, the pre-PR-6529 chart, a disposable enforcing cluster, and authorized model/Slack credentials. Run both database modes through the [explicit QA scenario](slack.md#one-off-channel-upgrade-proof).
- [`egress-connected`](../../scripts/ci/test-suites/egress-connected.json) ([setup](static-egress.md#select-the-prepared-connected-lane)): select explicitly after preparing the protected controller, database, authenticated OpenShell stack, and synthetic HTTPS origin. CI runs the request preflight in `checks-baseline-2`; the generic `openshell` lane does not run this qualification.
- [`egress-custody-installed`](../../scripts/ci/test-suites/egress-custody-installed.json) ([setup](protected-repository-custody.md)): verify repository request dispatch and protected response handling on a separately prepared controller and OpenShell pair.
- [`repository-credentials-live`](../../scripts/ci/test-suites/repository-credentials-live.json): requires an authorized disposable repository and cleanup. See [repository credentials](repository-credentials.md).
- [`postgres-azure-workload-identity`](../../scripts/ci/test-suites/postgres-azure-workload-identity.json): see [Azure PostgreSQL tests](postgresql.md#azure-workload-identity-connections).
- [`ssh-host`](../../scripts/ci/test-suites/ssh-host.json): requires a disposable Linux/systemd host. Its optional model selector adds provider execution. See [SSH tests](ssh.md).
- [`plugin-model`](../../scripts/ci/test-suites/plugin-model.json): requires a disposable cluster with Envoy Gateway and cert-manager, its Gateway CA certificate and key, an authorized Codex account, an immutable Agent image and three distinct scenario databases. See [plugin tests](plugins.md#native-runtime-prerequisites).
- Run [`openshell-token-service-git-agent`](../../scripts/ci/test-suites/openshell-token-service-git-agent.json) on a disposable Installation with OCC TokenService, native Credential Proxy, OpenShell, a managed Workspace route, and the inspected Dedicated Codex runtime and Gateway images. Prepare a ready Codex OAuth Source, a GitHub App Client, and two approved private repositories. Authorize the test to create and remove a unique branch in the selected disposable repository. The selected repository needs an initial commit, and its registry entry and installation must allow Contents write. Set `DISPOSABLE_WRITE_REPOSITORY` (with the manifest prefix) to its exact `owner/name`.

  The suite deploys a Contributor and a Reader sharing one Git Source. It pushes a commit, checks the remote ref after the Reader attempts a fast-forward push, and checks the Reader’s OpenShell denial. It clears Git access on the Reader and checks a fresh model turn on that revision. The second repository exercises omission from the Agent’s grants.

  For the TCP check, choose a free port on a private IPv4 address of the test runner, reachable from the Sandbox. Configure a DNS name resolving to that address and allow `/usr/bin/curl` to reach that exact name and port in the Installation network ceiling. Supply the three `TCP_CONTROL_*` manifest inputs. The test opens a credential-free listener, confirms an admitted request reaches it, and checks whether a direct workload socket reaches the same listener.

  Supply loopback OCC and OpenShell management URLs, the service key, and management mTLS files as listed in the manifest. The service key needs permission to create, configure, deploy and delete the test Agents and their test resources. Use genuine credentials only with their intended issuers and repositories.

  ```sh
  node scripts/ci/run-tests.ts run openshell-token-service-git-agent --lifecycle complete \
    --attempt "${PRIVATE_FRESH_ATTEMPT:?}"
  ```

- Run [`openshell-token-service-pat-agent`](../../scripts/ci/test-suites/openshell-token-service-pat-agent.json) against an active Dedicated Codex Agent bound to a ready `codex-pat` Source. With its Agent and Namespace IDs, a loopback OCC URL and an authorized service key, the test checks the model reply and a new allowed HTTPS request in that revision’s Supervisor log.
- [`openshell-linear`](../../scripts/ci/test-suites/openshell-linear.json): starts a shipped OpenShell installation and verifies a Linear read through a normal Agent turn. It requires the connected-account file, model and read fixture from [Linear qualification](openshell.md#linear-tool-use-qualification).
- [`k3d-two-cluster`](../../scripts/ci/test-suites/k3d-two-cluster.json): requires two separately prepared clusters, a private configuration file and an OpenAI API key. See [two-cluster validation](kubernetes.md#two-cluster-validation).
- [`openshell-oauth`](../../scripts/ci/test-suites/openshell-oauth.json): requires a prepared OpenShell OAuth gateway, trust files, tokens and a Kubernetes context. See [OpenShell OAuth tests](openshell-oauth.md).
- Run [`openshell-token-service`](../../scripts/ci/test-suites/openshell-token-service.json) to verify write-only static Source enrollment, IAM denial, rotation, and deletion through the API, PostgreSQL, and a disposable loopback Gateway. Provide the Gateway endpoint and separate management and operator mTLS files listed in the manifest. Select this lane in the [isolated PostgreSQL runner](postgresql.md#version-worker-tests).
- Run [`openshell-token-service-agent`](../../scripts/ci/test-suites/openshell-token-service-agent.json) to verify a live dedicated OpenClaw turn, native Provider rotation, and withdrawal of delivery from the running Agent. Prepare an isolated development Installation with a controller, worker, PostgreSQL, Kubernetes Compute on a disposable k3d cluster, private Agent routing, and [OpenShell TokenService and native delivery](../reference/credential-sources/managed-static.md#preview-openshell-custody). Use stock OpenShell 0.1.9 and a pinned [OpenShell runtime image](openshell.md#test-setup-and-cleanup). Provide the loopback OCC URL, a service key authorized to manage the test Source and Agent, and Gateway management mTLS inputs from the manifest.

  Set `drivers.sandbox.configuration.sandboxNamePrefix` to `os` so the lane can find the Agent's Sandbox. Use a dedicated test Namespace with no Agents and a service key that can list all Agents in it. Privately enroll a static OpenAI Source for this run. Supply the Namespace ID, Source ID, and an authorized OpenAI model in the manifest variables. Admit `api.openai.com:443` for the runtime Node.js executable in the Installation network ceiling. **The test replaces the Source key with synthetic material and deletes the Source.**

  ```sh
  node scripts/ci/run-tests.ts run openshell-token-service-agent --lifecycle complete \
    --attempt "${PRIVATE_FRESH_ATTEMPT:?}"
  ```

- [`image-pair-qualification`](../../scripts/ci/test-suites/image-pair-qualification.json): requires staged old and new controller and broker images. See [image-pair qualification](docker.md#repository-image-pair-qualification).
- [Strands listener replacement](../../scripts/ci/test-suites/strands-listener-replacement.json) requires a disposable, active Strands Agent in a loopback k3d cluster, the standard Helm worker, and an authenticated OCC CLI. The test replaces the Harness Pod, checks that both clients refuse its new certificate, and deploys a fresh revision to restore the Agent.
- Run [`strands-stock-model`](../../scripts/ci/test-suites/strands-stock-model.json) on a disposable [stock launcher installation](../reference/drivers/strands-box.md#stock-launcher-preview) with HTTP chat enabled. Supply the OCC URL on `127.0.0.1` or `[::1]`, a service key authorized to read the Agent and send chat, the Namespace ID and the Agent ID. For staged delivery, set `OCC_TEST_STRANDS_STOCK_SOURCE_ID` to the expected managed Source ID. Leave it unset for direct API key delivery. The test checks the saved revision’s Sandbox identity, sends one message in a fresh conversation and requires the exact reply on the same active revision. A live provider may charge for the turn. To check credential substitution separately, use a synthetic key and a controlled HTTPS origin. Match the test’s SHA-256 digest to the challenge in the authenticated Responses request.
- [`provider-cutover`](../../scripts/ci/test-suites/provider-cutover.json) requires a disposable, active dedicated Agent with namespace-local Harness routing, its tenant on local k3d, and an authenticated loopback OCC CLI. The [test](../../tests/integration/provider-cutover-real.test.ts) deploys a new revision, temporarily denies its Harness Deployment, verifies that the Gateway has no candidate route, then releases the hold and checks the activated route.
