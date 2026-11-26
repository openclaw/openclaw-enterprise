---
status: Proposed
implementation_status: Not implemented
author: stevenlee-oai
---

# Use Credential Sources for public credentials

**RFC-20261126-credential-source-consolidation** · Created 2026-11-26 · Depends on [Gateway startup credentials](20261125-gateway-startup-credentials.md).

An operator should create one Credential Source and bind it to each authorized use, instead of choosing between a Source and a Namespace Secret. Today, public Secret CRUD, Configuration bindings, Slack preflight and directory lookup, direct Harness authentication, authenticated channel egress, and some saved Source inputs still use Namespace Secrets. Removing the Secret page or API before replacing these callers would break supported workflows.

**Approach:** Make TokenService the owner of user-managed credential material. OCC authorizes each exact same-Namespace Source and each target operation. Each consumer retains its own delivery and policy boundary: Compute exports an explicitly bound static Source to the Gateway, Credential Proxy governs data-plane model credentials, and channel egress receives only its own upstream-proxy credential. Once all supported runtime callers use Sources, remove the public Namespace Secret resource. Keep Secret Driver private custody, private CredentialClient records, and Compute-owned Kubernetes Secrets. No conversion of existing stored Secrets, grants, revisions, or queued work is in scope.

**Tradeoff:** Control-plane Slack preflight and directory lookup receive usable bot/app material and send it to Slack. Gateway export creates a usable revision copy accessible to Gateway namespace workload managers and refreshed by managed redeploy. The egress-proxy recipient needs its own delivery and withdrawal contract; Gateway export cannot authorize a copy into the Harness or proxy. Do not export OpenShell-owned Sources until its separate operator-trust decision and qualification.

## Supported caller and recipient inventory

| Current public Secret use                                                                                              | Replacement                                                                                                                                     | Recipient and owner                                                                     |
| ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Slack bot/app, optional signing/user/relay credentials; other supported Gateway Configuration bindings                 | Explicit ready static Source binding in `Configuration.secretBindings`                                                                          | Dedicated Gateway; Worker resolves and selected Compute stages/cleans the revision copy |
| Slack validation, directory lookup, saved-ID hydration and Plugin approver lookup                                      | Exact selected static bot/app Source and existing target IAM                                                                                    | OCC/Channel Driver; transient validation or provider request                            |
| Harness `api_key` / `codex_pat`, guided first-Agent and provisioning                                                   | Model `harnessAuth.method: credential_source`, with a reviewed provider preset/presentation; `openai` and `codex-pat` exist, Anthropic does not | Data-plane Harness only through its admitted Credential Proxy path                      |
| `networkProxy.credentialSecretId`                                                                                      | Exact static Source reference, separately authorized for channel egress                                                                         | Channel egress proxy's existing credential/SDS slot; never Gateway or Harness           |
| Secret-backed prepared/legacy Source issuer inputs                                                                     | Replace a genuinely supported issuer input or retire the exposed legacy contract after inventory                                                | TokenService/issuer; preserve owner custody                                             |
| Public Secret CRUD, permission advice, access bindings, Presets, queued plans, revisions and Namespace deletion checks | Source lifecycle, Source IAM, reference inventory, withdrawal and teardown                                                                      | OCC; remove old surface only after no live dependency remains                           |

Runtime callers also include saved and rendered Presets, provisioning plans, Agent revisions, Source lifecycle checks, and Namespace teardown. These paths must use Source references for new work. Modern Plugin OAuth and repository credentials already use Sources; their Slack approver lookup remains a Channel caller. Enabled Teams is not currently supported.

## Delivery sequence

1. Complete the Gateway Source delivery dependency without changing its preserved Slack Secret path. The Console can create/select a generic static Source, but must not advertise Source-backed Slack behavior before the serving backend switches.
2. Cut over Slack atomically: Channel validation, exact Source IAM, Configuration checks, directory schema/handler/permission metadata, Console Slack and Plugin approver callers, and generated API. Keep native environment references and named-account/HTTP-mode behavior. Other Gateway credential fields use the existing explicit binding and must be qualified by their real caller.
3. Replace direct Harness and authenticated channel-proxy Secret inputs independently. Qualify an Anthropic Source preset and raw `x-api-key` Proxy presentation, active model-revision replacement and embedded/direct-only profiles, or obtain an explicit retirement decision. Add recipient-specific Worker/Compute proxy delivery before switching its public field. Do not use Gateway export for data-plane credentials.
4. Update Preset, provisioning, deployment, repair, Stop, Source deletion, and Namespace teardown code to use Source references. Do not add legacy-data conversion or compatibility paths.
5. Prove no supported runtime caller depends on public Secrets, then remove their APIs, IAM catalog/advice, refs, persistence, typed contracts/OpenAPI, docs, Console and obsolete tests. This does not authorize deleting existing credential data; fail explicitly on unsupported nonempty old state.

## Interface changes

### APIs

Keep Source enrollment and exact Source references. Change directory lookup from `secretId` to `sourceId`; derive Namespace scope from the route and switch schemas, handler and first-party callers together. Change authenticated channel proxy selection from `credentialSecretId` to `credentialSourceId`. Remove direct Secret Harness auth and the Secret branch of Configuration bindings after their replacements work. Remove the five public Secret CRUD operations, Secret permission endpoints, issuer `secrets` input, and generated schemas only at the final gate. Device-authorization session IDs currently reuse `SecretId`; give those independent sessions their own identifier schema.

### IAM

Reuse exact `credential_source:operate` and existing target permissions, with the canonical delegated Agent grant on deployment. Preserve caller and Agent rechecks across asynchronous work. Remove Secret IAM actions, resource kind and permission advice after their runtime consumers have switched. Do not translate existing grants.

### Database entities

Update the active schema and persistence operations to use Source references. Preserve existing Source reference, deletion, withdrawal, and Namespace teardown protections for all Source state, and extend them to each newly Source-backed consumer. Remove `occ.secrets`, Agent Secret columns, `credential_source_secrets` and old JSON validators after runtime cutover. Do not convert, rewrite, or delete existing stored credentials or historical records; removal must refuse unsupported nonempty old state.

### Driver contracts

- **Channel:** Change `ChannelCredentialReader` behavior from Secret Driver callback-only to transient authorized TokenService Source use. Preserve provider checks and target/Source/owner rechecks outside the write transaction; bot `auth.test` remains, app validation does not open a socket.
- **Compute:** Keep Gateway revision-specific Source staging. Replace `ComputeRevisionContext.secretEnvironment` and Secret-backed `networkProxyCredential` only when all consumers have replacements. The proposed proxy context supplies `authorize(signal): Promise<void>` and `resolve(signal): Promise<{ value: string; version: string }>`; the revision owns the Source ID and pinned TokenService instance. Compute authorizes before reuse, resolves only for the exact proxy slot, and clears the shared Envoy credential/SDS slot on withdrawal or retirement. Never project it into Gateway or Harness.
- **Secret:** Retain `SecretDriver.privateSecrets` and its private store lifecycle. Remove Namespace Secret-facing required methods only after public removal and selected-driver qualification. CredentialClient private records remain private.
- **TokenService, Credential Proxy and Harness:** Reuse Source resolution and reviewed data-plane admission. Finish the [approved legacy Sender retirement](20261124-credential-design-1-0/index.md) after settling admitted serving state; do not weaken its Secret-backed identity/deadline evidence or invent a replacement Sender. Qualify the approved Anthropic raw-header presentation and submit any additional required active-model-replacement behavior before implementation.

## Remaining runtime decisions

Decide whether currently supported embedded/direct-only model profiles that lack a Source/Proxy replacement are retired or gain an admitted Proxy path. Channel-proxy export requires a decision on shared Envoy namespace workload-manager access, rotation freshness, and withdrawal timing. OpenShell export separately requires approval of operator certificate custody and authority, Provider identity/race handling, and native qualification.

## Simplifications

Keeping public Secrets retains two user credential models. Moving every credential into Gateway export violates recipient and data-plane policy boundaries. Reuse Source ownership and existing consumer-specific delivery paths instead, without converting legacy data or deleting private custody and Kubernetes infrastructure Secrets.

## Acceptance Criteria

- Production Configuration, provisioning, deployment, directory and proxy callers enforce exact same-Namespace Source/target IAM, selected owner, readiness, type and recipient. Authorization failures release no material; Channel role failures prevent provider calls and revision creation.
- Register regular Agent workflow integration and exercise real PostgreSQL Worker/Compute, native Gateway Slack startup, model Proxy admission, authenticated channel egress, rotation/redeploy, revocation, repair, Stop, retirement, abandonment and Namespace teardown. Label fixtures, process-environment proof and unrun live Slack/OpenShell proof separately; do not send Slack messages without explicit authorization.
- Verify no supported runtime caller or newly created work depends on public Secret CRUD, bindings, IAM, or persistence before removing those surfaces. Prove private TokenService/CredentialClient custody and Kubernetes staged-copy cleanup still work.
