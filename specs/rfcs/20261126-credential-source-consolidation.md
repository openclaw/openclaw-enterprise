---
status: Proposed
implementation_status: Not implemented
author: stevenlee-oai
---

# Use Credential Sources instead of Namespace Secrets

**RFC-20261126-credential-source-consolidation** · Created 2026-11-26 · Depends on [Gateway startup credentials](20261125-gateway-startup-credentials.md).

## Decision

OCC currently exposes Secret Driver storage as a top-level Namespace Secret resource alongside Credential Sources. Operators must choose between two ways to create, authorize, bind, and retire credentials. Direct Secret bindings also require consumers to implement a separate path outside the TokenService Source lifecycle.

Move Secret Driver out of the top-level credential resource model:

- **Operators manage Credential Sources** for credentials selected by Agents or authorized service operations.
- **Administrators manage Credential Clients** for OAuth client secrets and GitHub App signing keys used to issue or renew Source credentials.
- **OCC TokenService uses Secret Driver privately** to store Source and Client material. Secret Driver remains an Installation-selected Driver, but no longer exposes a separate user-managed Secret resource. Other TokenService implementations own their storage.

**Breaking change:** After consumers switch, discard pre-1.0 Namespace Secrets and their values. Users must recreate credentials as Sources and update their bindings. No automatic import or compatibility path is planned.

**Tradeoff:** Gateway startup delivery creates a usable copy. Workload managers in the Gateway namespace can mount it. Embedded OpenClaw is for testing because Gateway and Harness share one Pod and its usable credentials. Use dedicated execution when Harness credentials require Credential Proxy isolation. Managed redeploy picks up Source changes. Revocation blocks later managed starts, and Stop removes the running workload and its copy.

## Public resources and private storage

- **Public Namespace Secret, removed:** A top-level OCC resource with its own ID, IAM, and CRUD API. Reads return metadata only.
- **Private Secret, retained:** Storage used by OCC TokenService through `SecretDriver.privateSecrets`. Users manage its Source or Client, not a separate Secret resource.
- **Delivery copies, retained:** Compute owns workload copies; Credential Proxy owns its delivery copies. An OpenShell-owned Source can use its authoritative Provider directly instead of a copy.
- **Platform secrets, retained:** Operators provision database, OCC signing, and TLS credentials separately. Kubernetes Deployments keep references to those Secrets across Pod restarts.

Public and private Secrets can both use Kubernetes Secrets as their physical storage. Delivery copies may be shared or remain until cleanup succeeds.

## Consumers and recipients

| Current use                                                             | Replacement                                                                           | Recipient                                                |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Slack bot/app, signing, user, relay credentials; other Gateway bindings | Explicit ready static Source in `Configuration.secretBindings`                        | Gateway                                                  |
| Slack preflight, directory, saved-ID hydration, Plugin approver lookup  | Authorized Source selected for the Channel operation                                  | OCC / Channel Driver                                     |
| Model authentication and guided provisioning                            | One model Source binding across supported providers and modes                         | Credential Proxy for dedicated; Gateway Pod for embedded |
| Upstream channel proxy Basic authorization value                        | Static Source selected by `networkProxy`                                              | Envoy's proxy credential slot                            |
| Legacy Secret-backed issuer inputs                                      | Complete [approved legacy Sender retirement](20261124-credential-design-1-0/index.md) | Retired                                                  |

Dedicated OpenAI credentials and Codex PATs already support Sources. Embedded OpenClaw uses the same Source selection and exact authorization, with direct delivery to its Gateway Pod. Preserve its supported model providers, authentication, endpoints, and transports. Existing Plugin OAuth and repository delivery already use Sources.

Keep dedicated Kubernetes Codex without an OpenShell Sandbox. Its current
model credential uses the Namespace Secret API. Qualify its replacement before
removing that API.

## Authorization and delivery

For every selection, OCC checks the caller's exact `credential_source:operate` and target-operation permissions. Require Source and target to share a Namespace; check Source readiness, type, owner instance, and recipient. Deployment also requires the Agent's delegated Source grant. During deployment, Worker rechecks its work claim, both principals' grants, and owner identity across asynchronous resolution. Configuration and revisions persist references, never credential values.

### Gateway example

1. Alice binds a ready static Source to a Gateway environment variable. Explicit reuse is allowed; no Gateway-specific Source profile or field allowlist is required.
2. Compute asks Worker to resolve the bound values. Worker authorizes and reads them through the selected TokenService, then returns them to Compute in memory.
3. Kubernetes Compute stages one Secret per Agent revision. Before every managed start or retry, Compute calls Worker's authorization callback, including when reusing a staged copy. Only the Gateway container references the Secret and receives its values. The dedicated Harness receives no Gateway credential or Kubernetes Secret-read permission.
4. A replacement Pod for the same revision reuses the Secret. On Stop, retirement, or candidate abandonment, Compute waits for that revision's Gateway Pods to stop, then deletes the copy.

### Other consumers

- **Slack validation:** Channel Driver uses authorized values transiently. Bot validation calls Slack `auth.test`; directory requests use the bot token. App-token validation checks its role locally without opening a socket. Preserve named accounts and HTTP mode.
- **Dedicated models:** Credential Proxy enforces the admitted destination and credential presentation. The OpenShell Harness uses a placeholder.
- **Upstream proxy:** Compute calls Worker's authorization and resolution callbacks and supplies the Basic authorization value to Envoy's credential slot. Workload managers in the OCC release namespace can mount the staged Secret. Managed redeploy picks up changes. Withdrawal fences delivery and reuse for affected revisions. It stays pending until Stop or retirement drains the route, clears the slot, and confirms removal from Envoy. Gateway and Harness receive no copy.

### Embedded OpenClaw delivery

Worker resolves the Sources required by the admitted embedded revision through
their selected TokenService. Kubernetes Compute stages the usable values in the
revision's Gateway Secret and starts OpenClaw with its existing credential
inputs. Deployment admission checks exact Source access and accepts only ready
static Sources for direct embedded model and Gateway bindings. OAuth and
GitHub App Sources cannot be delivered by this path. Gateway bindings serve
existing environment inputs. Native Git and managed Plugin injection continue
to use their existing runtime delivery. OpenClaw calls its configured model
endpoint directly. Gateway and Harness share the Pod, so use this mode for
testing.

Compute uses the same authorization, reuse, and cleanup checks as Gateway
startup delivery. TokenService keeps custody of the Source. A new managed
revision resolves the current value. A running Pod and any replacement Pod for
the same revision use its staged copy. Source withdrawal blocks a managed
start with that Source. Stop or retirement removes the Pod and its copy
before Worker records revocation.

### Dedicated Kubernetes Codex without OpenShell

- **OpenShell:** The Harness sends the placeholder to the provider's address.
  OpenShell applies the Sandbox policy and substitutes the real credential on
  approved requests.
- **Standalone Kubernetes:** Codex calls the Credential Proxy's private HTTPS
  endpoint with a short-lived Kubernetes workload token bound to its Pod and
  scoped to the Proxy. Any process in that Pod can use the approved routes. The
  Proxy matches the token's verified Pod identity and the connection peer to
  the live Compute-owned Pod. It checks the Agent revision and route before it
  resolves the Source through TokenService and adds upstream auth.
  Compute owns the Codex Deployment and prepared Git delivery.

Add a Pod-backed variant to `CredentialDeploymentTarget`. The Namespace,
Agent, and revision identify the deployment. Compute identifies its live
Harness Pod by UID. The OpenShell variant identifies its Sandbox by `sandboxId`.
Admission pins the Proxy registration, model Source, and approved routes.
The Proxy prepares the endpoint and trust information before Compute starts
Codex. It accepts the startup probe while Worker holds the preparing revision's
claim and serves requests from the active revision. Withdrawal, abandonment,
and retirement close the target to new requests. Stop and retirement drain
existing requests before removing the target.

Preserve both no-Sandbox model profiles. The API-key profile can use Codex's
provider auth command to present the Pod token. The existing imported
`codex_pat` profile reads an exact Namespace Secret and runs
`codex login --with-access-token`. Its replacement uses a PAT Source and must
preserve native account verification, model discovery, startup probe, and
app-server inference. OCC-issued ServiceAccounts already use a separate issued
Source binding.

## Interface changes

### APIs

- Channel directory: `secretId` → `sourceId`; Namespace scope remains server-owned.
- Upstream proxy: `networkProxy.credentialSecretId` → `credentialSourceId`.
- Switch schemas, handlers, permission advice, Console callers, and generated API together.
- Migrated bindings use Credential Source IDs (`cs_`). Device authorization keeps its existing session IDs and generates them independently of Namespace Secret resources.
- At the removal gate, delete Secret Harness auth, Secret Configuration bindings, legacy issuer `secrets` inputs, the five Secret CRUD operations, and Secret permission endpoints.

### IAM

Use Source IAM and existing target permissions. Remove the public Secret IAM catalog and bindings after consumer replacement.

### Database entities

1. Replace Secret references in Preset, provisioning, deployment, repair, deletion, and Namespace teardown code. Existing configurations require new Source bindings; do not convert stored Secrets, grants, revisions, or queued work.
2. Discard only the old public material through each record's original owning Driver, using exact backend identity and ownership checks. Keep the record and Driver methods, and block schema removal, until deletion is confirmed. Retry failed or uncertain cleanup.
3. Remove dependent foreign keys, Secret columns, `credential_source_secrets`, `occ.secrets`, and obsolete validators. Preserve Source deletion and withdrawal protections and all Source, Client, platform, and delivery material outside the approved discard.

### Driver contracts

- **Channel:** Change `ChannelCredentialReader` from a Secret Driver callback to transient TokenService Source use. Recheck target, Source, and owner around provider I/O, outside the write transaction.
- **Compute:** Use Gateway startup delivery for admitted embedded credentials. Keep the credential input expected by the embedded runtime. For the upstream proxy, pin the Source ID and TokenService instance in the revision. Worker supplies `authorize(signal): Promise<void>` and `resolve(signal): Promise<{ value: string; version: string }>` in Compute's revision context. Compute authorizes before reuse and resolves only for Envoy. Remove `secretEnvironment` after its callers have replacements.
- **Secret:** Retain `SecretDriver.privateSecrets`. After public material is discarded and private storage and cleanup are qualified, remove the Namespace Secret methods.

## Delivery order

See the [implementation plan](../plans/20261126-credential-source-consolidation.md).

1. Complete Gateway Source delivery while preserving the current Slack Namespace Secret path.
2. Switch Slack validation, bindings, directory APIs, Console callers, and generated contracts together. Qualify actual Gateway Slack startup before claiming support.
3. Complete remaining model and upstream proxy replacements, then remove public Secrets after no supported runtime caller depends on them.

## Open decisions

- **Dedicated Codex without OpenShell:** Verify the API-key and imported PAT
  profiles with the shipped Codex binary. Exercise the startup probe and
  app-server turn, HTTP streaming and supported upstream WebSockets, active
  revision replacement, and Source withdrawal. The API-key loopback probe
  does not establish PAT delivery or Kubernetes workload authorization.
- **OpenShell:** Can Gateway export an OpenShell-owned Source? Decide operator certificate custody, authority, and Provider identity handling, then qualify the path. Do not enable export or silently fall back before that decision.

## Simplifications

Hiding the Secret page while retaining its API would still leave duplicate credential IAM, bindings, and lifecycle code.

## Acceptance Criteria

- **Authorization:** Admission denial creates no revision or unauthorized provider request. A later Worker denial discards resolved values, stops delivery, and cleans an abandoned revision copy.
- **Standalone Pod identity:** Replay a valid token from a different Pod with the same ServiceAccount. The Proxy refuses it before resolving the Source or forwarding a request.
- **Real callers:** Register regular Agent workflow integration for PostgreSQL Worker/Compute, Gateway Slack startup, model Proxy admission, authenticated channel egress, repair, and Namespace teardown.
- **Embedded model:** On Kubernetes, run an embedded OpenClaw turn using a directly delivered Source. Verify the runtime receives the expected credential input and uses its configured endpoint. Verify a managed redeploy picks up a replacement, Stop clears the old copy, and another Agent can still use the Source.
- **Lifecycle:** Verify redeploy, revocation, Stop, retirement, abandonment, and Pod-before-Secret cleanup. Distinguish fixtures or process-environment proof from native provider use; live Slack messages require separate authorization.
- **Removal:** The Console Credentials tab has one inventory and one create action for Credential Sources. Verify no supported caller or new work uses public Secret CRUD, references, IAM, or persistence. A backend identity mismatch prevents deletion. Uncertain cleanup retains the record and blocks schema removal. Private Source and Client custody and Compute copies remain intact.
