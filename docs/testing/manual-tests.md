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
- [`egress-custody-installed`](../../scripts/ci/test-suites/egress-custody-installed.json) ([setup](protected-repository-custody.md)): verify repository request dispatch and protected response handling on a separately prepared controller and OpenShell pair, with an independent dispatch observer.
- [`repository-credentials-live`](../../scripts/ci/test-suites/repository-credentials-live.json): requires an authorized disposable repository and cleanup. See [repository credentials](repository-credentials.md).
- [`postgres-azure-workload-identity`](../../scripts/ci/test-suites/postgres-azure-workload-identity.json): see [Azure PostgreSQL tests](postgresql.md#azure-workload-identity-connections).
- [`ssh-host`](../../scripts/ci/test-suites/ssh-host.json): requires a disposable Linux/systemd host. Its optional model selector adds provider execution. See [SSH tests](ssh.md).
- [`plugin-model`](../../scripts/ci/test-suites/plugin-model.json): requires a disposable cluster with Envoy Gateway and cert-manager, its Gateway CA certificate and key, an authorized Codex account, an immutable Agent image and three distinct scenario databases. See [plugin tests](plugins.md#native-runtime-prerequisites).
- [`openshell-saved-agent`](../../scripts/ci/test-suites/openshell-saved-agent.json): run the saved-Agent Git ACL regression locally on Linux with Docker/k3d and the pinned OpenShell release. Prepare a qualified, same-source controller/runtime digest pair using the [native Git build](../guides/deploy/production-installation-preparation.md#build-a-controller-for-native-git). The controller must embed the runtime digest for both roles. On the regression host, set `QUALIFIED_CONTROLLER_IMAGE` and `QUALIFIED_RUNTIME_IMAGE` to the build's verified `CONTROLLER_IMAGE` and `RUNTIME_IMAGE` digest references, respectively. Set `PRIVATE_FRESH_ATTEMPT` to a fresh private attempt directory. Pull both images into the Docker daemon used by Local Setup.

  ```bash
  docker pull "${QUALIFIED_CONTROLLER_IMAGE:?}" &&
  docker pull "${QUALIFIED_RUNTIME_IMAGE:?}" &&
  env -u OCC_DEVELOPMENT_STATE_DIRECTORY -u CODEX_ACCESS_TOKEN \
    OCC_DEVELOPMENT_CONTROLLER_IMAGE="${QUALIFIED_CONTROLLER_IMAGE:?}" \
    OCC_KUBERNETES_RUNTIME_IMAGE="${QUALIFIED_RUNTIME_IMAGE:?}" \
    node scripts/ci/run-tests.ts run openshell-saved-agent --lifecycle complete \
    --attempt "${PRIVATE_FRESH_ATTEMPT:?}" \
    --file tests/integration/openshell-saved-agent-git-policy-real.test.ts
  ```

  The suite selects `issues` for native Issues write. Run the file directly
  with `issue-controls` to keep Issues write on the token, cap B's Agent grant at
  `apiLimits: { issues: "read" }` and restrict C to Git through its Namespace
  despite the Agent's Issues Write limit. Use `reads` to check
  that B's explicit write limit cannot exceed the token's Issues read permission.
  Calibrate the legacy callback in a Namespace without limits.

  ```bash
  env -u OCC_DEVELOPMENT_STATE_DIRECTORY -u CODEX_ACCESS_TOKEN \
    OCC_DEVELOPMENT_CONTROLLER_IMAGE="${QUALIFIED_CONTROLLER_IMAGE:?}" \
    OCC_KUBERNETES_RUNTIME_IMAGE="${QUALIFIED_RUNTIME_IMAGE:?}" \
    OCC_TEST_OPENSHELL_K3D_REAL=1 OCC_TEST_LOCAL_FIRST_AGENT_REAL=1 \
    OCC_TEST_OPENSHELL_SAVED_AGENT_ACL=1 OCC_TEST_OPENSHELL_SAVED_AGENT_REST=issue-controls \
    OPENAI_API_KEY=fixture-only-no-model-call OCC_TEST_OPENAI_MODEL=fixture-only-no-model-call \
    node --test tests/integration/openshell-saved-agent-git-policy-real.test.ts
  ```

- [`openshell-linear`](../../scripts/ci/test-suites/openshell-linear.json): starts a shipped OpenShell installation and verifies a Linear read through a normal Agent turn. It requires the connected-account file, model and read fixture from [Linear qualification](openshell.md#linear-tool-use-qualification).
- [`k3d-two-cluster`](../../scripts/ci/test-suites/k3d-two-cluster.json): requires two separately prepared clusters, a private configuration file and an OpenAI API key. See [two-cluster validation](kubernetes.md#two-cluster-validation).
- [`openshell-oauth`](../../scripts/ci/test-suites/openshell-oauth.json): requires a prepared OpenShell OAuth gateway, trust files, tokens and a Kubernetes context. See [OpenShell OAuth tests](openshell-oauth.md).
- Run [`openshell-token-service`](../../scripts/ci/test-suites/openshell-token-service.json) to verify write-only static Source enrollment, IAM denial, rotation, and deletion through the API, PostgreSQL, and a disposable loopback Gateway. Provide the Gateway endpoint and separate management and operator mTLS files listed in the manifest. Select this lane in the [isolated PostgreSQL runner](postgresql.md#version-worker-tests).
- Run [`openshell-token-service-agent`](../../scripts/ci/test-suites/openshell-token-service-agent.json) to verify a live dedicated OpenClaw turn, native Provider rotation, and withdrawal of delivery from the running Agent. Prepare an isolated development Installation with a controller, worker, PostgreSQL, Kubernetes Compute on a disposable k3d cluster, private Agent routing, and [OpenShell TokenService and native delivery](../reference/credential-sources/managed-static.md#preview-openshell-custody). Use stock OpenShell 0.1.9 and a pinned [OpenShell runtime image](openshell.md#test-setup-and-cleanup). Provide the loopback OCC URL, a service key authorized to manage the test Source and Agent, and Gateway management mTLS inputs from the manifest.

  Use a dedicated test Namespace with no Agents and a service key that can list all Agents in it. Privately enroll a static OpenAI Source for this run. Supply the Namespace ID, Source ID, and an authorized OpenAI model in the manifest variables. Admit `api.openai.com:443` for the runtime Node.js executable in the Installation network ceiling. **The test replaces the Source key with synthetic material and deletes the Source.**

  ```sh
  node scripts/ci/run-tests.ts run openshell-token-service-agent --lifecycle complete \
    --attempt "${PRIVATE_FRESH_ATTEMPT:?}"
  ```

- [`image-pair-qualification`](../../scripts/ci/test-suites/image-pair-qualification.json): requires staged old and new controller and broker images. See [image-pair qualification](docker.md#repository-image-pair-qualification).
- [Strands listener replacement](../../scripts/ci/test-suites/strands-listener-replacement.json) requires a disposable, active Strands Agent in a loopback k3d cluster, the standard Helm worker, and an authenticated OCC CLI. The test replaces the Harness Pod, checks that both clients refuse its new certificate, and deploys a fresh revision to restore the Agent.
- [`provider-cutover`](../../scripts/ci/test-suites/provider-cutover.json) requires a disposable, active dedicated Agent with namespace-local Harness routing, its tenant on local k3d, and an authenticated loopback OCC CLI. The [test](../../tests/integration/provider-cutover-real.test.ts) deploys a new revision, temporarily denies its Harness Deployment, verifies that the Gateway has no candidate route, then releases the hold and checks the activated route.
