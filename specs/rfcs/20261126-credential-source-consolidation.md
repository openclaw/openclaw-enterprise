---
status: Proposed
implementation_status: Not implemented
author: stevenlee-oai
---

# Use Credential Sources for public credentials

**RFC-20261126-credential-source-consolidation** · Created 2026-11-26 · Depends on [Gateway startup credentials](20261125-gateway-startup-credentials.md).

An operator should create one Credential Source and bind it to each authorized use, instead of choosing between a Source and a Namespace Secret. Today, public Secret CRUD, Configuration bindings, Slack preflight and directory lookup, direct Harness authentication, authenticated channel egress, and some saved Source inputs still use Namespace Secrets. Removing the Secret page or API before replacing these callers would break supported workflows.

**Approach:** Make TokenService the owner of user-managed credential material. OCC authorizes each exact same-Namespace Source and each target operation. Each consumer retains its own delivery and policy boundary: Compute exports an explicitly bound static Source to the Gateway, Credential Proxy governs data-plane model credentials, and channel egress receives only its own upstream-proxy credential. After all callers and persisted references are migrated, remove the public Namespace Secret resource. Keep Secret Driver private custody, private CredentialClient records, and Compute-owned Kubernetes Secrets.

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

The current [PostgreSQL Secret reference query](../../packages/occ/src/state/postgres-state.ts) covers Configurations, Agent auth/proxy fields, active and queued revisions, Source inputs, and queued/running provisioning, but omits saved Preset templates. The removal inventory must also scan saved and rendered Presets, failed-plan retries and immutable historical revisions. Modern Plugin OAuth and repository credentials already use Sources; their Slack approver lookup remains a Channel caller. Enabled Teams is not currently supported.

## Delivery sequence

1. Complete the Gateway Source delivery dependency without changing its preserved Slack Secret path. The Console can create/select a generic static Source, but must not advertise Source-backed Slack behavior before the serving backend switches.
2. Cut over Slack atomically: Channel validation, exact Source IAM, Configuration checks, directory schema/handler/permission metadata, Console Slack and Plugin approver callers, and generated API. Keep native environment references and named-account/HTTP-mode behavior. Other Gateway credential fields use the existing explicit binding and must be qualified by their real caller.
3. Replace direct Harness and authenticated channel-proxy Secret inputs independently. Qualify an Anthropic Source preset and raw `x-api-key` Proxy presentation, active model-revision replacement and embedded/direct-only profiles, or obtain an explicit retirement decision. Add recipient-specific Worker/Compute proxy delivery before switching its public field. Do not use Gateway export for data-plane credentials.
4. With an approved data-handling plan, rebind configurations, Agents, Presets and plans; replace or retire old revisions; settle queued/claimed work. Public Secret GET returns metadata only. Preserving a value requires an authorized server-side transfer through an available `SecretDriver.withValue`, confirmed Source custody, then approved original disposal; otherwise block or obtain authorized operator re-entry. No implicit grant translation, history rewrite, or deletion is authorized.
5. Prove zero remaining public Secret consumers and unresolved old material, then remove public Secret APIs, IAM resource/catalog/advice, refs, persistence, typed clients/OpenAPI, docs, Console and obsolete tests together. A nonzero inventory blocks removal.

## Interface changes

### APIs

Keep Source enrollment and exact Source references. Change directory lookup from `secretId` to `sourceId`; derive Namespace scope from the route and switch schemas, handler and first-party callers together. Change authenticated channel proxy selection from `credentialSecretId` to `credentialSourceId`. Remove direct Secret Harness auth and the Secret branch of Configuration bindings after their replacements work. Remove the five public Secret CRUD operations, Secret permission endpoints, issuer `secrets` input, and generated schemas only at the final gate. Device-authorization session IDs currently reuse `SecretId`; give those independent sessions their own identifier schema.

### IAM

Reuse exact `credential_source:operate` and existing target permissions, with the canonical delegated Agent grant on deployment. Preserve caller and Agent rechecks across asynchronous work. Do not automatically map Secret grants to Source grants. Remove Secret IAM actions, resource kind, role/access bindings and permission advice only after their consumers and old grants have an approved disposition.

### Database entities

Retain existing Source/Configuration/revision references. Extend Source reference, withdrawal and Namespace teardown checks for every new consumer and queued operation. Removing `occ.secrets`, Agent Secret columns, `credential_source_secrets`, old JSON validators and historical records is gated on explicit material-preservation and retention decisions; never drop nonempty data or orphan backend material.

### Driver contracts

- **Channel:** Change `ChannelCredentialReader` behavior from Secret Driver callback-only to transient authorized TokenService Source use. Preserve provider checks and target/Source/owner rechecks outside the write transaction; bot `auth.test` remains, app validation does not open a socket.
- **Compute:** Keep Gateway revision-specific Source staging. Replace `ComputeRevisionContext.secretEnvironment` and Secret-backed `networkProxyCredential` only when all consumers have replacements. The proposed proxy context supplies `authorize(signal): Promise<void>` and `resolve(signal): Promise<{ value: string; version: string }>`; the revision owns the Source ID and pinned TokenService instance. Compute authorizes before reuse, resolves only for the exact proxy slot, and clears the shared Envoy credential/SDS slot on withdrawal or retirement. Never project it into Gateway or Harness.
- **Secret:** Retain `SecretDriver.privateSecrets` and its private store lifecycle. Remove Namespace Secret-facing required methods only after public removal and selected-driver qualification. CredentialClient private records remain private.
- **TokenService, Credential Proxy and Harness:** Reuse Source resolution and reviewed data-plane admission. Finish the [approved legacy Sender retirement](20261124-credential-design-1-0/index.md) after settling admitted serving state; do not weaken its Secret-backed identity/deadline evidence or invent a replacement Sender. Qualify the approved Anthropic raw-header presentation and submit any additional required active-model-replacement behavior before implementation.

## Decisions before destructive cutover

Steven must choose how existing Secret material and grants are preserved or disposed of, how immutable revisions, failed-plan retries and audit history are retained, and whether currently supported embedded/direct-only model profiles that lack a Source/Proxy replacement are retired or gain an admitted Proxy path. Channel-proxy export also requires a decision on shared Envoy namespace workload-manager access, rotation freshness, and withdrawal timing. OpenShell export separately requires approval of operator certificate custody and authority, Provider identity/race handling, and native qualification. None of these choices is made here.

## Simplifications

Keeping public Secrets avoids migration but retains two user credential models. Moving every credential into Gateway export is simpler mechanically but violates recipient and data-plane policy boundaries. Reuse Source ownership and the existing consumer-specific delivery paths instead. This removes public Secret plumbing without deleting private custody or Kubernetes infrastructure Secrets.

## Acceptance Criteria

- Production Configuration, provisioning, deployment, directory and proxy callers enforce exact same-Namespace Source/target IAM, selected owner, readiness, type and recipient. Authorization failures release no material; Channel role failures prevent provider calls and revision creation.
- Register regular Agent workflow integration and exercise real PostgreSQL Worker/Compute, native Gateway Slack startup, model Proxy admission, authenticated channel egress, rotation/redeploy, revocation, repair, Stop, retirement, abandonment and Namespace teardown. Label fixtures, process-environment proof and unrun live Slack/OpenShell proof separately; do not send Slack messages without explicit authorization.
- Verify no remaining public Secret CRUD/bind/read caller, live reference, unsafe retry, undisposed grant or backend material before removing API/SDK/OpenAPI/IAM/persistence/docs/UI. Prove private TokenService/CredentialClient custody and Kubernetes staged-copy cleanup still work.
