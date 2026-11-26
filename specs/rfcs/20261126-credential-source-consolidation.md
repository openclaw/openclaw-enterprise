---
status: Proposed
implementation_status: Not implemented
author: stevenlee-oai
---

# Use Credential Sources instead of Namespace Secrets

**RFC-20261126-credential-source-consolidation** · Created 2026-11-26 · Depends on [Gateway startup credentials](20261125-gateway-startup-credentials.md).

## Decision

Use TokenService Credential Sources as the single credential resource that an operator can bind to an Agent or select for an authorized service operation. Replace the remaining public Namespace Secret consumers, then remove the Namespace Secret API and Console page. Credential Clients remain a separate public resource for administrator-managed OAuth client secrets and GitHub App signing keys, which TokenService uses to issue or renew Source credentials.

This removes a duplicate credential management model. It does not remove the Secret Driver, private credential storage, Compute's delivery copies, or operator-managed platform secrets.

**Breaking change:** The pre-1.0 cutover discards old user-facing Namespace Secrets and their stored values. Users must recreate needed credentials as Sources and update their bindings. There is no automatic import or compatibility path.

**Tradeoff:** An explicit Gateway binding creates a usable copy outside Credential Proxy's request restrictions. Gateway namespace workload managers can mount it elsewhere, and the Gateway keeps its startup value until managed redeploy. Revocation blocks subsequent managed starts; it does not erase an existing environment. An upstream proxy needs its own delivery and withdrawal decision.

## What each component owns

| Component         | Responsibility                                                                                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credential Source | The credential and its lifecycle, owned by the selected TokenService instance. OCC stores metadata and bindings, and authorizes exact Source operations.                                                      |
| Credential Client | An OAuth client or GitHub App identity and its private issuance material. One Client can support multiple Sources.                                                                                            |
| Secret Driver     | Private storage for OCC TokenService Source and Client material. Its private store is not a public Namespace Secret. Other TokenService implementations own their storage.                                    |
| Compute Driver    | Delivery to a specific workload. Kubernetes Compute stages Gateway values in a Secret per Agent revision and deletes that copy after the revision's Pods stop or the candidate is abandoned.                  |
| Credential Proxy  | Admitted data-plane credential delivery and any copies it owns, such as an OpenShell Provider created for an OCC-owned Source. An OpenShell-owned Source can instead use its authoritative Provider directly. |
| Platform operator | Bootstrap and infrastructure credentials such as database URLs, OCC signing keys, and TLS keys. Kubernetes stores these separately; Deployments refer to them across Pod restarts.                            |

A **public Namespace Secret** is a top-level OCC resource with its own ID, IAM permissions, and CRUD API. Authorized users can list or read its metadata, but not its plaintext value. A **private Secret** is storage owned by another object: OCC TokenService stores Source and Client values through `SecretDriver.privateSecrets`, without creating a separate Namespace Secret resource or list entry. Both can be stored as Kubernetes Secrets.

A delivery copy is not an independently user-managed credential. Some copies can be shared or retained until cleanup succeeds. Removing the Namespace Secret resource must not remove private Source or Client material, platform secrets, or Compute and Proxy copies that are still needed.

## Replace the remaining callers

| Current caller                                                                         | Source-backed behavior                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slack bot/app and optional signing, user, or relay credentials; other Gateway bindings | Select a ready static Source in the same Namespace and bind it explicitly in `Configuration.secretBindings`. Worker resolves the Source and Compute delivers it only to the dedicated Gateway.                                                                                                  |
| Slack preflight, directory lookup, saved-ID hydration, and Plugin approver lookup      | Authorize the selected Source and target operation, then use the value transiently through the Channel Driver. Bot validation and directory requests send the bot token to Slack; app-token validation checks the role locally without opening a socket. Preserve named accounts and HTTP mode. |
| Model credentials and guided Agent provisioning                                        | Use one Source selection, binding, and authorization path across supported providers and execution modes. Model and Credential Proxy admission own provider-specific routes and presentations, including Anthropic's `x-api-key` header.                                                        |
| Administrator-supplied upstream channel proxy authentication                           | Select a static Source for `networkProxy`; Worker authorizes/resolves it and Compute supplies only the channel egress proxy's Envoy credential slot.                                                                                                                                            |
| Legacy prepared issuer inputs that reference public Secrets                            | Complete the [approved legacy Sender retirement](20261124-credential-design-1-0/index.md). Do not introduce a replacement Sender or weaken existing issuer evidence.                                                                                                                            |
| Presets, provisioning, Agent revisions, repair, Stop, deletion, and Namespace teardown | Use Source references for new work and preserve or extend Source reference, withdrawal, and cleanup checks.                                                                                                                                                                                     |

Modern Plugin OAuth and repository credential delivery already use Sources. This proposal changes their Slack approver lookup where applicable, not their credential ownership.

## Authorization and delivery

OCC requires the caller's exact `credential_source:operate` permission and the existing permission on the target operation. A deployment additionally requires the Agent's delegated Source grant. Check the same Namespace, Source readiness, type, selected owner instance, and recipient before admitting work; recheck authorization and owner identity across asynchronous resolution. Configuration and revisions store references, never plaintext credentials.

For Slack startup, use the submitted Gateway contract: Compute asks Worker to resolve the explicit binding, and Kubernetes Compute creates one revision-specific Secret referenced only by the Gateway container. A replacement Pod for the same revision reuses it. Compute stops that revision's Gateway Pods before deleting the copy on Stop, retirement, or abandonment. The dedicated Harness receives neither the binding nor Secret-read permissions. Embedded Source export remains unsupported.

For upstream proxy authentication, extend the Compute revision context with `authorize(signal): Promise<void>` and `resolve(signal): Promise<{ value: string; version: string }>`. Pin the Source ID and TokenService instance in the revision. Compute authorizes before reuse, resolves only for the existing Envoy credential slot, and clears that slot on withdrawal or retirement. Do not inject this credential into Gateway or Harness.

## Interface changes

### APIs

Change Channel directory lookup from `secretId` to `sourceId`, keeping Namespace scope server-owned. Change `networkProxy.credentialSecretId` to `credentialSourceId`. Switch schemas, handlers, permission advice, Console callers, and generated API together. At the final removal gate, remove direct Secret Harness auth, Secret Configuration bindings, legacy issuer `secrets` inputs, the five Secret CRUD operations, and Secret permission endpoints. Give device-authorization sessions their own identifier schema before removing `SecretId`.

### IAM

Reuse Source IAM and existing target operations. Remove the public Secret IAM catalog and bindings only after runtime cutover.

### Database entities

After consumer replacement, discard obsolete public Namespace Secret material through each record's original owning Driver, with exact backend identity and ownership checks. Keep its record and Driver methods, and block schema removal, until deletion is confirmed; retry failed or uncertain cleanup. Then remove dependent foreign keys, Secret columns, `credential_source_secrets`, `occ.secrets`, and obsolete validators in a coherent schema change. Existing configurations with Secret references require new Source bindings; do not import or convert legacy Secrets, grants, revisions, or queued work. Preserve Source deletion, withdrawal, and Namespace teardown protections, private Source/Client custody, and Compute delivery Secrets.

### Driver contracts

- **Channel:** Change `ChannelCredentialReader` from a Secret Driver callback to transient, authorized TokenService Source use. Keep provider checks and target/Source/owner rechecks outside the write transaction. Bot validation uses `auth.test`; app validation does not open a socket.
- **Compute:** Keep the Gateway startup contract and replace the Secret-backed proxy context as described above. Remove `secretEnvironment` only after its remaining callers have replacements.
- **Secret:** Keep `SecretDriver.privateSecrets` for TokenService's internal storage. Once consumers use Sources and obsolete public material is discarded, verify the selected Driver still supports private credential storage and cleanup, then remove its Namespace Secret methods.

## Delivery order and open decisions

1. Complete Gateway Source delivery while preserving the existing Slack Namespace Secret path.
2. Switch Slack validation, Configuration, directory APIs, Console callers, and generated contracts together. Qualify actual Gateway startup before declaring Slack support.
3. Complete the generic model Source path and recipient-specific upstream proxy path. Then remove public Secrets once no supported runtime caller depends on them.

The remaining decisions are narrow: whether embedded/direct-only model profiles gain an admitted Proxy path or are retired; how the Envoy namespace's workload managers, credential freshness, and withdrawal are handled; and whether OpenShell-owned Gateway export is authorized and qualified, including operator certificate custody and Provider identity handling. Do not enable unqualified export or silently fall back to another owner. Existing model work must qualify supported flows, including active revision replacement, before the public Secret removal gate.

## Simplifications

Keeping the public Secret API, even without a Console page, retains two credential management models and their separate IAM and reference lifecycles. Reusing Source ownership removes that duplication without moving model or proxy credentials into Gateway delivery.

## Acceptance Criteria

- Exercise the real Configuration, deployment, Channel directory, and proxy callers with exact Source and target IAM. Admission denial creates no revision or unauthorized provider request. If a later Worker recheck fails, discard resolved values, stop further delivery, and clean any abandoned revision copy through Compute.
- Register regular Agent workflow integration for PostgreSQL Worker/Compute, Gateway Slack startup, model Proxy admission, authenticated channel egress, redeploy, revocation, repair, Stop, retirement, abandonment, and Namespace teardown. Distinguish fixtures and process-environment checks from native provider use. Live Slack messages require separate authorization.
- Before public Secret removal, verify that supported runtime callers and newly created work no longer depend on Secret CRUD, references, IAM, or persistence. A backend identity mismatch must prevent deletion; failed or uncertain cleanup must retain the record and block schema removal. Private TokenService/Client custody and Compute copies must remain intact.
