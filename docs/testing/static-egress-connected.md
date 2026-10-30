# Qualify connected static inference

This procedure exercises the installed OpenShell pair with a synthetic provider.
Start with the [static inference checks](static-egress.md) and their
[installed qualification requirements](static-egress.md#installed-runtime-and-provider-qualification).
It does not qualify the reference Box sender or establish real-provider behavior.

## Select the prepared connected lane

Run [the installed test](../../tests/integration/agent-openshell-static-egress-k3d-real.test.mjs)
with the `egress-connected` CLI lane. CI, GitHub dispatch and the generic `openshell`
HTTP fixture do not run it. The lane requires a prepared, authenticated controller,
worker and supplier gateway. Missing selected inputs fail; a discovery skip proves nothing.

Use a ready Namespace with one placement in disposable loopback k3d, enforcing
NetworkPolicies and the [normal OpenShell launch prerequisites](openshell.md).
[Migrate a dedicated](postgresql.md) `openclaw_k8s_*` database, then run the controller
and observer as `occ_app`. The test compares the database Installation with the controller's.

The protected product and supplier source must agree on physical namespace
mapping, loaded-enforcement receipt readiness, finite Responses protection and
zero automatic retries, including the startup authentication probe. Build and
select the corresponding immutable images before running. This test cannot
qualify a checkout that lacks those contracts or a legacy gateway-copy setup.

Set `OCC_TEST_EGRESS_CONNECTED_INPUTS` to an absolute path to a private JSON file.
The [input validator](../../tests/helpers/egress-connected-inputs.mjs) defines its
exact contract:

| Input                                                                                                | Required preparation                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`, `namespaceId`, `model`                                                                    | Version `2`, the existing `ns_*` tenant ID and explicit Codex model name.                                                                                                                                                                    |
| `apiOrigin`                                                                                          | The controller's literal `127.0.0.1` origin with an explicit port above 1024.                                                                                                                                                                |
| `kubeconfigPath`, `kubernetesContext`, `runtimeClass`                                                | Explicit kubeconfig, disposable `k3d-*` context and approved OpenShell RuntimeClass.                                                                                                                                                         |
| `controllerNamespace`, `controllerSelector`, `openShellGatewayNamespace`, `openShellGatewaySelector` | Exact namespaces and selectors for the prepared controller (both API and worker) and supplier gateway Pods.                                                                                                                                  |
| `oceCommit`, `supplierCommit`                                                                        | Accepted 40-character source commits. These are recorded provenance; Pod image references do not establish build-source equivalence.                                                                                                         |
| `images`                                                                                             | Digest-pinned references under `agent`, `controller`, `gateway`, `openShellGateway`, `sandbox`, and `supervisor`, imported and registered in k3s. Use the exact references rendered in Pod specs.                                            |
| `openShellBackend`                                                                                   | HTTPS `endpoint`, absolute `rootCertificatePath`, and exactly `auth: { mode: "bearerTokenFile", path: "…" }` or `auth: { mode: "mtls", certificatePath: "…", privateKeyPath: "…" }`. All auth paths must be absolute; no insecure transport. |
| `provider`                                                                                           | Fixture-only HTTPS `.test` or exact `host.openshell.internal` `origin` ending `/v1`, explicit reachable IP `bindHost`, matching high `bindPort`, and absolute `certificatePath`/`privateKeyPath`.                                            |

Prepare the synthetic provider certificate, supervisor DNS, routing, trust and scoped
egress before the test binds its listener. `host.openshell.internal` must resolve there
and appear in the certificate SAN. An mTLS input requires actual Backend mTLS support.

In the runner's private environment file, set `OCC_TEST_EGRESS_CONNECTED_CONTROLLER`
to JSON containing the prepared `apiOrigin`, `namespaceId`, `model` and `providerOrigin`.
They must match the stack manifest. Supply the provisioned non-Agent controller key
in `OCC_TEST_EGRESS_CONNECTED_SERVICE_KEY`, never via a manifest-selected file.
The test confines that key to the selected origin, refuses redirects and removes it from child environments.

Set `OCC_TEST_DATABASE_URL` to the controller's loopback PostgreSQL URL without query
parameters, which can override host or database. Keep both files and credentials out of logs and Git.

Set `authorityProfile: "fresh-whole-execution"` and omit `credentialConnector`.
This lane requires execution authority, all five supplier capabilities, and a
loaded managed policy with no caller executable list. Run it from the candidate
checkout named by `oceCommit`.

With those prerequisites ready, select a fresh result directory:

```sh
run_dir="$PWD/.build/egress-connected/run-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$run_dir"
node --env-file=/absolute/path/to/private/connected.env \
  scripts/ci/run-tests.mjs run egress-connected \
  --state "$run_dir/state.json" --results "$run_dir/results.json"
```

The lane sets `OCC_TEST_EGRESS_CONNECTED=1`. Its 30-minute deadline bounds activation
(12 minutes), Codex turns (90 seconds), API requests (20 seconds) and local cluster
commands (120 seconds). Allow 40 minutes for test and cleanup, plus stack teardown.
Killing a local client does not establish remote termination. Never replay an uncertain operation.

### Read evidence and retain cleanup custody

The test creates resources through public APIs, deploys through the real worker,
reads its persisted installation, and checks the authenticated supplier receipt.
It uses the packaged Codex app-server caller from the Agent Gateway Pod. It
explicitly adopts its fresh unbound source with `adoption: "live"` and
`authorityScope: "execution"`. The origin observes seventeen requests: one
normal startup probe, fifteen measured Codex sends (including six hostile
responses and recovery), and one managed request from an ordinary sibling.
For that sibling and the direct TCP probe, the operator uses the supplier's
authenticated [workload launch path](./protected-repository-custody.md) so both
inherit the installed connection mediation. Kubernetes exec remains suitable for
independent process inspection, but cannot establish managed workload traffic.
Each measured exchange must join the supervisor's resolve, permit and response
transitions. IAM revocation must produce no permit or upstream request. A raw
TCP bypass to the same live listener must produce no connection, with independent
reachability controls immediately before and after. Hostile responses must give
Codex an empty HTTP 502, no partial assistant output, and a private
`response_blocked` transition after the authorized provider send. The test
checks that the synthetic provider credential is absent from the ordinary Agent
and running Codex process environments, observed responses, bounded logs,
diagnostics, audit, Pod specs and ConfigMaps.

Retain `.build/egress-connected/runtime-<uuid>/` for atomic phase checkpoints, resource
IDs and bounded observations, without raw requests or credentials. Each controller
attempt starts with an operation ID and unknown outcome. A response does not establish
the effect. Failures retain the phase and source location.

Cleanup removes the owned Agent, confirms API, Sandbox and workload Pod absence,
then removes supporting resources and closes the provider. Reconcile missing Sandbox
identities or unconfirmed creates from the ledger. The parent owns interrupted cleanup
and disposal of the prepared Namespace, database, cluster, controller and gateway.

A passing selected run establishes only this static-inference slice at its
recorded inputs. Source checks are not runtime proof. The scenario does not
prove real-provider usefulness, all workload credential/control-API containment,
revocation between Resolve and AuthorizeSend, mixed-version activation, HA,
dynamic credentials, long-lived streaming or complete Egress MVP delivery.
