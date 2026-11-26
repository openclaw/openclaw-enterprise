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

**Tradeoff:** Gateway startup delivery creates a usable copy outside Credential Proxy restrictions. Gateway Pod namespace workload managers can mount that copy, and rotation takes effect on managed redeploy. Revocation blocks later managed starts but does not erase a running Gateway's environment.

## Public resources and private storage

- **Public Namespace Secret, removed:** A top-level OCC resource with its own ID, IAM, and CRUD API. Reads return metadata only.
- **Private Secret, retained:** Storage used by OCC TokenService through `SecretDriver.privateSecrets`. Users manage its Source or Client, not a separate Secret resource.
- **Delivery copies, retained:** Compute owns workload copies; Credential Proxy owns its delivery copies. An OpenShell-owned Source can use its authoritative Provider directly instead of a copy.
- **Platform secrets, retained:** Operators provision database, OCC signing, and TLS credentials separately. Kubernetes Deployments keep references to those Secrets across Pod restarts.

Public and private Secrets can both use Kubernetes Secrets as their physical storage. Delivery copies may be shared or remain until cleanup succeeds.

## Consumers and recipients

| Current use                                                             | Replacement                                                                           | Recipient                                    |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------- |
| Slack bot/app, signing, user, relay credentials; other Gateway bindings | Explicit ready static Source in `Configuration.secretBindings`                        | Dedicated Gateway                            |
| Slack preflight, directory, saved-ID hydration, Plugin approver lookup  | Authorized Source selected for the Channel operation                                  | OCC / Channel Driver                         |
| Model authentication and guided provisioning                            | One model Source binding across supported providers and modes                         | Credential Proxy; Harness uses a placeholder |
| Upstream channel proxy Basic authorization value                        | Static Source selected by `networkProxy`                                              | Envoy's proxy credential slot                |
| Legacy Secret-backed issuer inputs                                      | Complete [approved legacy Sender retirement](20261124-credential-design-1-0/index.md) | Retired                                      |

Dedicated OpenAI credentials and Codex PATs already support Sources. Keep embedded OpenClaw and Anthropic on the same Source selection, exact authorization, and request-time Proxy path. Model and Proxy admission own provider-specific destinations and headers. Existing Plugin OAuth and repository delivery already use Sources.

## Authorization and delivery

For every selection, OCC checks the caller's exact `credential_source:operate` and target-operation permissions. Require Source and target to share a Namespace; check Source readiness, type, owner instance, and recipient. Deployment also requires the Agent's delegated Source grant. During deployment, Worker rechecks its work claim, both principals' grants, and owner identity across asynchronous resolution. Configuration and revisions persist references, never credential values.

### Gateway example

1. Alice binds a ready static Source to a Gateway environment variable. Explicit reuse is allowed; no Gateway-specific Source profile or field allowlist is required.
2. Compute asks Worker to resolve the bound values. Worker authorizes and reads them through the selected TokenService, then returns them to Compute in memory.
3. Kubernetes Compute stages one Secret per Agent revision. Before every managed start or retry, Compute calls Worker's authorization callback, including when reusing a staged copy. Only the Gateway container references the Secret and receives its values. The dedicated Harness receives no Gateway credential or Kubernetes Secret-read permission.
4. A replacement Pod for the same revision reuses the Secret. On Stop, retirement, or candidate abandonment, Compute waits for that revision's Gateway Pods to stop, then deletes the copy. Embedded Source export remains unsupported.

### Other consumers

- **Slack validation:** Channel Driver uses authorized values transiently. Bot validation calls Slack `auth.test`; directory requests use the bot token. App-token validation checks its role locally without opening a socket. Preserve named accounts and HTTP mode.
- **Models:** Credential Proxy enforces the admitted destination and credential presentation. Gateway export must not deliver model credentials to Harness.
- **Upstream proxy:** Compute calls Worker's authorization and resolution callbacks and supplies the Basic authorization value to Envoy's credential slot. Workload managers in the OCC release namespace can mount the staged Secret. Managed redeploy picks up changes. Withdrawal fences delivery and reuse for affected revisions. It stays pending until Stop or retirement drains the route, clears the slot, and confirms removal from Envoy. Gateway and Harness receive no copy.

### Embedded model delivery

Extend the Credential Proxy deployment target to identify a Compute-owned
embedded workload alongside the existing staged Sandbox. Kubernetes Compute
starts the embedded OpenClaw Pod with a placeholder and a model Proxy URL.
Before startup, Compute checks that the Proxy has the admitted binding and the
Pod's network policy prevents direct provider access. The Agent revision pins
the Source owner, selected Drivers, and admitted request profile.
Any process in that exact Pod can call the admitted route. The dedicated Sandbox
can also enforce an executable restriction.

Check a Pod-bound identity for the Proxy's audience against the registered Pod
UID. Control Plane ownership determines which Pod Compute can register. Permit
the model startup probe under the candidate's current work claim. After
activation, bind requests to the serving revision and fence its predecessor.

Credential Proxy authenticates the exact workload, matches the method and path,
and verifies upstream TLS. It replaces caller credential headers on a matching
request and refuses redirects and arbitrary forwarding. The built-in Anthropic
API-key profile uses `POST https://api.anthropic.com/v1/messages` and `x-api-key`.
Keep the existing Anthropic Messages version header and streaming behavior.
For a built-in OpenAI API key, the revision pins one HTTPS route on
`api.openai.com:443`. Responses uses `POST /v1/responses` and Chat Completions
uses `POST /v1/chat/completions`. Credential Proxy sends the Source value in
the `Authorization` header as a Bearer token and relays HTTP streaming.

Use the existing versioned Source delivery flow. Withdrawal disables the
Agent revision's Proxy binding and removes its serving copy. Preserve the Source
and other Agents' bindings. Require Stop before replacement when the selected
Compute and Proxy cannot fence both revisions independently.

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
- **Compute:** Keep Gateway startup delivery. For the upstream proxy, pin the Source ID and TokenService instance in the revision. Worker supplies `authorize(signal): Promise<void>` and `resolve(signal): Promise<{ value: string; version: string }>` in Compute's revision context. Compute authorizes before reuse and resolves only for Envoy. Remove `secretEnvironment` after its callers have replacements.
- **Credential Proxy:** Bind each embedded model route to the exact Compute-owned workload and admitted Source. Apply the same readiness, version, and cleanup checks used for staged Sandbox targets.
- **Secret:** Retain `SecretDriver.privateSecrets`. After public material is discarded and private storage and cleanup are qualified, remove the Namespace Secret methods.

## Delivery order

See the [implementation plan](../plans/20261126-credential-source-consolidation.md).

1. Complete Gateway Source delivery while preserving the current Slack Namespace Secret path.
2. Switch Slack validation, bindings, directory APIs, Console callers, and generated contracts together. Qualify actual Gateway Slack startup before claiming support.
3. Complete remaining model and upstream proxy replacements, then remove public Secrets after no supported runtime caller depends on them.

## Open decisions

- **Embedded model delivery:** Place the private Proxy with Worker or give it
  a separate service. Decide which setup-token and custom provider profiles
  must move before the direct path is retired. The pinned OpenClaw client
  treats a private URL as a generic provider. Decide whether the first cutover
  must also preserve native Responses WebSockets, continuation, and compaction.
- **OpenShell:** Can Gateway export an OpenShell-owned Source? Decide operator certificate custody, authority, and Provider identity handling, then qualify the path. Do not enable export or silently fall back before that decision.

## Simplifications

Hiding the Secret page while retaining its API would still leave duplicate credential IAM, bindings, and lifecycle code.

## Acceptance Criteria

- **Authorization:** Admission denial creates no revision or unauthorized provider request. A later Worker denial discards resolved values, stops delivery, and cleans an abandoned revision copy.
- **Real callers:** Register regular Agent workflow integration for PostgreSQL Worker/Compute, Gateway Slack startup, model Proxy admission, authenticated channel egress, repair, and Namespace teardown.
- **Embedded model:** On enforcing Kubernetes, run a model turn through the embedded OpenClaw Pod and Proxy. Verify the matched upstream request receives the proper credential header. Verify the Pod has only its placeholder, unbound and unmatched requests send no credential, and direct provider egress fails. Exercise withdrawal while a second Agent keeps using the same Source.
- **Lifecycle:** Verify redeploy, revocation, Stop, retirement, abandonment, and Pod-before-Secret cleanup. Distinguish fixtures or process-environment proof from native provider use; live Slack messages require separate authorization.
- **Removal:** The Console Credentials tab has one inventory and one create action for Credential Sources. Verify no supported caller or new work uses public Secret CRUD, references, IAM, or persistence. A backend identity mismatch prevents deletion. Uncertain cleanup retains the record and blocks schema removal. Private Source and Client custody and Compute copies remain intact.
