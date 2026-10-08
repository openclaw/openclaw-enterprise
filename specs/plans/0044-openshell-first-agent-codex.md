# Implementation plan: OpenShell first-Agent dedicated Codex

- **ID:** TASK-0044
- **Delivery status:** In progress
- **Owner:** Kubernetes Compute, OpenShell Sandbox Driver, and local first-Agent workflow
- **Authority:** Current Harness execution, Sandbox Driver, Credential Gateway, and local development contracts
- **Source baseline:** `66922a5c23a4`, with OpenShell pinned to `v0.1.3-pre.2`

## Outcome and scope

The local [first-Agent workflow](../../docs/guides/first-agent.md) can explicitly
select a dedicated Codex Harness in a Kubernetes development installation. When
the Installation selects OpenShell, the command registers the model key through
the existing Credential Gateway and completes a real model turn through the
Agent-owned Gateway and OpenShell-exposed Codex app server.

This delivery uses OpenShell's opt-in
[bearer passthrough](https://github.com/NVIDIA/OpenShell/pull/3796) and experimental
[provider-managed files](https://github.com/NVIDIA/OpenShell/pull/3832), both in
the pinned prerelease. It is a development workflow, not production qualification
of OpenShell's experimental APIs.

The first slice supports plugin-free dedicated Codex with an OpenAI API-key
CredentialSource. It does not add embedded OpenClaw support to OpenShell, OAuth,
repository credentials, selected Codex plugins, or native OpenClaw file delivery.
Those paths keep their current fail-closed behavior. This plan does not expand the
unaccepted remainder of the [credential-injection RFC](../rfcs/0016-sandbox-credential-injection.md).

## Contract and source touchpoints

### Select the first-Agent Harness

Add `--harness openclaw|codex` to
[`scripts/first-agent.mjs`](../../scripts/first-agent.mjs), defaulting to the
current embedded OpenClaw behavior. Freeze the choice in the helper's private
record so a rerun cannot silently change topology.

`codex` renders the existing dedicated Codex configuration: the selected model
is `codex/<model>`, the `codex` provider uses `openai-responses` with the
fail-closed `http://127.0.0.1:9` base URL, and execution mode is `dedicated`.
With no Sandbox Driver it retains Secret-backed API-key authentication. With
OpenShell it creates one `openai` CredentialSource from the helper-owned Secret,
binds the Agent to that source, and grants the Agent service principal exact
`credential_source:operate` without Secret access. `--replace-key` updates the
Secret, pushes the source update, and deploys a new revision.

An OpenShell installation rejects the default `openclaw` selection before any
resource mutation and points to `--harness codex`. Existing helper-owned Agents
must match their recorded Harness, Configuration, authentication binding, and
resources before reuse.

### Make workload identity an optional capability

Treat an Agent ServiceAccount name and its projected token as one optional
workload-identity capability. Production composition may select
`servicePrincipalCredentials.mode: disabled`; until OCC has a client and verifier
for these credentials, the OpenShell Sandbox may instead use its
gateway-configured infrastructure ServiceAccount. The Agent must not receive that
supervisor credential.

When projected Agent identity is explicitly enabled, a Sandbox Driver must
preserve the exact Agent ServiceAccount and token projection or reject the
revision before mutation. It must never silently fall back to infrastructure
identity. Kubernetes ServiceAccount tokens remain evidence within one cluster
trust domain, not portable OCE Agent identity. A future split-cluster deployment
must verify evidence in each cluster and exchange it for a short-lived,
Agent-and-revision-scoped OCE credential; the Gateway and dedicated Harness
authenticate separately.

### Provide semantic writable runtime state

Define bounded, revision-local writable runtime state semantically rather than
requiring `/home/node` or a particular volume type. Ordinary Kubernetes keeps its
current `/home/node` and `/tmp` `emptyDir` mounts. OpenShell places disposable
runtime state below `/sandbox/.openclaw-runtime`, authorizes only that tree for
writes, and bounds it with Kubernetes ephemeral-storage requests and limits.

Persistent workspace, node identity, Codex sessions, and generated images remain
separate Agent PVC subpaths. Runtime entrypoints derive their home, temporary,
workspace, node-state, and Codex paths from the admitted environment so both
layouts execute the same supported workflow. Environment paths that name an
exact persistent mount point use a process-owned child beneath its real
directory; atomic state writes must neither traverse a compatibility symlink nor
attempt to tighten a root-owned mount root.

### Keep the app-server token outside the Sandbox

For an OpenShell-owned Codex Harness, Kubernetes Compute reads the exact
Agent-owned transport Secret, validates its ownership, and supplies only a
lowercase SHA-256 verifier as literal `APP_TOKEN_SHA`. It does not create or
reference a data-plane Secret containing the raw app-server token. The dedicated
Gateway keeps `APP_SERVER_TOKEN` and sends it as the bearer credential.

The Codex runtime entrypoint accepts exactly one of `APP_SERVER_TOKEN` and
`APP_TOKEN_SHA`. The ordinary Compute-owned path hashes the former as it does
today; the OpenShell path validates and passes the latter to Codex's
`--ws-token-sha256`. The OpenShell Sandbox Driver sets
`SERVICE_AUTHORIZATION_MODE_BEARER_PASSTHROUGH` only on the dedicated Codex
service exposure. Every other exposed service retains OpenShell's stripping
default. OpenShell transports the header; Codex remains the authenticator.

Selected plugins remain unsupported because their per-start HMAC token exchange
currently requires the raw base token and private runtime-status channel. Reject
that topology before creating OpenShell resources rather than weakening the
token boundary.

### Route the Gateway through the OpenShell exposure

For an OpenShell-owned dedicated Codex Harness, use the Driver's endpoint
capability to set the Gateway's `APP_SERVER_URL` to the exposed WebSocket origin.
The Gateway keeps the bearer token, OpenShell relays it, and Codex validates it
through `APP_TOKEN_SHA`. Keep the Kubernetes Agent Service inactive, omit its
Harness route, and allow Gateway egress only to the configured OpenShell peer.

Drivers without the endpoint capability retain the existing Kubernetes Service
transport. Capability detection, not a platform-core vendor check, selects the
route. Missing, malformed, non-WebSocket, or unreachable endpoints fail closed.

OpenShell `v0.1.3-pre.2` advertises development service hosts below
`openshell.localhost`. In the owned k3d development profile only, `dev-up` may
map the exact returned hostname to the OpenShell Gateway Service address and
admit the corresponding Gateway-to-OpenShell peer. This mapping is not a
production fallback. A production or split-cluster installation must provide a
routable endpoint, verified TLS identity, and explicit network policy.

For a first revision, start the Gateway against its fail-closed Kubernetes target
while its Agent Service stays inactive. After the ready Gateway issues exact
workspace-node setup material, attach providers, call `provisionHarness`, and
replace the Gateway template with the returned endpoint. Retries re-observe it.
A replacement keeps the serving endpoint until activation switches candidates.

### Deliver immutable plugin-runtime files

Extend
[`HarnessWorkloadRequirements`](../../packages/contracts/src/index.ts) with a
bounded list of non-secret, immutable workload files. Each entry carries a safe
logical name, UTF-8 content, and the environment variable through which the
runtime opens it. Kubernetes Compute produces `runtime.json` and `config.toml`
from the existing admitted plugin-runtime snapshot instead of asking a Sandbox
Driver to read a Kubernetes ConfigMap. It omits the old ConfigMap-path variables
from the remaining environment.

The OpenShell Sandbox Driver validates the exact plugin-free Codex file set and
realizes it as a runtime OpenShell provider, distinct from the model
CredentialSource provider:

- One OCE-owned profile per Workspace declares `runtime.json`, `config.toml`,
  and the nonsecret node-envelope file, with environment variables pointing to
  their virtual paths.
- One revision-owned provider stores the admitted contents as non-secret config
  and is attached in the same `CreateSandbox` request as the model provider.
- Names and labels bind the provider to the Namespace, Agent, and revision.
  Foreign collisions, missing files, unsafe names, duplicate environment keys,
  and upstream size-limit failures stop provisioning.
- Provisioning creates or adopts only exact-owned objects. Cleanup deletes the
  Sandbox before its revision provider and removes the shared profile during
  Namespace cleanup after no owned provider uses it.

The runtime opens the reported absolute paths directly. It does not depend on
directory listing, metadata lookup, writable files, or inotify, which the
experimental upstream API does not provide.

### Enroll the workspace node through WebSocket substitution

Do not store the complete workspace-node setup code as one OpenShell credential.
OpenShell exposes static credentials to the workload as opaque placeholders,
but OpenClaw must decode the complete setup argument before it opens a network
connection. A whole-code placeholder therefore cannot reach the proxy rewrite
surface.

The OpenShell Sandbox Driver reads the exact Agent-owned setup Secret and
validates its base64url JSON envelope. It stores only `bootstrapToken` as an
OpenShell credential, with the setup expiry, and stores the URL, expiry, and
optional TLS fingerprint as nonsecret provider config. The profile exposes the
credential as `OPENCLAW_NODE_BOOTSTRAP_TOKEN` rather than
`OPENCLAW_NODE_SETUP_CODE`.

The Harness entrypoint combines the nonsecret envelope with that environment
placeholder and base64url-encodes a normal setup code. OpenClaw's existing
decoder can then validate the URL, expiry and fingerprint and accepts the
nonempty placeholder as the token field. The node sends it in the initial
WebSocket text message.

Keep the runtime profile endpointless and add one revision-specific Sandbox
policy binding for its provider name, exact Agent Gateway host, port and path,
node executable, and WebSocket credential rewrite. OpenShell may resolve the
placeholder only for that request. No binding, another binary or destination,
malformed or expired setup, unresolved placeholder, or Gateway rejection keeps
the workspace node unpaired and the revision inactive. Successful pairing saves
the node's durable device identity on its Agent-owned PVC; later starts use that
identity instead of the consumed bootstrap token. Revision cleanup deletes the
Sandbox before the provider.

For same-cluster OpenShell, mint and observe setup through the private WSS route
but put the Agent Gateway's cluster-local Service URL in the setup envelope.
Grant the exact Service port to the OpenShell supervisor that originates proxy
traffic, and wait for the provider-endpoint Gateway rollout before observing
enrollment. Preserve the private WSS node URL for other Sandbox Drivers.

## Implementation

1. Update the contract, Kubernetes Compute preparation, and Codex entrypoint in
   `packages/contracts/src/index.ts` and
   `apps/controller/src/drivers/compute/kubernetes/`. Model projected
   ServiceAccount identity as optional, derive runtime paths from the admitted
   environment, preserve the ordinary Secret-backed runtime while deriving only
   `APP_TOKEN_SHA` for OpenShell, add an optional provider-owned Harness endpoint
   capability, and reject unsupported identity, plugin-enabled, malformed
   Sandbox requirements, or invalid endpoints before effects. Bootstrap a first
   provider-owned Harness Gateway fail closed, and keep provider and Sandbox
   creation blocked until its workspace-node setup material exists. Keep the
   existing Agent Service path for Drivers that do not implement the capability.
   Admit the provider-fenced Harness only to the exact workspace-node Gateway
   route, and use a bounded OpenShell startup delay until service readiness exists.
2. Add the pinned protobuf fields and typed client mappings for service
   authorization, profile files, provider config, credential expiry, endpoint
   binding, and WebSocket credential rewrite in
   `apps/controller/src/drivers/sandbox/`. Split the node setup envelope in the
   OpenShell Sandbox Driver, reconstruct it in the Harness entrypoint, and
   implement the runtime provider's ownership, idempotence, attachment,
   rollback, and ordered cleanup. Keep both credential bindings and bearer
   passthrough limited to their exact endpoints.
3. Add the explicit Harness option and OpenShell CredentialSource lifecycle to
   `scripts/first-agent.mjs` and its database/IAM helper. Preserve safe reruns,
   key replacement, local-state validation, and the existing default behavior.
4. Replace the OpenShell suite's test-only PVC projection bridge with the
   production provider-file and token-verifier path. Prove the disabled-identity
   boundary, relocated writable state, provider-file reads on Kubernetes, and
   endpoint-bound node-token substitution. Route the embedded Gateway through
   the returned OpenShell exposure, keep the Agent Service inactive, and limit
   its egress to the OpenShell Gateway peer. Extend the local first-Agent real
   test for `--harness codex`; retain separate containment and lifecycle checks
   where the OpenShell suite owns them.
5. Update the first-Agent guide, Harness and OpenShell references, OpenShell
   testing guide, environment-variable cheat sheet if `APP_TOKEN_SHA` is exposed
   as an operator-facing setting, and the existing
   [OpenShell provisioning flow](../../docs/flows/openshell-sandbox-provisioning.md).
   Remove only blockers this delivery actually proves.

## Verification

| Required outcome                      | Real check                                                                                          | Result or remaining proof                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Supported first-Agent caller          | Run `local-first-agent-real.test.mjs` and `first-agent.mjs --harness codex` with an authorized key. | Three manual first-Agent model turns passed in the disposable k3d/Compose environment. |
| Bearer passthrough and file delivery  | Run `sandbox-driver-openshell-k3d-real.test.mjs` with pinned images.                                | Case added; full protected suite remains pending.                                      |
| Credential and ownership boundary     | Inspect real Pod, provider, Secret, workspace, and log surfaces.                                    | Assertions added; protected cluster proof remains pending.                             |
| Optional workload identity            | Disable identity, then prove explicit unsupported projection fails before mutation.                 | Focused integration coverage passed; Pod-boundary proof remains.                       |
| Writable runtime state                | Verify runtime, persistent subpaths, and ephemeral-storage bounds on k3d.                           | Relocation and bounds implemented; protected filesystem proof remains.                 |
| Provider-managed files on Kubernetes  | Open both virtual files, reject writes, and delete their provider.                                  | Docker upstream coverage exists; Kubernetes proof remains.                             |
| Workspace-node enrollment             | Prove setup ordering, scoped enrollment, durable identity, and reconnect.                           | Focused ordering coverage passed; protected proxy proof remains.                       |
| Consequential refusal                 | Exercise unsupported Harness, plugin, verifier, ownership, file, and authorization cases.           | Passed: first-Agent 3/3, Sandbox 28/28, and focused Compute 1/1.                       |
| Protocol and ordinary-path regression | Run wire, runtime, Compute, lint, type, workspace, docs, and integration checks.                    | Passed: wire 9/9, runtime 143/143, launcher 23/23, and repository static checks.       |

The first-Agent and broader OpenShell cases prove different boundaries. Record
missing runtime prerequisites as proof gaps rather than substituting mocks.

## Delivery record

The branch implements the planned first-Agent, verifier-only transport,
provider-file, runtime-state, and workspace-node paths. Protected proof still
must cover the full pinned-image containment and lifecycle suite.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-02 13:23 EDT: Made workspace-node retries unbounded by retaining split
  setup after OpenShell removes its startup projection and scheduling each
  relaunch from process exit.
  (authoring-run/a0516064-6f8a-4e9f-8237-df9bedcec479 - 987c8c2b4ace1e152262ef6920b6d0f9ff26a086)
- 2026-10-02 13:35 EDT: Kept setup control on private WSS while routing the
  same-cluster OpenShell node to the Agent Gateway Service, with exact
  supervisor-to-Gateway NetworkPolicies, a Gateway-rollout readiness gate, and
  unchanged non-OpenShell behavior.
  (authoring-run/a0516064-6f8a-4e9f-8237-df9bedcec479 - 987c8c2b4ace1e152262ef6920b6d0f9ff26a086)
- 2026-10-02 12:56 EDT: Granted provider-fenced Harnesses only the exact
  workspace-node Gateway route and added the bounded development startup delay
  required until OpenShell exposes service readiness.
  (authoring-run/a0516064-6f8a-4e9f-8237-df9bedcec479 - 987c8c2b4ace1e152262ef6920b6d0f9ff26a086)
- 2026-10-02 12:43 EDT: Refined the direct workspace-node mount to use a
  process-owned `state` child after live OpenShell proof showed its user
  namespace rejects tightening the root-owned mount root.
  (authoring-run/a0516064-6f8a-4e9f-8237-df9bedcec479 - 987c8c2b4ace1e152262ef6920b6d0f9ff26a086)
- 2026-10-02 12:33 EDT: Pointed workspace-node state directly at its isolated
  PVC mount because OpenClaw rejects atomic replacement through a symlink.
  (authoring-run/a0516064-6f8a-4e9f-8237-df9bedcec479 - 987c8c2b4ace1e152262ef6920b6d0f9ff26a086)
- 2026-10-02 12:22 EDT: Required workspace-node setup material before
  provider-owned Harness provisioning; a first revision now starts a fail-closed
  Gateway and creates no OpenShell provider or Sandbox until setup exists.
  (authoring-run/a0516064-6f8a-4e9f-8237-df9bedcec479 - 987c8c2b4ace1e152262ef6920b6d0f9ff26a086)
- 2026-10-02: Required OpenShell-owned dedicated Codex to use the
  bearer-passthrough service exposure, preserved existing transport for all
  other topologies, and scoped the `openshell.localhost` address bridge to the
  owned k3d development profile.
- 2026-10-01 14:07: Captured optional workload identity, cross-cluster identity exchange, semantic writable runtime state, Kubernetes provider-file proof, and the selected split-envelope, endpoint-bound WebSocket substitution design. (authoring-run/e4bc9884-b517-4a72-8f04-264d4fa72f82 - 66922a5c23a44fabf23121968a8a63be20293380)
- 2026-10-01 12:01 EDT: Planned the plugin-free dedicated Codex first-Agent path against OpenShell `v0.1.3-pre.2`, including bearer passthrough, verifier-only app-server authentication, provider-managed runtime files, and real caller proof. (`f22a584e6ce21d505b40a72fdb5ae1c6e74c1c84`)
- 2026-10-01 12:31 EDT: Implemented the supported caller and Driver paths, including exact CredentialSource IAM, revision-owned runtime providers, projected Codex files, verifier-only app-server startup, one-shot node enrollment, cleanup, refusal coverage, and protected real-runtime cases. (`66922a5c23a4`)
