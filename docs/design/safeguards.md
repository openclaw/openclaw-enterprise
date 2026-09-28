# Secrets, failure behavior, and platform invariants

This page owns the secrets, failure behavior, and platform invariants portion of the authoritative
[platform target design](../design.md). Read it with the other design chapters;
the [current architecture](../ARCHITECTURE.md) describes implementation status.

## Secret access

The approved [SecretDriver storage and delivery](../../specs/.archive/14-secret-driver.md)
contract uses Installation-selected `KubernetesSecretDriver` by default. Each
Secret belongs to one Namespace, can be created before any Agent exists, and
uses a Namespace-unique name. Same-Namespace Agents may consume it only through
explicit Agent harness-auth or Configuration bindings and assignment checks; cross-Namespace
references are unsupported. Namespace membership, Configuration access, Agent
access, or possession of a reference does not grant consumption. OCC stores
immutable Namespace/backend metadata without `agentId`, and the driver stores
mutable secret material independently of gateway creation. Protected storage
writes may contain plaintext; ordinary responses, OCC persistence, revisions,
ConfigMaps, and audit records contain references only.

Default delivery is explicit Kubernetes `secretKeyRef` environment injection
into the selected consumer for an admitted revision. Configuration bindings
serve the gateway; Agent `harnessAuth` serves only the model-executing Harness.
Native OpenClaw SecretRefs resolve the embedded environment. The dedicated
[model-credential boundary](workloads.md#openclaw-gateways) keeps keys out of its gateway. Updating a Secret keeps its
reference stable and does not restart a workload; the operator redeploys or
restarts each consumer that should observe the latest value. Old revisions
retain references, not historical values. Admission checks current authorization;
Kubernetes process restarts do not reauthorize delivered env values. Immediate
loss of access requires stopping the workload or revoking the upstream credential.

Source identity and delivery mode are separate. The optional
`credential_gateway` capability keeps a model credential outside the Harness: a
Namespace-scoped `CredentialSource` registers an OCC Secret with the selected
`CredentialGatewayDriver`, and its paired Sandbox applies the credential to
outbound requests while the workload holds only a placeholder. OCC reads the
Secret once, at registration, and never stores the value. The current
implementation is OpenShell provider substitution for dedicated Codex with an
OpenAI API key; while a Credential Gateway is selected, Secret-backed model
delivery is rejected rather than used as a fallback. The guarantee relies on
the gateway's own membership controls and on enforced Sandbox NetworkPolicy.
Update, rotation, per-Agent withdrawal, and other source types are deferred.
Environment-delivery guarantees do not describe this path. The project-root `ref/design.md` remains
the external broker-target owner handoff outside this implementation worktree.

Production execution retains scoped direct-credential delivery, because the
Credential Gateway path is limited to the unsupported OpenShell Sandbox. The Agent's `harnessAuth`
API-key binding references an OCC Secret in its exact Namespace. The Secret
Driver owns storage; Kubernetes projects the source only into dedicated Codex
or the combined embedded OpenClaw gateway/Harness. Each consumer requires its
own admission and dispatch authorization; the dedicated gateway gets no key.

For a provider-managed account, API-side Kubernetes Compute stores the issued
access token and pinned provider workspace in one account-owned Secret in the
exact backing namespace. The revision snapshots only the OCC account identity,
exact credential reference, and verified private Backend/workspace ownership. Kubernetes projects
that account Secret directly into each associated dedicated Codex workload;
there is no Agent-specific credential copy. Codex logs in with its access token
under the forced provider workspace. Its separate gateway never receives the
token, workspace, or provider admin credential; embedded access-token execution
is unsupported. The API alone receives tenant-local direct Secret permissions;
the worker and workloads receive no Secret API permissions. However, a trusted
worker with Deployment write access can indirectly project tenant Secrets, so
its effective trust boundary remains the backing namespace. Provider credentials
never enter OCC resources, snapshots, routes, or audit records.

These existing Kubernetes delivery paths do not establish delivery across
runtime targets. In the target design, the selected `SecretDriver` materializes
approved Secrets for each exact consumer without shared Kubernetes Secret
references. Logical Secret ownership remains the Agent's Namespace; existing
bindings and consumption checks still apply.

A trusted dedicated gateway may receive its existing Agent-scoped gateway and
Channel credentials and Secrets explicitly bound by its approved Configuration.
Its [identity boundary](access.md#runtime-trust-across-targets) excludes dedicated
Harness identity and model credentials as well as broad controller credentials.
Direct model-credential delivery to the tenant data-plane Harness is a temporary
implementation exception. Target model-credential mediation keeps real upstream
credentials outside Harness execution; the Harness receives only scoped substitutes.
Workload-write authority must be bounded in each target, since it can indirectly
expose Secrets there. Cross-target materialization remains a prerequisite for
dedicated gateway relocation; the concrete delivery mechanism is deferred.

## Failure behavior

OpenClaw fails closed when any required boundary or dependency fails:

- Identity verification, trusted ingress, or exact-scope admission.
- Resource authorization, platform Restrictions, active workload identity, or
  current permissions.
- Resource scope, Namespace isolation, selected SecretDriver storage, or future
  broker-mediated secret access.
- Selected sandbox support or verified policy enforcement.
- Exact Agent-owned gateway readiness or candidate route activation.
- Selected runtime-target availability, workload provisioning, or verified
  gateway/Harness peer identity and connectivity.

The selected `IAMDriver` evaluates each exact request before a side effect.
`ComputeDriver` ensures Namespace infrastructure only after its independently
authorized Namespace lifecycle operation. Authorization, reference validation,
backing Namespace readiness, selected inference target, and sandbox policy
support complete before OCC creates a revision. The Agent-owned gateway is
configured and becomes ready during that exact revision's preparation in its
selected target, independently of the candidate Harness's placement. A
denied request may invoke its authoritative `IAMDriver` but cannot create a
gateway, workload, resource, inference request, or messaging side effect.

If candidate provisioning, containment enforcement, or nonserving route
preparation fails, the candidate remains inactive and the previous active
revision, Agent workload, and route remain unchanged. Once cutover begins,
OCC disables the previous route before activating its replacement. A failure
during or after cutover retains the previous workload but leaves routing
disabled until the new route succeeds or the previous revision and route can be
independently verified and restored.

Rollback and cleanup cover both selected runtime targets and preserve exact
ownership; a failed or unreachable target cannot be treated as successful
recovery or deletion. OCC never substitutes another runtime target, Namespace,
identity, `IAMDriver`, `CredentialGatewayDriver`, `SecretDriver`, gateway,
provider, or runtime implementation.

## Audit

OAG records identity-verification and admission decisions, their requested
scope, and safe denial reasons. OCC records the acting identity, requested
action, exact resource, scope, selected `IAMDriver`, applicable Restrictions,
their enforcement outcome, and the result for platform operations. Exported
audit events retain the stable Installation identifier at their top level so
evidence remains attributable outside the singleton platform; nested resource
references retain only their exact resource and applicable Namespace. Deployment
audit identifies the candidate and previous active revisions, selected
service-account, compute, sandbox, inference, channel, and secret Drivers,
Agent-owned gateway and workload operations with nonsecret runtime-target
observations, the selected approved model target, readiness decisions, route
changes, and any rollback outcome. Audit
records contain no credentials, secret values, prompts, provider message
contents, or runtime message contents.

## Platform invariants

The platform preserves:

- **Singleton Installation:** each deployment owns exactly one persistent,
  server-selected Installation. Its stable identifier crosses configuration,
  admission, exported-audit, and external deployment boundaries; ordinary
  resources and internal operations inherit it from the selected platform.
- **Explicit scope:** each resource belongs to the Installation or exactly one
  Namespace. The Namespace is the tenant boundary; Namespace-scoped references
  cannot cross it.
- **Agent-owned, Namespace-scoped runtime routing:** OCC manages exactly one
  OpenClaw gateway for each deployed Agent; a Namespace may contain multiple
  gateways. The selected `ComputeDriver` preserves exact ownership across the
  [topology's runtime targets](workloads.md#openclaw-gateways). Routing binds
  Namespace, Agent, and the sole active revision; gateway ownership remains
  stable across that Agent's revisions.
- **Independent authorization:** an external identity provider authenticates;
  OAG verifies identity and scope; OCC authorizes exact platform operations.
  Kubernetes and external providers retain their own authority.
- **Single-writer ownership:** OCC owns platform resources, desired state,
  native platform policy, and revisions. External systems retain their own
  policy. Selected Drivers evaluate authority or report external and
  infrastructure state without rewriting platform resources or granting
  themselves permissions.
- **Provider-neutral service accounts:** OCC owns each exact Namespace-scoped
  account and generic credential reference. Its selected service-account Driver
  privately owns the exact Backend, Driver, upstream account, credential, and workspace binding;
  upstream authority never replaces exact OCC authorization.
- **Immutable deployment:** an `AgentRevision` captures the exact admitted
  Agent configuration, dependencies, sandbox policy, selected Harness identity
  and version, explicit execution mode, nullable Backend reference, and runtime
  integrations. Editing an
  Agent or changing runtime integrations affects only a later deployment.
- **Stable workload identity:** each Agent has one OCC-owned runtime identity.
  At most one revision is active, and only the exact Agent workload bound to
  that revision executes, receives traffic, or acts. It cannot inherit the
  initiating user's credentials or permissions.
- **Platform-wide Restrictions:** each applicable guardrail narrows native and
  external authority and is enforced by each relevant selected Driver.
- **Enforced containment:** a candidate cannot run its Harness or receive
  traffic before its selected sandbox driver proves enforcement of the entire
  admitted policy.
- **Namespace-owned secrets:** the selected `SecretDriver` stores material without
  requiring an Agent or gateway. Explicit Configuration bindings serve gateways;
  Agent `harnessAuth` serves the selected model-executing Harness. Each consumer
  requires independent exact authorization. Cross-Namespace sharing, historical
  value snapshots, and automatic rotation are unsupported. Dedicated Codex may
  instead receive its bound account's directly projected token and forced
  workspace; its separate gateway receives neither model credential.
- **Selected model inference:** one Installation-selected `InferenceDriver`
  invokes only the exact approved external-provider or local model target. A
  denied or unavailable target never falls back to another model or source.
- **Server-owned integration selection:** installation configuration selects
  exactly one Driver implementation for each required role. A client, external
  system, or Driver cannot select or authorize itself.
- **Fail-closed operations:** unavailable authorization, invalid references,
  stale state, gateway unavailability, integration failure, or provisioning
  failure blocks the operation. OCC never substitutes an unauthorized
  fallback.
- **Auditable changes:** mutations produce attributable audit evidence without
  recording credentials, secret values, provider message contents, or runtime
  message contents.
