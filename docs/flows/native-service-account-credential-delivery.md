---
created: 2026-08-24
updated: 2026-10-16
last_updated_session: authoring-run/3cfe533a-7ff7-4f25-ba91-7a0fc8bc35b6
---

# Harness Authentication Binding Flow

## Overview

Select an OCC Secret or ChatGPT account credential through Agent `harnessAuth`.
Deployment freezes the authorized binding; the worker rechecks it and Kubernetes
renders the credential only into the model-executing workload, which
authenticates before guarded activation. SSH `runtime` binds operator credentials and checks gateway readiness without model authentication.

Codex OAuth device login through an external credential source is **Experimental**;
see the [launch limits](../reference/drivers/kubernetes-compute/codex-oauth-storage.md#oauth-launch-limits).

## Entry Points

- Trigger: Agent create/PATCH with `harnessAuth`, followed by the bodyless
  exact-Agent deployment action.
- Sources: `packages/occ/src/index.ts:OpenClawController.createAgent`,
  `OpenClawController.updateAgent`, and `OpenClawController.deployAgent`.
- Assumptions: ready Namespace at deployment, same-Namespace source, existing
  Secret value or issued account credential, exact actor permissions, a compatible
  configured Harness/model, and selected Compute support.

## Flow

```mermaid
graph TD
  A["Store key or separately issue account credential"] --> B["Save Agent harnessAuth reference"]
  DA["Refresh Driver completes device login"] -.-> B
  G -->|external ChatGPT| OA["Sandbox supplies placeholder<br/>and account metadata"]
  OA --> J
  R["Operator provisions protected host env"] --> B
  D -->|runtime| S["SSH starts embedded gateway using host env"]
  S --> T["Check gateway readiness; model auth remains unverified"]
  B --> C["Authorize and freeze binding in Agent revision"]
  C --> D["Worker rechecks grants and source ownership"]
  D -->|denied or changed source| E["Reject candidate before projection"]
  D -->|valid managed source| F["Kubernetes prepares explicit login mode and projections"]
  F --> G{"Admitted topology"}
  G -->|embedded API key| H["Create or replace shared gateway with projected key"]
  G -->|dedicated key or account| I["Only Codex receives model credential"]
  I --> J{"Login and primary model turn succeed?"}
  J -->|first model subprocess timeout| P["Wait one second within startup budget"]
  P --> Q{"Second model probe succeeds?"}
  Q -->|yes| L
  Q -->|no| K["Candidate remains unready"]
  J -->|login or nonretryable failure| K
  J -->|yes| L["Runtime readiness and guarded activation"]
  H --> M{"Native primary model probe succeeds?"}
  M -->|no| N["Gateway stays unready; replacement may interrupt service"]
  M -->|yes| O["Gateway becomes ready; complete activation"]
```

## Execution Trace

### 1. Acquire or select one credential source

`packages/occ/src/index.ts:OpenClawController.startAgentDeviceAuthorization`,
`pollAgentDeviceAuthorization`, `cancelAgentDeviceAuthorization`

Device login creates a credential source and asks its Credential Refresh Driver
to start and poll authorization. The Secret-backed session records actor, exact Namespace
and optional Agent scope, source identity, and an opaque Refresh Driver handle.
The Refresh Driver hands the provider grant to the external service. Ready responses return a credential-source
reference; Console saves a `credential_source` binding and grants the Agent
principal exact source `operate`.

Secret compare-and-swap permits one in-flight poll and fences cancellation. An
uncertain exchange requires reconnect. Closing or expiring a session removes its
handle without revoking the source. Plugin discovery uses the Gateway's
`withSourceToken` callback with current source authorization; the service may
refresh before returning a usable access token. It continues through
the saved source after the login session closes.

Console calls
`apps/controller/src/drivers/compute/model-discovery.ts:discoverHarnessModels`
without storing credentials. OpenAI API-key discovery excludes models with a
valid `shutdown_date` today or earlier in UTC; other dates and the Anthropic and
service-account catalogs remain unfiltered. Discovery does not prove a model call.

`packages/occ/src/index.ts:OpenClawController.createAgent`, `updateAgent`,
`authorizeHarnessAuthSource`

Create and PATCH follow the [`harnessAuth` field semantics](../reference/agents.md#harness-authentication).
API keys and imported `codex_pat` tokens use stable OCC Secret references and
require exact Secret `operate`. Managed PATs use ServiceAccount references and
require exact account `read`. OAuth uses a CredentialSource reference owned by
the selected Credential Gateway and requires exact source `operate`.
Namespace locks serialize source reference changes against deletion. Missing or
foreign sources fail closed. Binding never selects a different model, Backend,
Harness, or execution mode and cannot issue an account credential.

The [Secret storage flow](secret-storage-and-delivery.md) owns value storage;
[account issuance](service-account-driver-credential-delivery.md) owns upstream
credentials and their private Backend binding.

### 2. Freeze the admitted source and compatibility

`packages/occ/src/index.ts:OpenClawController.deployAgent`, `admitHarnessAuth`

Deployment requires a nonnull binding, exact Agent `deploy`, and Configuration
`read`. For a key or service account token, OCC checks the actor's and Agent principal's exact Secret `operate`,
resolves the backend through the selected Secret Driver, and freezes the stable
reference and Driver identity. For a ChatGPT account, it verifies the issued
access-token reference and private Backend, member Driver, and workspace
ownership. `runtime` needs no source grant, lookup, or delivery metadata. The
selected Compute validates the combination: SSH accepts only embedded OpenClaw
with `runtime`. Kubernetes `validateHarnessAuth` requires dedicated Codex for
both imported and managed `codex_pat` sources. External ChatGPT sources require
dedicated Codex and the paired Sandbox and Credential Gateway. Deployment and
guided provisioning reject unsupported combinations before admitting work or
stopping predecessors.

Host credential changes can affect a runtime version after restart without
redeployment; see the
[SSH lifecycle](pr-24-ssh-compute.md).

The Agent revision contains references and safe internal metadata, never credential
bytes. Public serialization exposes the binding but omits backend locators and
private account ownership. A later account credential cannot replace
the admitted reference; draft changes affect only the next explicit deployment.

<span id="3-reauthorize-the-immutable-revision-before-effects" class="anchor-alias"></span>

### 3. Reauthorize the immutable Agent revision before effects

`apps/controller/src/worker.ts:ControllerWorker.resolveRevisionBackend`,
`resolveRevisionSecretContext`

The worker authorizes the original deploying actor and required Agent Secret
grants for the saved version, checks source ownership, and
matches managed-account credential and Backend metadata against the frozen
snapshot. Revocation or a changed source rejects work before provisioning.
For `runtime`, only Agent/Configuration authorization runs; the dispatch context
carries only the method, and SSH neither reads the operator credential file nor
issues a model probe.

For an API key or directly supplied service account token, the worker resolves
backend ownership from OCC state and passes an ephemeral `ComputeRevisionContext`
without reading credential bytes or rewriting the Agent revision. Compute then reads
the canonical CP source, verifies the admitted Secret UID or managed-account
ownership, and delivers only selected fields into the DP Secret for that Agent revision.
Missing or replaced sources fail preparation. Managed ChatGPT accounts retain the exact
token source; their private Backend binding owns workspace metadata.
Previous versions keep references without retaining their sources
indefinitely; drafts, selected versions, and pending deployments block source deletion.

### 4. Prepare and place the one credential projection

`apps/controller/src/drivers/compute/kubernetes/index.ts:prepareHarnessAuth`,
`KubernetesComputeDriver.prepareRevision`

One workload-rendering step converts validated references to supported
Secret projections and a closed login mode. Embedded OpenClaw receives the key
in its combined workload as `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`, derived
from the immutable native model Configuration; admission requires every model
selection, including fallbacks, to use the same supported provider. Dedicated
Codex receives the key or account token through a DP projection for the Agent revision.
Managed and directly supplied service account tokens deliver only
`CODEX_ACCESS_TOKEN` as the model credential; the separate Gateway receives none.
Neither gateway-only Configuration secret bindings nor initial runtime
provisioning, which creates only transport/channel groups, can supply model auth.

The selected Sandbox consumes these already-rendered
`HarnessWorkloadRequirements` and selects or looks up no other credential. An
upstream runtime unable to honor genuine Secret projection fails explicitly. Network policies keep the
provider-login egress the admitted auth method requires. Gateway transport
and Kubernetes workload identity credentials stay separate.

### 5. Authenticate during runtime startup

`apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts:AGENT_RUNTIME_ENTRYPOINT`,
`GATEWAY_RUNTIME_ENTRYPOINT`

Codex consumes explicit `CODEX_LOGIN_MODE`: API-key login receives the key through
stdin; managed and directly supplied service account tokens both use `codex_pat`
and `--with-access-token`. Native whoami validates and hydrates identity from the
token, without a runtime workspace override. Credential environment variables
are deleted before the probe and app-server start. Missing or conflicting
inputs, failed login, or a failed primary-model probe
(under the restricted [probe policy](../reference/harness-execution.md#harness-authentication))
prevent app-server startup and readiness. API-key and service-account login
state remains in the temporary home. Its volume has a `1Gi` size limit.
External-token startup writes
placeholder-only auth state instead of running native login (step 6).

The dedicated wrapper retains `APP_SERVER_TOKEN` for local plugin
authentication (with plugin status enabled, deriving it from the Agent revision
and startup identity) but omits it from the `codex login` and `codex app-server`
environments; the listener receives the current token's SHA-256
digest. The token remains in the Pod; filtering child environments does not
isolate same-UID processes.

`startAuthenticatedCodex` gives `probeCodexAuthentication` at most two
attempts within one monotonic 61-second budget. Only a subprocess `ETIMEDOUT`
schedules the second, after a one-second timer, timed out at the smaller of
30 seconds and the remaining budget; an unexplained `SIGKILL` is nonretryable.

Embedded OpenClaw consumes the selected provider's native API key and runs one native
primary-model probe during actual gateway startup, with tools and fallback
disabled; its 256-token output cap lets reasoning models answer within the
15-second timeout. Initial and replacement deployments use the same path; their `Recreate`
activation can stop the serving gateway before the new
process validates credentials, so a failure leaves the Agent unavailable until
repair and restart or a new deployment, with no automatic rollback.

Both runtimes capture native output and hold final failures unready with a fixed
message. Codex publishes the existing runtime failure only after retry exhaustion or a
nonretryable result. Readiness polling does not repeat
provider calls. A restart or deployment starts a new check with the same timeout. Probes may
incur usage charges.

After readiness, the [activation and recovery flow](harness-execution-topology.md#3-publish-safely-and-complete-activation-once)
completes activation.
Updating a Secret leaves existing process environments and DP runtime copies
unchanged until preparation: deploy each consumer, verify a real turn, then
revoke the previous key upstream. Version history cannot restore historical
Secret values.

### 6. Deliver externally managed OAuth authentication

`apps/controller/src/drivers/compute/kubernetes/index.ts:credentialSourceEnvironment`,
`apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts:AGENT_RUNTIME_ENTRYPOINT`

Compute checks that the returned attachments match the authorized sources exactly,
with no missing, duplicate, or unexpected source IDs, before provisioning the
Sandbox. It selects the attachment named by `harnessAuth.sourceId` for the Codex
placeholder and trusted account metadata, and passes every attachment to the
Sandbox. Attachment order does not select Harness authentication.

Compute sends the placeholder and account metadata only to the Harness. Its
launcher writes ephemeral `chatgptAuthTokens` auth state without a refresh token and runs the normal native
probe before app-server startup. The external service retains refresh ownership;
the paired Sandbox injects a warm access token into authorized outgoing requests.
There is no native-refresh or persistent-bundle fallback. Restarts reconstruct the
same receiving state from a current attachment; sessions and workspace keep their
independent persistence.

After withdrawal, OpenShell omits the credential binding when the same Sandbox
restarts. `OPENSHELL_CHATGPT_AUTH_BOOTSTRAP` lets that absence reach the Harness
launcher, which holds `AUTHENTICATION_FAILED` at the `login` phase through its
authenticated status endpoint. The process stays alive and unready; it does not
write auth state, start Codex, or use an earlier auth file. A present but malformed
binding still fails the bootstrap check. Recovery requires a new authorized
deployment, as described in the [withdrawal reference](../reference/credential-sources/withdrawal.md).

The [credential source lifecycle](credential-source-lifecycle.md) owns source
registration, authorization, withdrawal and deletion. The experimental
OpenShell source uses the paired Refresh Driver and upstream Gateway/Sandbox
integration described in the [Driver reference](../reference/drivers/openshell-credential-gateway.md#experimental-codex-oauth-poc).

## Debugging and Verification

- `node --test tests/conformance/plugin-compute.test.mjs` checks the filtered
  Codex child environments, startup-derived listener hash, and retained wrapper
  token. The runtime-image startup test checks the native Codex shell without a
  provider turn.
- [Container launcher tests](../testing/docker.md#verify-codex-startup-probe-recovery)
  run the generated launcher against a fixture CLI, proving recovery control
  flow, not provider acceptance. Inspect allowlisted `codex.model_probe` logs
  (no raw output) for attempt and final-code evidence.

- `node --test tests/integration/harness-topology-k3d-real.test.mjs` with
  `OCC_TEST_HARNESS_K3D_REAL=1` exercises the API binding/deploy path with
  disposable Kubernetes/PostgreSQL, genuine images, and an authorized API key,
  requiring a provider-backed turn from both dedicated Codex and embedded OpenClaw.
- [Managed-account testing](../testing/slack.md#chatgpt-service-accounts) separately requires
  provider authorization, an issued ChatGPT credential, and a real Codex turn;
  API fixtures prove only admission or persistence.
- Verify Secret projections only on intended consumers, source-deletion guards,
  immutable Agent revision metadata, dispatch denial after revoked grants, and failed
  auth preventing readiness. Use synthetic sentinels for serialized resources,
  logs, and audit disclosure checks; never print live credentials.
- [OpenShell testing](../testing/openshell.md) distinguishes explicit unsupported
  projection failure from genuine Secret delivery and model execution. A test-only
  bridge cannot establish production Sandbox support.

## Related docs

- [Agent harness authentication](../reference/agents.md#harness-authentication)
- [Credential renewal and revocation](../guides/deploy/credential-lifecycle.md)
- [Service Account Driver credential delivery flow](service-account-driver-credential-delivery.md)
- [Secret storage and gateway delivery flow](secret-storage-and-delivery.md)
- [Harness execution topology flow](harness-execution-topology.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-16 01:36: Keep external OAuth custody while integrating current Sandbox policy. (authoring-run/3cfe533a-7ff7-4f25-ba91-7a0fc8bc35b6 - 5af46154157b7da222e2dd9839fd1bcb741c3056)

- 2026-10-14 21:28: Hold missing externally managed Codex authentication after a Sandbox restart in the accompanying fix. (authoring-run/62007ef0-44a1-467c-b24d-a61d42878897 - d4f744719e6e0b3bcb25f33bc13acf4aa81088ad)

- 2026-10-13 09:37: Reconcile current admission and lifecycle behavior with external OAuth custody in the accompanying merge. (authoring-run/fd902939-ed58-4508-8d33-95a863d966af - e8d39978d801e7a5a8ac7242f32035f426da94e1)

- 2026-10-12 11:55: Retire owned Deployment writers before Jobs and persist bounded failure evidence before resumable cleanup. (authoring-run/adccd418-cf61-4fbb-b3ba-0fcad194d907 - 040e7498ecd89e0e565af71f234776ecfaad2186)

[Harness Authentication Binding documentation history](native-service-account-credential-delivery/history.md) preserves the older dated entries.
