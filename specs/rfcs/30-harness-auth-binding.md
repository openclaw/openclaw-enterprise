---
status: Proposed
status_note: "Original proposal status retained; later delivery evidence and an approved embedded-activation amendment remain in the body."
---

# RFC: Harness authentication bindings

**Date:** 2026-09-16
**Status:** Proposed; not implemented or approved.
**Owner:** OCC admission and harness runtime integration.
**Source baseline:** Public `openclaw/openclaw-enterprise` at `2e49d175`.

## Problem and Decision

Give an Agent one explicit authentication binding for its model-executing harness. Resolve API keys and ChatGPT service-account credentials through the same admission and provisioning path, while retaining their existing credential owners.

Today Kubernetes Compute selects account-token projections or a deterministic per-Agent API-key Secret inside [Deployment rendering](../../apps/controller/src/drivers/compute/kubernetes/index.ts). [Codex startup](../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts) then selects the login command. Native account API-key references require separate operator materialization; first-class OCC Secret bindings reach only gateways.

Introduce `HarnessAuthBinding` and one internal harness-auth preparation function. Reuse OCC Secrets, ServiceAccounts, IAM checks, immutable revisions, and workload requirements. No new Driver, credential store, or auth resource is required.

## Scope

Support an existing OpenAI API key for embedded OpenClaw or dedicated Codex, and an existing issued ChatGPT service-account credential for dedicated Codex. Preserve Kubernetes Compute and its selected Sandbox provisioning path.

Credential issuance remains separate from binding. This RFC does not add arbitrary model providers, OAuth refresh, automatic rotation, brokered inference, workload enrollment, OCC service API keys, or gateway transport authentication. Other Compute implementations reject unsupported bindings; their delivery extensions are separate work.

Direct model credentials remain the scoped implementation exception described in [Secret safeguards](../../docs/design/safeguards.md#secret-access). The external project-root `ref/design.md` targets brokered access without credential delivery to workloads. Approval of this RFC accepts that existing direct-delivery boundary for this feature; it does not claim brokerage or change that external target.

## Contract

### Agent intent and revision snapshot

OCC owns one nullable `harnessAuth` binding on each Namespace-scoped Agent draft. Create omission means `null`; PATCH omission preserves the binding and explicit `null` clears it. Deployment of either supported topology requires a valid binding. The API returns references and metadata only.

```ts
type HarnessAuthBinding =
  | { method: "api_key"; source: SecretReference }
  | { method: "chatgpt_service_account"; serviceAccountId: string };
```

`SecretReference` is the existing `{ kind: "secret", namespaceId, id }` reference. Both sources must belong to the Agent's exact Namespace. A source may be shared by multiple same-Namespace Agents only after each Agent's independent authorization and compatibility checks. Selecting an auth method never changes the configured model, Harness, Provider, or execution mode.

Proposed alternative Agent fields:

```json
{
  "harnessAuth": {
    "method": "api_key",
    "source": { "kind": "secret", "namespaceId": "<namespace-id>", "id": "<secret-id>" }
  }
}
```

```json
{
  "harnessAuth": { "method": "chatgpt_service_account", "serviceAccountId": "<service-account-id>" }
}
```

A revision freezes the binding and the credential references resolved at admission. A ChatGPT snapshot retains an internal exact account credential reference and verified Provider/workspace ownership; reconciliation cannot replace it with a later account credential. API-key snapshots retain the stable OCC Secret reference and selected Secret Driver; dispatch resolves authoritative backend ownership metadata. Public APIs expose only safe binding references and readiness metadata, not provider workspace IDs, upstream account IDs, backend credential names, or secret values. Changing a draft affects a later explicit deployment; replacing a Secret value does not restore or rewrite historical values.

`harnessAuth` becomes the sole model-auth selector. It replaces the authentication role of Agent `serviceAccountId` and model-key Configuration bindings. Generic gateway Secret bindings remain for non-model uses; a competing `OPENAI_API_KEY` binding is rejected. Preserve `providerId` and its existing exact managed-account ownership checks. API-key Agents may remain providerless.

### Source resolution and authorization

OCC authorizes the Agent mutation and both the removed and replacement auth sources when changing a binding. API-key sources require exact Secret `operate`; account sources require exact ServiceAccount `read`. Namespace membership or possession of a reference grants neither permission.

At deployment, require actor `deploy` on the Agent and `read` on its Configuration. API-key delivery additionally requires both the actor and `Agent.servicePrincipalId` to have exact Secret `operate`. ChatGPT delivery retains current actor account `read`, issued-credential validation, and exact Provider/member Driver/workspace binding checks. It does not imply new account permissions for the Agent principal. Recheck these decisions and source ownership before worker provisioning, using the admitted revision. Existing [Secret admission](../../packages/occ/src/index.ts) and [worker checks](../../apps/controller/src/worker.ts) own these boundaries.

`SecretDriver` stores and resolves supplied keys. `ServiceAccountDriver` continues to create upstream accounts, issue credentials separately, and own upstream cleanup. Binding an account cannot issue a credential. Missing, foreign, unavailable, unissued, or incompatible sources fail closed without falling back to another source or method.

### Harness preparation and delivery

An internal `prepareHarnessAuth(harness, resolvedAuth)` function runs as one step in Kubernetes workload rendering, mapping validated references into the harness's known credential projections and login mode. Its input contains the admitted method and safe source metadata; its output contains Secret references and a closed, supported login mode. Neither contains plaintext credentials or caller-supplied shell commands. Keep this step with runtime integration code; do not introduce a separate auth-preparation path, component, registry, or installation selection.

| Binding and topology             | Delivery target               | Runtime authentication                                                                    |
| -------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------- |
| API key, embedded OpenClaw       | Combined gateway/harness only | Existing native OpenAI key consumption                                                    |
| API key, dedicated Codex         | Dedicated harness only        | `OPENAI_API_KEY`; `codex login --with-api-key` through stdin                              |
| ChatGPT account, dedicated Codex | Dedicated harness only        | Account token and workspace references; `login --with-access-token` with forced workspace |

The harness integration owns environment names and login behavior. Compute owns exact workload placement and projects the approved Secret references; the existing Sandbox handoff consumes already-rendered [HarnessWorkloadRequirements](../../packages/contracts/src/index.ts) carrying those references and the login mode. Carry the nonsecret login mode explicitly so startup does not infer it from whichever variables happen to exist. Reject unsupported model/auth/topology combinations before deployment work is admitted, and reject missing or conflicting runtime inputs before readiness.

Compute no longer interprets a ServiceAccount credential kind or falls back to a deterministic model Secret. Keep the prepared auth projections separate from gateway-only Configuration projections, so the dedicated gateway cannot receive the model credential. Preserve the account's token/workspace Secret as one directly projected source; do not copy its value into a per-Agent Secret. Required provider-login egress follows the admitted auth method through existing network-policy construction.

Gateway-to-harness tokens and Kubernetes ServiceAccount projections remain separate. A model credential neither authenticates a workload to OCC nor changes its service principal. Codex stores login state only in its existing bounded ephemeral home; model credentials must not appear in ConfigMaps, responses, revisions, logs, or audit payloads. A failed login leaves the candidate unready; existing guarded activation and recovery govern the previous revision.

### Lifecycle

A new binding is declarative: it does not restart an active Agent or revoke its previous credential. Extend existing Secret/account reference checks to cover Agent drafts, active revisions, and pending deployments so referenced sources cannot be deleted. Inactive history preserves references without indefinitely retaining sources.

Updating a Secret does not update an existing process environment. Operators update the source, deploy each intended consumer, verify model access, then revoke the old key at its upstream authority. Managed account refresh and rotation remain unsupported; replacement uses an independently issued account and a new binding. Revoking IAM access blocks later admission/provisioning but cannot retract delivered credentials. Immediate containment requires stopping consumers or upstream revocation.

## Implementation

1. Add binding schemas, Agent persistence, and immutable resolved revision snapshots in [contracts](../../packages/contracts/src/index.ts), [API resources](../../packages/contracts/src/api/resources.ts), and [OCC state](../../packages/occ/src/state). Update existing Agent create/PATCH, deployment, source-deletion checks, and worker reauthorization. Preserve database-enforced scope and revision immutability.
2. Add harness-auth preparation within Kubernetes workload rendering. Feed its projections and login mode into dedicated or embedded workload requirements; the existing Sandbox handoff consumes the rendered requirements. Preserve provider-login networking, ephemeral login state, exact ownership, and activation behavior.
3. Update the API and console: create a Secret or issue an account credential, save `harnessAuth`, provision transport/channel credentials, then deploy. Replace the legacy `modelConfigured`/per-Agent Secret path: the console shows the selected credential source, deployment validates the binding, and runtime checks establish readiness. Do not add a new persisted auth-status field; source selection does not prove provider acceptance. Remove `modelApiKey` from initial runtime provisioning and decouple its transport/channel operations from model/account checks. Retain transport/channel initial-only and create-without-overwrite semantics. Superseded model selectors and persisted state must fail explicitly; do not add silent inference, backfills, or parallel compatibility paths.
4. Update the affected current Agent, Secret, ServiceAccount, harness, and credential-lifecycle references, generated API, console, and existing harness/credential flows in the implementation change. This proposed RFC does not change their current-support claims.

## Verification

| Required outcome                            | Proof through the regular workflow                                                                                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Both auth methods bootstrap dedicated Codex | API creation/binding/deploy on disposable Kubernetes; real provider-accepted model turn for supplied key and managed account token                                                         |
| Embedded key support remains correct        | Same Secret-backed binding workflow and a real embedded OpenClaw model turn; reject embedded account-token binding                                                                         |
| Exact authorization and ownership           | Deny foreign Namespace/source, absent actor or required Agent grants, mismatched Provider/workspace, and revoked authorization between admission and dispatch before credential projection |
| Isolation and no credential disclosure      | Verify Pod Secret references target only intended consumers; use synthetic sentinels to check serialized resources, responses, logs, and audits without printing live credentials          |
| Revisions and lifecycle remain safe         | Change draft/source, prove old revision metadata unchanged, block deletion while referenced, redeploy with replacement key, and verify old upstream key rejection separately               |
| Failed auth cannot serve                    | Missing/invalid credentials or conflicting mode leave candidate unready; verify guarded activation/recovery and sibling Agent isolation                                                    |
| Sandbox uses the same contract              | Exercise selected Sandbox provisioning with genuine Secret projection and model access; unsupported upstream projection fails explicitly, not through a test-only bridge                   |

Extend existing runtime-credentials, Secret, service-account, and real harness-topology integrations. Fixture API tests prove authorization and persistence, not provider login or execution. Missing authorized credentials or infrastructure must be reported as missing proof.

## Delivery evidence (2026-09-17)

The implementation now connects binding schemas, immutable persistence, source
authorization, Kubernetes delivery, and console source selection. Local contract,
API/browser, PostgreSQL, type, generated-reference, and documentation checks have
passed. Native primary-model probes now gate startup, with a separate embedded
replacement probe before cutover. Both pinned native runtimes rejected a synthetic
invalid key at the official provider endpoint, and their actual startup probes
stayed unready without exposing native output. Final verification and CI results
are tracked with the implementation change. The original proposal status above
is retained as provenance.

Real provider-backed key/account turns, embedded execution, genuine selected
Sandbox delivery, replacement-key rejection, and live authentication-failure
recovery remain unproved. The disposable Kubernetes attempt could not start
because the host lacks required cgroup delegation; authorized managed-account
inputs were unavailable. Fixture checks do not replace those acceptance rows.

## Embedded activation decision (2026-09-17)

The approved simplification supersedes predecessor preservation during embedded
credential validation. Embedded deployment uses the shared gateway's `Recreate`
cutover, then one bounded credential/model check in the actual gateway startup.
Invalid credentials or provider failure may leave the Agent unavailable until
repair and restart or redeployment; automatic rollback is not required. The
separate authentication preflight Deployment and its lifecycle are removed.
Dedicated validation, credential isolation, authorization, immutable bindings,
and existing revision ownership and bookkeeping remain required. The
[current harness reference](../../docs/reference/harness-execution.md#harness-authentication)
owns this behavior; the preceding delivery evidence records the earlier design.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- [2026-09-16 17:15]: Clarify the single workload-rendering auth preparation step, existing Sandbox handoff, and source display versus deployment validation and runtime readiness. (01a0aca1-1d2f-7002-a11c-4c3ff03f89e7 - 2e49d175c9373bff6158db4ab43ced5858691e6d)
- [2026-09-16 17:02]: Draft the shared harness-auth binding RFC from current public implementation and the requested API-key/service-account unification. (01a0aca1-1d2f-7002-a11c-4c3ff03f89e7 - 2e49d175c9373bff6158db4ab43ced5858691e6d)
