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

## Reference Box sender

Build the [reference sender](../../runtimes/strands-credential-proxy/README.md)
from its public Box pin and native exchange patch, then run:

```sh
OCC_TEST_STRANDS_SENDER_BINARY="$PWD/runtimes/strands-credential-proxy/target/debug/oce-reference-gateway" \
  node --test tests/integration/strands-protected-sender.test.ts
```

This test-only variable selects the compiled executable. Without it the cases
skip; a selected missing or failing binary fails. The `strands-sender` CI lane
requires it. The Reference protected sender workflow builds the binary from
source and runs the cases without credentials or a cluster.

The suite uses real Box policy, the Rust terminal sender, current OCE authority,
IAM and Secret adapters, and a controlled TLS origin. The existing fixture
supplies installation and Kubernetes observations. It checks one allowed request,
withdrawal after material lookup, changed sender instance before response release,
a dropped origin reply, Box denial, unavailable authority, a captured OpenAI
Node SDK 7.5.0 header profile, and rejected credential, duplicate-placeholder
and unknown-header cases. The SDK wire control requires
exactly one origin request with only the OCE-selected credential and canonical
headers; the public placeholder and SDK metadata never reach that origin.
Unsupported fields never enter OCE resolution or its durable classification
path; their values are absent from the audit sink. The origin counts decrypted
application bytes across all accepted connections. Refusal after lookup
must produce zero bytes, and uncertain sends must not replay.

The optional `oce-protected-box` executable joins the sender to Box's real
hosted caller. Its [startup check](../../runtimes/strands-credential-proxy/checks/native-startup.py)
runs the built binary under strace, confirms post-hardening callback refusal
without an installation, and forbids network calls or workload execution.
The dedicated workflow builds and runs it; missing host tracing support fails
the check rather than skipping it. Rust tests separately force TLS to buffer
plaintext while the underlying socket remains pending past the permit deadline,
then verify that the TLS origin receives no application bytes.

This is reference transport proof, not native Agent or containment proof.
Main has no native Box Driver. Installed qualification still needs its admitted
execution, authenticated Harness, sender enrollment, and normal/direct-route
denial from the workload. The reference gateway starts no workload and must not
be presented as a second sandbox. Keep protected-profile admission disabled until
those suppliers and the installed checks exist.

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

The companion `openshell-receipt.json` contains actual protobuf bytes from the
supplier's connected gateway token, TLS registry, OPA installation and receipt-query
fixture. The consumer decodes those bytes, preserving uint64 values, and verifies
the captured claim shape with a local fixture signing key and renewed timestamps;
it does not reuse or establish custody of the producer's token. That capture covers
the nested enforcement message, not the complete V1 policy observation. The separate
`openshell-operation.json` captures the sender's TLS/gRPC request after a 100 ms
delay. Its deadline remains creation plus 30 seconds. The consumer checks that
historical operation refuses before material access. The two captures come from
separate synthetic fixtures, not one installed Sandbox.

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

Follow [connected static inference qualification](static-egress-connected.md)
for the prepared stack, private input manifest, lane command and required evidence.
This is an explicit local lane, not a CI or generic HTTP-fixture result.

### Read evidence and retain cleanup custody

The [evidence and cleanup procedure](static-egress-connected.md#read-evidence-and-retain-cleanup-custody)
requires independent origin and caller observations and reconciliation of uncertain
operations. Keep its private resource ledger until cleanup is confirmed.

## Installed repository response and dispatch custody

Use the [dedicated qualification](protected-repository-custody.md) to prepare the
synthetic issuer, observe the exact authorization commit, exercise two clients and
a replacement, and check the response boundary on the installed pair.
