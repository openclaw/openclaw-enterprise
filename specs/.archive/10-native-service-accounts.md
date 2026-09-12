# Feature Spec: Native Service Accounts

**Date:** 2026-08-24
**Status:** Planning
**Owner:** OCC, external credential owners, and Kubernetes Compute
**Source baseline:** `openai/openclaw-enterprise@2e9769c751d7`.

## Problem and Decision

Add a Namespace-owned `ServiceAccount` that associates one externally stored API-key or OAuth credential
reference with an Agent. OCC implements native accounts, authorizes account operations, and snapshots
the association at deployment. An authorized external credential owner copies the exact referenced
credential into the existing Agent-specific Kubernetes Secret; `KubernetesComputeDriver` retains its
existing Harness-specific `secretKeyRef` projection and never accesses Secrets.

The authoritative [platform design](../../docs/design/resources.md#platform-resources) currently excludes provider
accounts from platform resources. Amend it before implementation to admit native account representations
while preserving external ownership of provider accounts, provider authorization, and credentials.

## Scope

**Accepted requirements:** Namespace-owned native account; one API-key or OAuth credential reference per
account; optional association with a same-Namespace Agent; and
actual provider-backed Kubernetes execution through dedicated Codex and default embedded OpenClaw.

**Deferred or unchanged:** provider-backed account implementations; OAuth execution, refresh credentials,
and refresh implementation; new executable Drivers or Harness abstractions; OCC Secret access; workload identity.

## Contract

### Account, association, and revision snapshot

```ts
interface ServiceAccount {
  readonly id: string;
  readonly namespaceId: string;
  readonly name: string;
  readonly credential?: ServiceAccountCredential;
}

interface ServiceAccountCredential {
  readonly kind: "api_key" | "oauth_access_token";
  readonly secretRef: { readonly name: string; readonly key: string };
}

interface Agent { readonly serviceAccountId?: string; }

interface AgentRevision {
  readonly serviceAccount?: {
    readonly id: string;
    readonly credential: ServiceAccountCredential;
  };
}
```

OCC directly implements native accounts. Introduce backend selection only when a second account backend
exists. The architectural `ResourceDriver` remains the future owner of external-provider account operations;
native accounts require no executable Driver capability or `ServiceAccountDriver`.
[`IAMDriver`](../../packages/contracts/src/index.ts) remains authorization-only.

Each Agent references at most one account; same-Namespace Agents may share an account. Account and Agent
Namespace ownership must match. The credential reference names one Kubernetes Secret and key in the
account's backing Namespace; Namespace is derived from the account, never caller-selected. Reject invalid,
mismatched, or cross-Namespace references. The admitted revision freezes account identity and credential
metadata; later edits affect only future deployments. Resources and snapshots contain no credential bytes.

### Authorization and provider ownership

Follow the existing [Namespace collection authorization](../../packages/occ/src/index.ts):

```ts
authorize(actor, "create", {
  kind: "service_account",
  id: namespaceId,
  namespaceId,
});
```

Reading, updating a credential, and deleting an account authorize the exact
`{ kind: "service_account", id: accountId, namespaceId }` using `read`, `update`, or `delete`. Agent
create/update/deploy retains existing exact Agent authorization and additionally requires `read` on its
associated exact account. Deny before persistence, dispatch, provider access, or Kubernetes side effects.
An account referenced by an Agent cannot be deleted.

Future provider operations require independently authorized provider credentials; OCC permission cannot
create provider-side authority. ChatGPT workspace accounts differ from API Platform project accounts:
workspace owner/admin authority creates workspace accounts; an existing account's manager may configure
that account and issue its credentials, but cannot create arbitrary accounts or grant broader sharing.
Workspace paths are
`/v1/manage/workspaces/{workspaceId}/service-accounts`,
`.../{serviceAccountId}/credentials`, and `.../{serviceAccountId}/share`. See the
workspace admin implementation
and existing provider client.

### Credential materialization and Harness mapping

The account credential's referenced Namespace-scoped source Secret is the sole source of the Agent
credential. An authorized external operator/materializer reads the persisted account reference,
independently verifies Namespace and source ownership, reads precisely `secretRef.name[secretRef.key]`,
and writes that value into the existing exact-Agent runtime Secret:

```text
<runtime.modelSecretPrefix>-<first 12 hex characters of sha256(agentId)>
key: OPENAI_API_KEY
```

This materialization is an explicit external prerequisite; OCC and Kubernetes Compute neither read nor write
source or runtime Secrets and receive no Secret RBAC. The production materializer is an implementation gap.
Missing source/destination materialization prevents workload readiness and revision activation; no alternate
credential is selected. Preserve the [production Secret boundary](../../docs/design/safeguards.md#secret-access).

Existing Harness selection and
[Kubernetes topology](../../apps/controller/src/drivers/compute/kubernetes/index.ts)
already determine placement; no additional Harness abstraction is required:

| Admitted Harness | Credential placement | Actual execution |
| --- | --- | --- |
| `codex` + `dedicated` | `OPENAI_API_KEY` in the exact-Agent Codex Pod only; never its separate gateway | `codex/<model>` through authenticated app-server WebSocket |
| `openclaw` + `embedded` | `OPENAI_API_KEY` in the exact-Agent combined gateway/Harness Pod | Default native `openai/<model>` |
| Either + `oauth_access_token` | None; reject deployment before revision admission | Deferred |

The credential backend/provider owns future OAuth issuance and refresh because it owns provider authorization
and refresh credentials. OCC, `IAMDriver`, Kubernetes Compute, and Harnesses do not refresh provider tokens.
Represent an OAuth reference, but defer OAuth deployment and every refresh mechanism.

## Implementation

1. Amend [`docs/design.md`](../../docs/design.md) to add Namespace-owned accounts and Agent association
   without expanding provider ownership or the controller's Secret boundary.
2. Add account/API contracts, routes, credential reference, optional Agent association, and revision
   snapshot in [`packages/contracts/src/index.ts`](../../packages/contracts/src/index.ts),
   [`api/resources.ts`](../../packages/contracts/src/api/resources.ts), and
   [`api/routes.ts`](../../packages/contracts/src/api/routes.ts); regenerate OpenAPI.
3. Add account persistence and same-Namespace relationships in
   [`postgres-schema.ts`](../../packages/occ/src/state/postgres-schema.ts),
   [`platform-state.ts`](../../packages/occ/src/state/platform-state.ts), and
   [`postgres-state.ts`](../../packages/occ/src/state/postgres-state.ts).
4. Implement native operations, exact authorization, reference/association validation, OAuth deployment
   rejection, and revision snapshotting in [`packages/occ/src/index.ts`](../../packages/occ/src/index.ts)
   and the existing [controller routes](../../apps/controller/src/index.ts).
5. Preserve Kubernetes Compute topology and Secret projection; implement reference-driven external
   materialization using the authorized operator path in real Kubernetes integration.
6. Update [IAM](../../docs/reference/authorization.md), [Agent](../../docs/reference/agents.md), and
   [Kubernetes Compute](../../docs/reference/drivers/kubernetes-compute.md); add a ServiceAccount guide linked from
   [`docs/README.md`](../../docs/README.md).

## Verification

Extend the existing provider-backed
[`harness-topology-k3d-real.test.mjs`](../../tests/integration/harness-topology-k3d-real.test.mjs) using real
OCC routes, PostgreSQL, the worker, Kubernetes, approved images, and an existing authorized model key. In
each scenario, seed a distinct Namespace-local source Secret; create a native account; associate that
Secret's exact persisted `{name,key}`; associate the Agent; have the authorized test operator materialize
the runtime Secret **only from the persisted reference**; compare source and destination using a safe
one-way fingerprint without printing credential bytes; deploy; assert the immutable account snapshot; and
obtain a fresh scenario-specific nonce from the actual provider response.

1. **Dedicated Codex:** assert distinct gateway/Codex Pods; exact-Agent runtime Secret and `OPENAI_API_KEY`
   only in Codex; no gateway model credential; authenticated app-server WebSocket; and a fresh provider nonce.
2. **Default embedded OpenClaw:** assert one exact-Agent combined gateway/Harness Pod with its own runtime
   Secret and `OPENAI_API_KEY`; no Codex Pod; native `openai/<model>`; and a different fresh provider nonce.
3. **Security/failure:** assert exact-resource denial; cross-Namespace account, Agent, and source-reference
   rejection; OAuth deployment rejection; missing Secrets prevent activation;
   no controller Secret RBAC; sibling isolation; immutable snapshots; deletion rejection while bound; and no
   tokens in responses, PostgreSQL, revisions, logs, audits, or ConfigMaps.

Follow [real Kubernetes integration instructions](../../AGENTS.md#running-integration-tests). Missing
infrastructure, credentials, materialization evidence, or either real provider response is a verification gap.

## Implementation Gaps and Open Decisions

**Current implementation gaps:** architecture amendment; OCC account contracts, routes, persistence,
authorization, Agent association, and revision snapshot; reference-driven operator materialization; and
account-originated real Kubernetes integration. Existing integrations provision Agent Secrets directly from
an environment credential, which does not prove account association or reference causality.

**Open decisions:** which authorized external owner/materializer provides production source-to-Agent Secret
delivery; whether a future ChatGPT workspace backend creates accounts or binds admin-precreated accounts;
and which actor-preserving provider authorization it uses. Provider decisions do not block native API-key
integration; production delivery requires naming and implementing its owner. OAuth execution/refresh are deferred.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- [2026-08-31 18:10]: Removed private source hyperlinks without changing the historical implementation specification. (01a036f4-cf1d-7cc1-bbc1-000879038ac8 - 4e16a74272e716d998c6da59fff95fde806d86fa)

- [2026-08-24 19:39]: Defined native ServiceAccount ownership, selected ResourceDriver backends, credential references, Kubernetes Harness mapping, deferred OAuth refresh, provider authorization boundaries, implementation gaps, and real Codex/OpenClaw acceptance. (01a03542-30ff-77a1-9967-587d55548ace - 2e9769c751d7)
- [2026-08-24 19:49]: Simplified native account ownership, exact authorization, reference-driven external Secret materialization, deferred OAuth, and causal real Codex/OpenClaw verification. (01a03542-30ff-77a1-9967-587d55548ace - 82561fd04ed8)
