# Verify protected static inference

Bundled OpenShell cannot enforce this profile. Candidate Kubernetes Compute verifies
the current installation before signing the workload release. Other Compute Drivers
refuse protected admission. [Qualify the installed pair](#installed-runtime-and-provider-qualification)
before relying on [this boundary](../reference/credential-sources/protected-inference.md#execution-admission-cutoff).

## Check a Credential Proxy change

With installed workspace dependencies, run the focused source suites:

```sh
pnpm test:files -- tests/integration/static-egress.test.mjs \
  tests/integration/egress-prepared-github-metadata.test.mjs \
  tests/integration/egress-installation-exchange.test.mjs
```

This selects literal files; it does not provision dependencies or guarantee
that cases ran without skips. For strict PostgreSQL coverage, use the broader
`postgres-platform` lane with local Docker. No provider or cluster credentials
are needed:

```sh
(
  set -eu
  umask 077
  PG_PLATFORM_RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/oce-postgres-platform.XXXXXX")"
  printf 'PostgreSQL run directory: %s\n' "$PG_PLATFORM_RUN_DIR"
  trap 'pg_run_status=$?; node scripts/ci/cleanup.mjs --state "$PG_PLATFORM_RUN_DIR/state.json" || pg_run_status=1; exit "$pg_run_status"' EXIT

  node scripts/ci/prepare.mjs --lane postgres-platform \
    --state "$PG_PLATFORM_RUN_DIR/state.json" \
    --github-env "$PG_PLATFORM_RUN_DIR/owner.env"
  node scripts/ci/run-tests.mjs run postgres-platform \
    --state "$PG_PLATFORM_RUN_DIR/state.json" \
    --results "$PG_PLATFORM_RUN_DIR/results.json"
)
```

The runner rejects unexpected skips and missing cases; cleanup failures also
fail this recipe. Keep the printed state/results directory for diagnosis and
[cleanup recovery](postgresql.md). Source and database
checks do not replace [installed qualification](#installed-runtime-and-provider-qualification).

## Authority and provider fixtures

The focused suites above use synthetic acceptance. Test [installation-bound exchange
and response custody](protected-repository-custody.md) on the candidate pair separately.

`static-egress.test.mjs` exercises Fastify authentication, source and Agent admission,
native IAM, controller transactions, OpenShell adapters, Ed25519 identity, TLS gRPC
and an HTTPS provider fixture. The Kubernetes Secret Driver reads UID and resourceVersion
over TLS; one case deliberately gives logical and runtime Namespaces different names.
No Sandbox, model service or cluster runs here.

Gateway policy and V1 loaded-policy observations match the supplier protobuf, but
do not prove supervisor enforcement. Missing observations refuse even with LOADED
and legacy field 3. We check current evidence at access and send, admitting only
the exact name-only rule. Source and effective hashes are distinct synthetic values, not computed supplier policy hashes.
Extra endpoints, binaries, changed policy and stale identities refuse before Secret reads.

Forged identities and unsupported operations refuse before credential access. Cases also
cover permission revoked between checks, material rotation, replay, selection mismatch,
credential reflection, rejection fencing and withdrawal. Sequential requests exceed 4,096 reservations using the test clock;
blocked Secret reads fill the 1,024 active slots, which delivery releases.

The fast digest regression reads the committed authorization from the in-memory receipt
store; it sends no request. `postgres-egress-send-receipts.test.mjs` uses real PostgreSQL
transactions, a fault proxy and a byte-counting origin. It drops the second COMMIT reply
after reservation, verifies no permit or origin arrival, and reconstructs the Forwarder
before the deadline to rule out a replacement send. Policy, material and acceptance remain
synthetic. The suite also covers expiry, cancellation and lost custody after authorization.

`tests/fixtures/static-egress/codex-responses.json` preserves a selected Codex
0.163.0-alpha.2 packaged CLI request and finite synthetic SSE response consumed by
that CLI. Prompt, model, identity, local tool names and descriptive values are sanitized;
field and local-tool schema shapes are retained. The protected profile disables
provider web search while keeping local functions and namespaces. The default remote web-search
tool is a refusal vector. The application test sends these bytes through actual
classification, credential access, send authorization and whole-response protection.
It also rejects unknown fields/events, remote tools, duplicate JSON keys, incomplete
SSE, credential reflection split across distinct output-item IDs, and credentials
escaped inside function-argument JSON or its accumulated streaming deltas.

This capture proves the selected direct CLI wire shape against a synthetic provider.
It does not establish byte identity with a runtime image, generated Harness execution,
a real model response or installed OpenShell enforcement. A separate interrupted
response probe with request/stream retry counts set to zero observed one request
and a failed CLI turn; it is not a provider-effect recovery test.

## Startup enrollment

Run the startup coordination integration separately:

```sh
node --test tests/integration/egress-enrollment.test.mjs
```

It launches the actual generated entrypoint and uses the selected Sandbox Driver's
real service client against local HTTP fixtures. A substituted CLI process makes
one local request through the real authority path after enrollment. The test proves
that an absent receipt blocks the first request, a committed receipt alone does not
release startup, and stale, wrong-instance or wrong-execution releases refuse. A
restart gets a fresh challenge. It does not execute packaged Codex or a supervisor.
The Compute conformance case `provider Harness endpoint owns Gateway transport
through preparation and activation` separately checks commit ordering and changed
evidence using Driver dependencies. Generated-wrapper conformance covers explicit
zero retry arguments, protected timeout failure and unchanged legacy retry behavior.

## Captured supplier wires

The companion `openshell-receipt.json` contains actual protobuf bytes from the
supplier's connected gateway token, TLS registry, OPA installation and receipt-query
fixture. The consumer decodes those bytes, preserving uint64 values, and verifies
the captured claim shape with a local fixture signing key and renewed timestamps;
it does not reuse or establish custody of the producer's token. That capture covers
the nested enforcement message, not the complete V1 policy observation. The separate
`openshell-operation.json` captures the sender's TLS/gRPC request after a 100 ms
delay. Its deadline remains creation plus 30 seconds. The consumer checks that
historical operation refuses before material access. These two captures come from
different synthetic component fixtures, not one installed Sandbox.

## PostgreSQL state

With a migrated disposable database selected through `OCC_TEST_DATABASE_URL`, run:

```sh
node --test tests/integration/postgres-static-egress.test.mjs
```

Follow the [database setup](postgresql.md): migrate with `occ_migrator` and run
with `occ_app`. This test uses persisted authentication and native IAM, source and
revision state, exact installation identity, rejection fences and database
constraints. A separate state reader verifies persisted observations. It does not
claim an application-process restart or provider outcome recovery.

## Installed runtime and provider qualification

End-to-end qualification needs a fresh protected revision rendered by the updated
controller, matching gateway/supervisor candidates, persisted installation evidence,
and a reachable authenticated bearer-passthrough Harness service. Observe no model
request before commit/enrollment, one initial probe afterward, and a fresh challenge
after process restart. This nonce check does not establish automatic recovery:
the default Kubernetes selection queues no periodic active-revision maintenance.
Also verify timeout holds startup without a business retry.

Before qualifying a deployment, additionally prove the actual supervisor requires
the credential-access capability, binds the exact loaded policy, refuses missing
counterparts, withholds response bytes until protection completes, and prevents
workload bypass. Use the [OpenShell qualification contract](../reference/drivers/openshell-sandbox.md#qualification-contract)
and [real runtime procedures](kubernetes.md). The bundled legacy release is not
qualified by these tests. Indefinite streaming, WebSockets and dynamic credentials
remain unsupported. Finite SSE is released only complete and under 4 MiB; the
30-second deadline bounds its first byte, then supervisor progress renews a lease
(idle five minutes, ceiling fifteen). Fresh revisions with matching candidates are the
intended installed scope; mixed-version hot upgrades are unsupported and
no-bypass networking requires separate runtime proof. There is no successful installed native model-turn
evidence in this consumer suite.

## Protected launch packaging

The [explicit local profile](../guides/deploy/local-openshell-images.md#select-the-protected-profile)
generates normal Installation and Helm inputs. For a local packaging check,
select the matching supplier chart through the test-only
`OCC_TEST_OPENSHELL_CHART` and an installed Helm executable through `OCC_HELM_BIN`:

```sh
OCC_TEST_OPENSHELL_CHART=/absolute/supplier/deploy/helm/openshell \
OCC_HELM_BIN=/absolute/bin/helm \
GOEXPERIMENT=jsonv2 go test ./internal/occdev
node --test --test-name-pattern='OpenShell mTLS|OpenShell service transport never' \
  tests/conformance/openshell-gateway-wire.test.mjs
OCC_HELM_BIN=/absolute/bin/helm node --test --test-name-pattern='protected authority' \
  tests/integration/production-kubernetes-packaging.test.mjs
```

The Go case runs the release coordinator with command-boundary fixtures, loads
its output through real controller composition, checks the generated server
certificate, and renders both charts with real Helm. The first release requests
zero workers. A successful Gateway rollout leads to one worker, while a failed
rollout ends the installation without ever requesting a worker. This checks
configuration, credential projection, database selection and startup ordering.
Cluster behavior, PostgreSQL execution and installed middleware negotiation
require connected verification. The wire cases use
generated CA/client certificates and actual loopback gRPC TLS, including DNS and
IP server identity, foreign-client refusal and absence of client credentials on
the separate service transport. They do not prove OpenShell's role mapping.

Connected qualification additionally requires reviewed, revision-matched images,
normal Agent admission, a disposable `openclaw_k8s_` database, and verified public
Gateway server trust for the Agent's WSS client. The Backend's API/worker trust
mount alone does not configure that client. Never project the administrator
client Secret into an Agent to solve server trust.

For a synthetic HTTPS provider, the supervisor reads its normal system CA bundle;
`SSL_CERT_FILE` does not configure upstream TLS re-encryption. A fixture image may
preserve the original bundle at `/etc/ssl/certs/ca-certificates.crt` and append the
fixture's public CA. Preserve all normal binaries/components, record the base and
derived image digests and CA fingerprint, and identify results as fixture-image
proof. Keep the CA private key outside images and Pods. Do not change host trust
or disable hostname checking.

The existing `server.hostGatewayIP` supplier value maps `host.openshell.internal`.
The protected launcher passes the optional canonical private IPv4 selected by
`OCC_DEVELOPMENT_OPENSHELL_HOST_GATEWAY_IP` to that value.
Use it only after verifying the owned host address is reachable from the selected
runtime and the fixture server certificate covers that exact hostname. A connected
test must explicitly admit that owned origin; it must not accept arbitrary
external hosts. Initial enrollment does not establish automatic recovery after
a Harness process restart; qualify any required reconciliation/redeployment
separately. Packaging and loopback tests do not establish a connected model turn,
supervisor enforcement or no-bypass networking.

## Check connected request admission without a runtime

```sh
node --test tests/integration/egress-connected-preflight.test.mjs
```

The `checks-baseline-2` lane runs this file. It checks serialized request bytes
through Fastify's real content parser, authentication and native IAM with
in-memory storage and fixture Compute. Valid protected requests must reach the
missing-counterpart refusal; an unrelated `400` cannot qualify them. It also
checks the connected observer's database guards, proto3 uint64 handling and
rejection of partial assistant output, exact bearer/mTLS input shapes, fixture
hostname restrictions and obfuscated provider vectors. It starts no provider,
cluster or model runtime and supplies no installation receipt.

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

## Installed repository response and dispatch custody

Use the [dedicated qualification](protected-repository-custody.md) to prepare the
synthetic issuer, observe the exact authorization commit, exercise two clients and
a replacement, and check the response boundary on the installed pair.
