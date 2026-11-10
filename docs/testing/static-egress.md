---
tags: [human_verified]
# Backfilled from the verification tag recorded in 17ff921c5.
last_verified: "2026-11-04"
---

# Verify protected static inference

The launcher has retired local protected static inference. It rejects
`OCC_DEVELOPMENT_PROTECTED_EGRESS=1` and any presence of
`OCC_DEVELOPMENT_OPENSHELL_HOST_GATEWAY_IP`, even empty, before side effects. There is no fallback.
Unset, empty or `0` protected-egress selections retain ordinary startup.
See the [retirement notice](../guides/deploy/local-openshell-images.md#select-the-protected-profile).

Keep ownership and state evidence for withdrawal and cleanup of existing installs.
Candidate Kubernetes Compute verifies the current installation before signing
workload release. Other Compute Drivers refuse protected admission. Bundled
OpenShell cannot enforce this profile. [Qualify the installed pair](#installed-runtime-and-provider-qualification)
before relying on the [execution admission cutoff](../reference/credential-sources/protected-inference.md#execution-admission-cutoff).

## Check a Credential Proxy change

With workspace dependencies installed, run:

```sh
pnpm test:files -- tests/integration/static-egress.test.mjs \
  tests/integration/egress-prepared-github-metadata.test.mjs \
  tests/integration/egress-installation-exchange.test.mjs
```

File selection neither installs dependencies nor guarantees zero skips. Use
`postgres-platform` with local Docker for strict PostgreSQL coverage. This
requires no provider or cluster credentials.

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

Unexpected skips, missing cases and cleanup failures fail the recipe. Keep
state and results for diagnosis and [cleanup recovery](postgresql.md). These
checks complement [installed qualification](#installed-runtime-and-provider-qualification).

## Authority and provider fixtures

These suites use synthetic acceptance. Check [installed exchange and response custody](protected-repository-custody.md)
on the candidate pair separately.

`static-egress.test.mjs` exercises Fastify authentication, source and Agent
admission, native IAM, controller transactions, OpenShell adapters, Ed25519,
TLS gRPC and fixture HTTPS. The Kubernetes Secret Driver reads UID and
resourceVersion over TLS, including distinct logical and runtime Namespaces.
No Sandbox, model service or cluster runs.

Gateway policy and V1 loaded-policy observations match supplier protobuf.
Only the exact name-only rule with current evidence at access and send qualifies.
Missing observations refuse even with LOADED and legacy field 3. Source and
effective hashes are distinct synthetic values. Extra endpoints, binaries,
changed policy and stale identities refuse before Secret reads. Supervisor
enforcement requires installed proof.

Cases cover pre-access refusal of forged identities and unsupported operations,
permission revocation between checks, rotation, replay, selection mismatch,
reflection, rejection fences and withdrawal. The test clock exceeds 4,096
sequential reservations. Blocked Secret reads fill 1,024 active slots, released by delivery.

The digest regression reads committed authorization from in-memory receipts
without sending. `postgres-egress-send-receipts.test.mjs` uses real PostgreSQL,
a fault proxy and a byte-counting origin. Losing the second COMMIT reply after
reservation yields no permit or origin arrival, even after reconstructing the
Forwarder before the deadline. It also covers expiry, cancellation and lost custody
after authorization. Policy, material and acceptance are synthetic.

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

`tests/fixtures/static-egress/codex-inline-tools.json` reduces a sanitized packaged
capture to two local tools and representative messages. The case authorizes its
format header and rejects unsupported roles, hosted tools and invalid annotations
before credential access. Public Codex source defines the
[inline declarations and format header](https://github.com/openai/codex/blob/db3c44414c2cd4ae33adaf4fa33382cb3dde6bd5/codex-rs/core/src/client.rs#L995),
[string-parameter annotation](https://github.com/openai/codex/blob/db3c44414c2cd4ae33adaf4fa33382cb3dde6bd5/codex-rs/tools/src/json_schema/types.rs#L50), and
[reasoning metadata](https://github.com/openai/codex/blob/db3c44414c2cd4ae33adaf4fa33382cb3dde6bd5/codex-rs/core/src/turn_metadata.rs#L86).

The live-envelope case verifies nullable local-tool metadata against public
[function](https://github.com/openai/openai-python/blob/0f73f1d519f8719b226e9084d78c8bdb4a60e48f/src/openai/types/responses/function_tool.py),
[custom](https://github.com/openai/openai-python/blob/0f73f1d519f8719b226e9084d78c8bdb4a60e48f/src/openai/types/responses/custom_tool.py) and
[namespace](https://github.com/openai/openai-python/blob/0f73f1d519f8719b226e9084d78c8bdb4a60e48f/src/openai/types/responses/namespace_tool.py)
types, including rejection of invalid types, formats and hosted tools.

These fixtures exercise selected client wire shapes against a synthetic provider.
They do not establish byte identity with a runtime image, generated Harness execution,
a real model response or installed OpenShell enforcement. A separate interrupted
response probe with request/stream retry counts set to zero observed one request
and a failed CLI turn; it is not a provider-effect recovery test.

## Startup enrollment

Run startup coordination separately:

```sh
node --test tests/integration/egress-enrollment.test.mjs
```

It launches the generated entrypoint with the selected Sandbox Driver's real
service client against local HTTP fixtures. A substituted CLI process makes
one local request through the real authority path after enrollment. The test proves
that an absent receipt blocks the first request, a committed receipt alone does not
release startup, and stale, wrong-instance or wrong-execution releases refuse. A
restart gets a fresh challenge. It does not execute packaged Codex or a supervisor.
The Compute conformance case `provider Harness endpoint owns Gateway transport
through preparation and activation` separately checks commit ordering and changed
evidence using Driver dependencies. Generated-wrapper conformance covers explicit
zero retry arguments, protected timeout failure and unchanged legacy retry behavior.

## Captured supplier wires

`openshell-receipt.json` holds protobuf bytes from the supplier's synthetic
gateway token, TLS registry, OPA installation and receipt-query fixture. The
consumer preserves uint64 values and verifies the nested enforcement claim with
a local signing key and renewed timestamps. The producer token and complete V1
policy observation are outside that capture. A separate synthetic fixture captured
`openshell-operation.json` after a 100 ms delay, with its TLS/gRPC deadline fixed
at creation plus 30 seconds. The consumer verifies refusal before material access.

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

Before qualifying a deployment, also prove the actual supervisor requires
the credential-access capability, binds the exact loaded policy, refuses missing
counterparts, withholds response bytes until protection completes, and prevents
workload bypass. Use the [OpenShell qualification contract](../reference/drivers/openshell-sandbox.md#qualification-contract)
and [real runtime procedures](kubernetes.md). The bundled legacy release is not
qualified by these tests. Indefinite streaming, WebSockets and dynamic credentials
remain unsupported. Finite SSE is released only complete and under 4 MiB; the
30-second deadline bounds its first byte, then supervisor progress renews a lease
(idle five minutes, ceiling fifteen). Fresh revisions with matching candidates are the
intended installed scope; mixed-version hot upgrades are unsupported and
no-bypass networking needs separate runtime proof. This consumer suite has no
installed native model-turn evidence.

## Protected launch packaging

The local protected-launch packaging recipe has been retired. The launcher no
longer provisions the static-inference authority or its Gateway middleware.
The independent loopback wire and production Kubernetes packaging checks remain:

```sh
node --test --test-name-pattern='OpenShell mTLS|OpenShell service transport never' \
  tests/conformance/openshell-gateway-wire.test.mjs
OCC_HELM_BIN=/absolute/bin/helm node --test --test-name-pattern='protected authority' \
  tests/integration/production-kubernetes-packaging.test.mjs
```

The loopback gRPC cases check DNS and IP server identity, foreign-client refusal
and absence of client credentials on the separate service transport. The
production packaging cases check the separately prepared authority configuration.
These checks do not establish cluster behavior, PostgreSQL execution, middleware
negotiation or OpenShell role mapping.

Connected qualification additionally requires reviewed, revision-matched images,
normal Agent admission, a disposable `openclaw_k8s_` database, and verified public
Gateway server trust for the Agent's WSS client. The Backend's API/worker trust
mount alone does not configure that client. Never project the administrator
client Secret into an Agent to solve server trust.

For upstream TLS, the supervisor uses its system CA bundle, regardless of
`SSL_CERT_FILE`. A fixture image may append the fixture's public CA to
`/etc/ssl/certs/ca-certificates.crt` while preserving existing contents and binaries.
Record both image digests and the CA fingerprint. Keep the CA private key out of
images and Pods. Leave host trust and hostname verification intact.

Old cleanup receipts may retain `openShellHostGatewayIP`; the launcher no longer
applies it. For already-prepared installations using `server.hostGatewayIP` for
`host.openshell.internal`, verify reachability from the selected runtime, the exact
certificate hostname, and admission of only the owned origin. Test recovery after Harness restart
separately. Packaging and loopback tests do not establish a connected model turn,
supervisor enforcement or bypass prevention.

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

The `egress-connected` CLI lane runs [installed qualification](../../tests/integration/agent-openshell-static-egress-k3d-real.test.mjs).
CI, GitHub dispatch and the generic `openshell` HTTP fixture omit it. Missing
inputs fail. Prepare an authenticated controller, worker and supplier gateway,
a ready Namespace with one placement in disposable loopback k3d, NetworkPolicies
and [OpenShell launch prerequisites](openshell.md). [Migrate](postgresql.md) a
dedicated `openclaw_k8s_*` database. Run controller and observer as `occ_app`;
the test compares database and controller Installations.

Select immutable, nonlegacy product and supplier images with matching physical
namespace mapping, loaded-enforcement receipt readiness, finite Responses
protection and zero automatic retries, including startup authentication.

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

In the private runner environment, set `OCC_TEST_EGRESS_CONNECTED_CONTROLLER`
to JSON with the manifest's `apiOrigin`, `namespaceId`, `model` and `providerOrigin`.
Supply the provisioned non-Agent key via `OCC_TEST_EGRESS_CONNECTED_SERVICE_KEY`.
The test restricts it to the selected origin and removes it from child environments.
Redirects and manifest-selected key files are forbidden. Set `OCC_TEST_DATABASE_URL`
to the controller's loopback PostgreSQL URL without query parameters that can
override host or database. Keep files and credentials out of logs and Git.

Select `authorityProfile: "fresh-whole-execution"` and omit `credentialConnector`.
Provide execution authority, five supplier capabilities and loaded managed policy
without a caller executable list. Run from the `oceCommit` checkout.

Select a fresh result directory:

```sh
run_dir="$PWD/.build/egress-connected/run-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$run_dir"
node --env-file=/absolute/path/to/private/connected.env \
  scripts/ci/run-tests.mjs run egress-connected \
  --state "$run_dir/state.json" --results "$run_dir/results.json"
```

The lane sets `OCC_TEST_EGRESS_CONNECTED=1`. Within 30 minutes it allows 12 minutes
for activation, 90 seconds per Codex turn, 20 seconds per API request and 120 seconds
per local cluster command. Allow 40 minutes with cleanup, plus stack teardown.
Local client termination leaves remote execution uncertain. Never replay an uncertain operation.

### Read evidence and retain cleanup custody

Before the first turn, the fixture requires deployment success and the exact
active revision. Terminal deployment failure stops the wait. The ledger
retains bounded, sanitized deployment observations.

The fixture then polls for up to two minutes for exactly one nondeleting Gateway
Pod for that Agent and revision. The Pod must be Ready and its pinned `gateway`
container running and ready. A second nondeleting Pod for that revision blocks
selection. The command and overall test deadlines still apply. The ledger retains
the last bounded Pod counts.

After each pre-turn custody snapshot, the fixture re-reads the selected Pod and
requires the same UID and readiness before explicitly targeting `gateway`.
The ledger retains the pre-exec check outcome. Kubernetes exec addresses the
Pod by name, so a replacement between the read and exec remains possible.
The fixture does not select a replacement or replay an uncertain turn.

The test creates resources via public APIs, deploys through the worker, reads
the persisted installation and verifies the authenticated supplier receipt.
It adopts a fresh unbound source using `adoption: "live"` and
`authorityScope: "execution"`. The Gateway runs the packaged Codex caller.
The origin observes startup, hostile-response and recovery sends, and an ordinary
sibling's managed request.

Use the supplier's authenticated [workload launch path](./protected-repository-custody.md)
for the sibling and TCP probe so both inherit connection mediation. Kubernetes
exec provides independent process inspection. The launch path is required to
establish managed workload traffic. Each measured exchange must match the
supervisor's resolve, permit and response transitions. IAM revocation must yield
no permit or upstream request. The raw TCP bypass to the same live listener must
yield no connection, with independent reachability checks immediately before
and after. After an authorized send, a hostile response must give Codex an empty
HTTP 502, produce no partial assistant output and record a private
`response_blocked` transition. The test checks that the synthetic provider
credential stays out of ordinary Agent and running Codex process environments,
observed responses, bounded logs, diagnostics, audit, Pod specs and ConfigMaps.

Retain `.build/egress-connected/runtime-<uuid>/`. The ledger's `apiOperations`
records IDs, phases, HTTP statuses, allowlisted error codes (`UNKNOWN` otherwise)
and canonical request IDs checked for known credentials. It omits bodies,
messages and other headers. Interrupted or undecodable responses remain
`unknown`. `lastApi` identifies the latest attempt. Cleanup preserves entries
and requires its own successful checkpoint.

The ledger records the failed operation and `failure.kubectl` outcome.
`failure.nativeExec` distinguishes recorded, absent and invalid frames. A frame
records client step, last acknowledged RPC, failure site, URL shape and nonempty
token presence. Missing frames leave startup uncertain. Pod declarations describe
configured inputs. The deployed checkpoint records public owner capability.

Before verifying each turn, the ledger checkpoints its expected and actual
terminal status. A bound result also records acknowledged `turn/start`, matching
`turn/completed`, an allowlisted typed error and HTTP status when supplied, and
up to four correlated retry observations. The summary omits raw messages, headers,
output and RPC identifiers. A startup probe's status describes that probe alone.

Cleanup removes the owned Agent, confirms API, Sandbox and workload Pod absence,
removes supporting resources and closes the provider. Use the ledger to reconcile
missing Sandbox identities or unconfirmed creates. The parent owns interrupted
cleanup and disposal of the prepared Namespace, database, cluster, controller
and Gateway.

Separate proof covers real-provider usefulness, full workload credential and
control API containment, revocation between Resolve and AuthorizeSend,
mixed-version activation, HA, dynamic credentials, long-lived streaming and
complete Egress MVP delivery.

## Installed repository response and dispatch custody

The [dedicated qualification](protected-repository-custody.md) covers synthetic
issuer setup, the exact authorization commit, two clients and a replacement,
and the installed response boundary.
