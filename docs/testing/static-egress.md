---
tags: [human_verified]
# Backfilled from the verification tag recorded in 17ff921c5.
last_verified: "2026-11-04"
---

# Verify protected static inference

Local protected static-inference launches are retired. Before effects, the launcher rejects
`OCC_DEVELOPMENT_PROTECTED_EGRESS=1` and any presence of
`OCC_DEVELOPMENT_OPENSHELL_HOST_GATEWAY_IP`, including empty values.
Unset, empty or `0` protected-egress selections retain ordinary startup. There is
no fallback. See the [retirement notice](../guides/deploy/local-openshell-images.md#select-the-protected-profile).

For existing installations, retain state and ownership evidence for withdrawal and cleanup.

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

This selects literal files without provisioning dependencies or preventing skips.
For strict PostgreSQL coverage, use `postgres-platform` with local Docker;
provider and cluster credentials are unnecessary:

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

Unexpected skips, missing cases and cleanup failures fail the recipe. Retain
state/results for diagnosis and [cleanup recovery](postgresql.md).
[Installed qualification](#installed-runtime-and-provider-qualification) remains required.

## Authority and provider fixtures

Acceptance is synthetic. Qualify [installation-bound exchange and response custody](protected-repository-custody.md)
on the installed pair separately.

`static-egress.test.mjs` exercises Fastify authentication, source and Agent admission,
native IAM, controller transactions, OpenShell adapters, Ed25519 identity, TLS gRPC
and an HTTPS provider fixture. The Kubernetes Secret Driver reads UID and resourceVersion
over TLS; one case deliberately gives logical and runtime Namespaces different names.
No Sandbox, model service or cluster runs here.

Protobuf-compatible policy and V1 observations do not prove supervisor enforcement.
Missing observations refuse despite LOADED or legacy field 3. Access and send
check current evidence and admit only the exact name-only rule. Source/effective
hashes are distinct synthetic values, not computed supplier hashes. Extra endpoints,
binaries, changed policy and stale identities refuse before Secret reads.

Forged identities and unsupported operations refuse before credential access. Cases also
cover permission revoked between checks, material rotation, replay, selection mismatch,
credential reflection, rejection fencing and withdrawal. Sequential requests exceed 4,096 reservations using the test clock;
blocked Secret reads fill the 1,024 active slots, which delivery releases.

The digest regression reads in-memory committed authorization without sending.
`postgres-egress-send-receipts.test.mjs` uses PostgreSQL, a fault proxy and a byte-counting
origin. It drops the second COMMIT reply after reservation, verifies no permit or
origin arrival, then reconstructs the Forwarder before the deadline to exclude
replacement sends. Policy, material and acceptance remain synthetic. Other cases
cover expiry, cancellation and lost custody after authorization.

`tests/fixtures/static-egress/codex-responses.json` preserves a Codex 0.163.0-alpha.2
packaged CLI request and consumed finite synthetic SSE response. Prompt, model,
identity, local-tool names and descriptions are sanitized; field and tool schemas remain.
The profile retains local functions and namespaces but refuses provider web search,
including the default remote tool. Tests exercise classification, credential access,
send authorization and whole-response protection. They reject unknown fields/events,
remote tools, duplicate JSON keys, incomplete SSE, credential reflection across
output-item IDs, and credentials escaped in function-argument JSON or accumulated deltas.

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

Synthetic wires do not prove runtime-image identity, generated Harness execution,
model responses or installed enforcement. An interrupted-response probe with zero
request/stream retries observed one request and a failed CLI turn, not provider-effect recovery.

## Startup enrollment

Run the startup coordination integration separately:

```sh
node --test tests/integration/egress-enrollment.test.mjs
```

The generated entrypoint uses the real Sandbox service client against local HTTP
fixtures. A substituted CLI makes one request through real authority after
enrollment. Missing receipts block requests; committed receipts alone do not
release startup. Stale or wrong-instance/execution releases refuse; restart requires
a fresh challenge. Packaged Codex and supervisors are not exercised. The Compute
case `provider Harness endpoint owns Gateway transport through preparation and activation`
checks commit ordering and changed evidence with Driver dependencies. Wrapper
conformance checks zero retries, protected timeout failure and unchanged legacy retries.

## Captured supplier wires

`openshell-receipt.json` captures protobuf bytes from the supplier's gateway-token,
TLS-registry, OPA-installation and receipt-query fixture. Decoding preserves uint64
values; claim verification uses a local signing key and renewed timestamps without
reusing or establishing custody of the producer's token. It covers nested enforcement,
not the complete V1 observation. `openshell-operation.json` captures a TLS/gRPC
request after 100 ms, still expiring 30 seconds after creation. The consumer checks
that this historical operation refuses before material access. These are separate
synthetic fixtures, not one installed Sandbox.

## PostgreSQL state

With a migrated disposable database selected through `OCC_TEST_DATABASE_URL`, run:

```sh
node --test tests/integration/postgres-static-egress.test.mjs
```

Follow [database setup](postgresql.md): migrate with `occ_migrator`, run with `occ_app`.
Coverage includes persisted authentication/IAM, sources, revisions, installation
identity, rejection fences and constraints, with an independent state reader.
Application-process restart and provider-outcome recovery remain unproved.

## Installed runtime and provider qualification

End-to-end qualification needs a fresh protected revision rendered by the updated
controller, matching gateway/supervisor candidates, persisted installation evidence,
and a reachable authenticated bearer-passthrough Harness service. Observe no model
request before commit/enrollment, one initial probe afterward, and a fresh challenge
after process restart. This nonce check does not establish automatic recovery:
the default Kubernetes selection queues no periodic active-revision maintenance.
Also verify timeout holds startup without a business retry.

Also prove the supervisor requires credential-access capability, binds exact loaded
policy, refuses missing counterparts, withholds responses until protection completes,
and prevents workload bypass. Use the [OpenShell qualification contract](../reference/drivers/openshell-sandbox.md#qualification-contract)
and [real runtime procedures](kubernetes.md). The bundled legacy release is not
qualified by these tests. Indefinite streaming, WebSockets and dynamic credentials
remain unsupported. Finite SSE is released only complete and under 4 MiB; the
30-second deadline bounds its first byte, then supervisor progress renews a lease
(idle five minutes, ceiling fifteen). Fresh revisions with matching candidates are the
intended installed scope; mixed-version hot upgrades are unsupported and
no-bypass networking needs separate runtime proof. This consumer suite has no
installed native model-turn evidence.

## Protected launch packaging

The retired local launcher no longer provisions static-inference authority or Gateway
middleware. Independent loopback wire and production Kubernetes packaging checks remain:

```sh
node --test --test-name-pattern='OpenShell mTLS|OpenShell service transport never' \
  tests/conformance/openshell-gateway-wire.test.mjs
OCC_HELM_BIN=/absolute/bin/helm node --test --test-name-pattern='protected authority' \
  tests/integration/production-kubernetes-packaging.test.mjs
```

Loopback gRPC checks DNS/IP server identity, foreign-client refusal and absence of
client credentials on the separate service transport. Packaging checks the prepared
authority configuration. Neither proves cluster behavior, PostgreSQL execution,
middleware negotiation or OpenShell role mapping.

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

`checks-baseline-2` checks serialized bytes through Fastify parsing, authentication
and native IAM with in-memory storage and fixture Compute. Valid protected requests
must reach missing-counterpart refusal; unrelated `400`s cannot qualify them.
It covers observer database guards, proto3 uint64 handling, partial-output rejection,
exact bearer/mTLS shapes, fixture hostname restrictions and obfuscated provider vectors.
No provider, cluster or model runs; no installation receipt is supplied.

## Select the prepared connected lane

Run [the installed test](../../tests/integration/agent-openshell-static-egress-k3d-real.test.mjs)
with manual `egress-connected`, outside CI/GitHub dispatch and generic `openshell`
fixtures. Existing qualified installations require authenticated controllers and
a supplier gateway. Missing inputs fail; discovery skips prove nothing.
Authenticated controllers must accept fresh sources, or use
[A-to-B](static-egress-upgrade.md) for bundled retirement.

Use a ready Namespace with one placement in disposable loopback k3d, enforcing
NetworkPolicies and the [OpenShell prerequisites](openshell.md).
[Migrate](postgresql.md) a dedicated `openclaw_k8s_*` database; run controller and observer as
`occ_app` with matching Installations.

Select immutable product and supplier images agreeing on physical namespace
mapping, loaded-enforcement readiness, finite Responses protection and zero
automatic retries, including the startup probe. Missing contracts and legacy
gateway-copy setups cannot qualify.

Bind supplier source implementing [custody events](../../tests/helpers/egress-supplier-custody-transitions.mjs)
to its image receipt. Reject missing producer code; source presence,
enforcement capabilities and native replies cannot prove installed delivery.

Set `OCC_TEST_EGRESS_CONNECTED_INPUTS` to an absolute private JSON path.
The [validator](../../tests/helpers/egress-connected-inputs.mjs) rejects missing inputs:

| Input                                                                                                | Required preparation                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`, `namespaceId`, `model`                                                                    | Version `2`, the existing `ns_*` tenant ID and explicit Codex model name.                                                                                                                                                                    |
| `apiOrigin`                                                                                          | The controller's literal `127.0.0.1` origin with an explicit port above 1024.                                                                                                                                                                |
| `kubeconfigPath`, `kubernetesContext`, `runtimeClass`                                                | Explicit kubeconfig, disposable `k3d-*` context and approved OpenShell RuntimeClass.                                                                                                                                                         |
| `controllerNamespace`, `controllerSelector`, `openShellGatewayNamespace`, `openShellGatewaySelector` | Exact namespaces and selectors for the prepared controller (both API and worker) and supplier gateway Pods.                                                                                                                                  |
| `oceCommit`, `harnessCommit`, `supplierCommit`                                                       | Full product, test-checkout and supplier commits. Retain independent image build receipts.                                                                                                                                                   |
| `images`                                                                                             | Digest-pinned references under `agent`, `controller`, `gateway`, `openShellGateway`, `sandbox`, and `supervisor`, imported and registered in k3s. Use the exact references rendered in Pod specs.                                            |
| `openShellBackend`                                                                                   | HTTPS `endpoint`, absolute `rootCertificatePath`, and exactly `auth: { mode: "bearerTokenFile", path: "…" }` or `auth: { mode: "mtls", certificatePath: "…", privateKeyPath: "…" }`. All auth paths must be absolute; no insecure transport. |
| `provider`                                                                                           | Fixture-only HTTPS `.test` or exact `host.openshell.internal` `origin` ending `/v1`, explicit reachable IP `bindHost`, matching `bindPort: 443`, and absolute `certificatePath`/`privateKeyPath`.                                            |

Prepare provider TLS, supervisor DNS, routing and scoped egress before listening.
`host.openshell.internal` must resolve and match the certificate SAN. Authorize
only the owned listener's port-443 bind; keep host-wide privilege settings unchanged.
mTLS requires Backend support.

Before admission, configure the Installation
[model provider](../reference/drivers/kubernetes-compute/model-provider.md) with
`protocol: openai-responses` and `baseUrl` equal to `provider.origin`; retain both
across A-to-B. Source authorization cannot select routing.

In the runner's private environment file, set `OCC_TEST_EGRESS_CONNECTED_CONTROLLER`
to JSON containing the prepared `apiOrigin`, `namespaceId`, `model` and `providerOrigin`.
They must match the stack manifest. Supply the provisioned non-Agent controller key
in `OCC_TEST_EGRESS_CONNECTED_SERVICE_KEY`, never via a manifest-selected file.
The test confines that key to the selected origin, refuses redirects and removes it from child environments.

Set `OCC_TEST_DATABASE_URL` to the controller's loopback PostgreSQL URL without query
parameters, which can override host or database. Keep both files and credentials out of logs and Git.

Set `authorityProfile: "fresh-whole-execution"` and omit `credentialConnector`.
This lane requires execution authority, all five supplier capabilities, and a
loaded managed policy with the `/**` binary matcher on each model route. Run from
clean `harnessCommit`; `oceCommit` must be its ancestor (or equal). Both installed
callers verify this before cluster checks. Image build receipts remain separate proof.

The qualified supplier requires Helm value
`gatewayConfig["openshell.gateway"].config_delivery_mode: push` (default: `poll`)
for execution enrollment. Complete Gateway rollout before admission.
This does not qualify stock images.

With those prerequisites ready, select a fresh result directory:

```sh
run_dir="$PWD/.build/egress-connected/run-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$run_dir"
node --env-file=/absolute/path/to/private/connected.env \
  scripts/ci/run-tests.mjs run egress-connected \
  --state "$run_dir/state.json" --results "$run_dir/results.json"
```

The lane sets `OCC_TEST_EGRESS_CONNECTED=1`. Its 45-minute deadline includes an
optional controller replacement of at most 15 minutes. Activation has 12 minutes,
Codex turns 90 seconds, API requests 20 seconds and local cluster commands 120 seconds.
Allow 55 minutes for test and cleanup, plus stack teardown.
Killing a local client does not establish remote termination. Never replay an uncertain operation.

### Read evidence and retain cleanup custody

Retain `.build/egress-connected/runtime-<uuid>/`. `apiOperations` records operation
IDs, phases, HTTP statuses, allowlisted error codes (`UNKNOWN` otherwise), and
canonical request IDs checked for credentials. It excludes bodies, messages and
other headers. Interrupted or undecodable responses remain `unknown`. Cleanup
preserves entries and requires its own success checkpoint. `lastApi` identifies the latest attempt.

Gateway selection polls for two minutes within command and overall deadlines.
It requires exactly one nondeleting Ready Pod for the revision with its pinned
`gateway` container running and ready. The ledger records counts and pre-exec
checks. After each custody snapshot, recheck UID and readiness before targeting
`gateway`. Name-based exec can race replacement. Never retarget.

Public APIs create resources; the worker deploys. Authenticated supplier and persisted
receipts prove installation. Packaged Codex uses a fresh source with
`adoption: "live"` and `authorityScope: "execution"`.
Expected traffic: one startup probe, seventeen Codex sends (including seven
hostile responses and recovery), one sibling request, and one retained turn
if upgrading after B becomes ready.

Before the first measured turn, a three-minute polling budget requires a new
authenticated supervisor session after the baseline, then a 20-second enrollment
polling budget. In-flight reads retain their command deadlines. Supervisor and Agent container identities must remain unchanged.
Separate read-only transactions bracket typed policy observations against the
current committed installation. Peer pins must match before and after reconnect;
keys and configuration must remain stable. The exact deployment must succeed
without error or cleanup and retain the active revision. Failure blocks the turn.

`reconnect-*` checkpoints retain process/image/source identities, session IDs,
epochs and equality booleans; keys stay in memory. Gateway logs since run start
are limited to 2,000 lines and 1 MiB per Pod/read. Counts are observed lower
bounds. Passing proves natural same-process reconnect, not restart,
configuration-change, forced-disconnection or upgrade behavior.

The sibling and TCP probe use the authenticated [workload launch path](./protected-repository-custody.md);
Kubernetes exec inspects processes. Exchanges
require matching resolve, permit and response transitions. IAM revocation
must prevent permits and provider application bytes. The supervisor may establish TCP/TLS
before authorizing the captured request. TCP bypass must fail; verify listener
reachability before and after. Hostile responses require native HTTP status 403
(409 for oversized capture), no assistant output and private `response_blocked` evidence. Leak checks
cover Agent/Codex environments, responses, logs, diagnostics, audit, Pod specs
and ConfigMaps.

Before assertions, `gateway-turn-result` records expected and actual status.
Correlated fields include acknowledged `turn/start`, `turn/completed`, available
error classification and HTTP status, and up to four matching error notifications.
It omits messages, output, headers and RPC IDs.

Controller attempts retain operation IDs and uncertain outcomes. Responses cannot
prove effects. Failures retain the operation and `failure.kubectl`.
`failure.nativeExec` records bounded client progress, or `absent`/`invalid`; absent
frames leave startup uncertain. Pod declarations do not prove effective inputs.
`failure.custody` retains counts/categories. Private evidence adds bounded
request-ID/event pairs, identity checks and uncorrelated session observations.
Errors omit IDs/payloads. Failed reads preserve evidence; missing events never
establish refusal.
Deployment records public owner capability.

Cleanup deletes owned Agents, confirms API/Sandbox/Pod absence, removes supporting
resources and closes the provider. Reconcile missing Sandbox identities and
unconfirmed creates from the ledger. The parent owns interrupted cleanup and
prepared Namespace, database, cluster, controller and gateway disposal.

Passing covers only this static-inference slice and recorded inputs. Real-provider
usefulness, full credential/control-API containment, revocation between Resolve
and AuthorizeSend, mixed-version activation, HA, dynamic credentials, indefinite
streaming and full Egress MVP delivery need separate proof.

## Installed repository response and dispatch custody

Use the [dedicated qualification](protected-repository-custody.md) to prepare the
synthetic issuer, observe the exact authorization commit, exercise two clients and
a replacement, and check the response boundary on the installed pair.
