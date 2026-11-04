---
tags: [human_verified]
---

# Manual tests

These 11 lanes have no configured recurring GitHub runs and are excluded from
`ci`, `full`, and Full Integration dispatch. Select a lane explicitly after
completing its linked setup; see [lane execution and cleanup](ci/run-lanes.md#results-and-cleanup).
The `repository-credentials-installed` lane remains refused as noted below.

- [`egress-connected`](../../scripts/ci/test-suites/egress-connected.json) ([setup](static-egress.md#select-the-prepared-connected-lane)): select explicitly after preparing the protected controller, database, authenticated OpenShell stack, and synthetic HTTPS origin. CI runs the request preflight in `checks-baseline-2`; the generic `openshell` lane does not run this qualification.
- [`egress-custody-installed`](../../scripts/ci/test-suites/egress-custody-installed.json) ([setup](protected-repository-custody.md)): verify repository request dispatch and protected response handling on a separately prepared controller and OpenShell pair, with an independent dispatch observer.
- [`repository-credentials-live`](../../scripts/ci/test-suites/repository-credentials-live.json): requires an authorized disposable repository and cleanup. See [repository credentials](repository-credentials.md).
- [`repository-credentials-installed`](../../scripts/ci/test-suites/repository-credentials-installed.json): disabled until it can reliably clean up remote resources. See [installed Agent test requirements](repository-credentials.md#qualify-an-installed-agent-against-github).
- [`postgres-azure-workload-identity`](../../scripts/ci/test-suites/postgres-azure-workload-identity.json): see [Azure PostgreSQL tests](postgresql.md#azure-workload-identity-connections).
- [`ssh-host`](../../scripts/ci/test-suites/ssh-host.json): requires a disposable Linux/systemd host. Its optional model selector adds provider execution. See [SSH tests](ssh.md).
- [`plugin-model`](../../scripts/ci/test-suites/plugin-model.json): requires a disposable cluster with Envoy Gateway and cert-manager, its Gateway CA certificate and key, an authorized Codex account, an immutable Agent image and three distinct scenario databases. See [plugin tests](plugins.md#native-runtime-prerequisites).
- [`openshell-linear`](../../scripts/ci/test-suites/openshell-linear.json): starts a shipped OpenShell installation and verifies a Linear read through a normal Agent turn. It requires the connected-account file, model and read fixture from [Linear qualification](openshell.md#linear-tool-use-qualification).
- [`k3d-two-cluster`](../../scripts/ci/test-suites/k3d-two-cluster.json): requires two separately prepared clusters, a private configuration file and an OpenAI API key. See [two-cluster validation](kubernetes.md#two-cluster-validation).
- [`openshell-oauth`](../../scripts/ci/test-suites/openshell-oauth.json): requires a prepared OpenShell OAuth gateway, trust files, tokens and a Kubernetes context. See [OpenShell OAuth tests](openshell-oauth.md).
- [`image-pair-qualification`](../../scripts/ci/test-suites/image-pair-qualification.json): requires staged old and new controller and broker images. See [image-pair qualification](docker.md#repository-image-pair-qualification).
