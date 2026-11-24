---
status: Proposed
implementation_status: Not implemented
author: freeqaz
---

# Proposal: Repository token Source for native Git

- **ID:** RFC-20261123-repository-token-source
- **Created:** 2026-11-23
- **Last updated:** 2026-11-24
- **RFC PR:** [#7149](https://github.com/openclaw/openclaw-enterprise/pull/7149)
- **Companions:** [Installed copies, replacement and retirement](lifecycle.md); [Acceptance criteria and delivery](acceptance.md)
- **Related:** [Issue #6993](https://github.com/openclaw/openclaw-enterprise/issues/6993), [Per-Agent repository network policy](../20261119-repository-network-policy.md), [credential source ownership](../0023-egress-proxy-credential-lifecycle/credential-source-ownership.md), [managed static Sources](../../../docs/reference/credential-sources/managed-static.md), [native Git delivery](../../../docs/reference/repository-credentials/openshell-git.md)

<a id="problem-and-decision"></a>

## Summary

A Namespace can give its Agents native Git access with a fine-grained GitHub personal access token instead of a GitHub App. The token is a managed TokenService Source in that Namespace, selected by ID in the Namespace's repository registration. The Source carries its own repository and access ceiling, which OCC intersects with the Installation ceiling, the registration and each Agent's saved grants. The Worker lends the token to an endpointless OpenShell Provider for at most 15 minutes at a time; the workload sees only a placeholder. Pull request API access stays on the GitHub App path.

## Motivation

Native Git delivery under [RFC-20261119](../20261119-repository-network-policy.md) accepts only GitHub App authority: the [repository registry](../../../apps/controller/src/drivers/repo/github/access/registry.ts) requires `appId` and `githubInstallationId`, and the [Git Provider](../../../apps/controller/src/drivers/egress-proxy/openshell-prepared-git-provider.ts) and [bound rule](../../../apps/controller/src/drivers/sandbox/openshell-git-network-policy.ts) accept only an installation Provider. Without a GitHub App, an operator has no supported production path to Git.

TokenService Sources already provide enrolment, write-only custody, audited replacement while bound ([#7006](https://github.com/openclaw/openclaw-enterprise/pull/7006)) and guarded deletion ([`managed-credential-sources.ts`](../../../packages/occ/src/managed-credential-sources.ts)). Their only permitted use today is a model provider: the [preset list](../../../packages/contracts/src/model-providers.ts) holds `openai` alone.

<a id="scope"></a>

## Goals

- **G1.** A Source-backed registration gets the same per-Agent read and write enforcement as the App path.
- **G2.** The token never enters the workload, and no API returns it. A Source that holds a repository token never becomes a model credential.
- **G3.** Replacement reaches running Agents without a redeploy; committed and delivered are separate events, and delivered means the target Sandbox applied it.
- **G4.** Revocation, retirement and Stop end access within a stated bound; a stale or uncertain write never extends it, and no installed copy outlives its Source.
- **G5.** App-backed registrations, including pull request access, are unchanged. An Installation without a GitHub App installs and starts.

## Non-goals

REST or GraphQL access with a token; other token classes; selection on the Agent; two credentials in one Agent revision; any OCE check of the token's expiry, permissions or revocation at GitHub.

<a id="design"></a>

## Proposal

### Enrol the Source

A caller with `credential_source:create` registers a managed static Source with `POST /namespaces/{namespaceId}/credential-sources`. The preset `github` in `config.provider_preset` marks its permitted use: native Git only. Before custody, OCC accepts only a fine-grained token that the native Git Provider can install, within its size limit and free of the reserved placeholder marker, and refuses every other value. OCC makes no GitHub call. The value is write-only.

The Source config also holds the **Source ceiling** in `config.repositories`: an explicit list of `{ repository, access }` grants, the same shape as the saved policy. OCC refuses a ceiling change in the same request as a new value, and while the registry names the Source.

**Git use is immutable.** The preset is chosen at registration and never changes, whether or not a registration names the Source. OCC refuses, with `409`, adding `github` to an existing Source, removing it or replacing it with another preset, and clearing `config`. A `github` Source therefore never becomes eligible for model delivery or workload projection: every model consumer, Harness authentication and an Agent's `credentialSources` refuse it, and a model Source never becomes a Git credential. The marker stays the existing preset field rather than a separate Git-use field, because the preset already carries destination authority for every Source and needs no migration and no new setting.

### Select it from the registration

A Namespace registration in the repository registry selects the Source with `credentialSource: "cs_…"`. The Source must be in the same Namespace. This is the opt-in; nothing changes for a Namespace whose registrations do not name a Source.

The registry accepts `credentialSource` only with `profiles: ["github-repository"]`, `nativeGit: "v1"` and permissions of metadata and contents. It refuses it with `scopedRest`, `allowStandingApproval`, `pushRefAllowlist`, `transport`, `pullRequestBase` and `draftPullLimit`. The App fields at the registry root become optional together; a registry without an App can hold only Source-backed registrations.

The registry grant identity includes `credentialSource`, so a changed selection makes earlier revisions stale through the existing check. App grant identities stay byte-identical.

**One permission set per selection.** Registrations that one Agent selection resolves to the same Source must carry identical permissions, as the selected-set resolver already requires on the App path. A selection whose registrations differ, for example contents read on one repository and contents write on another, is refused with a reason that names the differing permissions. Per-repository read or write comes from the saved grants, not from differing registrations.

### Effective access

Effective access is the intersection of the Installation's `repositoryNetworkPolicyCeiling`, the registration's contents permission, the Source ceiling and the Agent's saved grants. OpenShell enforces it per repository path: upload-pack for read, plus receive-pack for write. GitHub also enforces the token's own repositories and permissions; where they are narrower, GitHub refuses the request and Git shows that error.

Source-backed delivery keeps the Git-only boundary of RFC-20261119 at deployment and after every replacement: the Provider has zero endpoints, the Sandbox binds exactly the saved repository paths to that Provider, and REST and GraphQL requests are denied before forwarding. Source-backed delivery requires a saved native repository network policy with at least one grant. Without one, deploy refuses the revision; it never falls back to legacy delivery.

### Read the policy

The policy editor keeps the same per-Agent grants. `GET .../sandbox-policy/networking` adds `repositoryCredential`, never the token:

- For an App-backed selection: `{ kind: "github_app" }`.
- For a Source-backed selection and a caller with exact `credential_source:read` on that Source: `{ kind: "credential_source", id, name, state, ceiling }`, the effective access, and the delivery state of each running revision ([Replace](lifecycle.md#replace)).
- For a Source-backed selection and a caller without that permission: `{ kind: "credential_source", readable: false }`. The response names no Source ID, name, state or ceiling and omits effective access and delivery state, which would reveal the ceiling and the Source's versions. The saved grants, version and Installation ceiling stay visible, as today, so the caller can still review and clear them.

### Save and deploy

At save, validate and deploy, OCC resolves the Agent's grants to one credential. With a Source, it refuses:

| Condition                                                                       | Answer                              |
| ------------------------------------------------------------------------------- | ----------------------------------- |
| Source missing, not `ready`, or wrong Namespace, TokenService or preset         | `409`                               |
| Caller or Agent principal lacks `credential_source:operate`                     | `403`                               |
| A saved grant exceeds the Source ceiling                                        | `409` on `/repositoryNetworkPolicy` |
| Grants resolve to more than one credential (App and Source, two Sources)        | `409`                               |
| Registrations that resolve to the Source carry different permissions            | `409`, naming the permissions       |
| Deploy with no saved repository network policy, or an empty one, for the Source | `409` on `/repositoryNetworkPolicy` |

One credential per revision follows from the bound rule, which binds every repository to one Provider.

**Withdrawal survives lost authority.** These refusals never apply to clearing the saved Git grants. A caller with the existing permissions to edit the Agent's policy can always save an empty list, and Stop, with Agent `operate`, always works, while the Source is missing, not `ready` or `deleting`, or the caller or Agent principal has lost `credential_source:operate` or `read` on it.

### Custody and loan

TokenService keeps the value in its Installation-private store, with a new random version per write. The Worker reads it into memory and installs it in an endpointless OpenShell Provider; the workload sees only a stable placeholder.

At each loan the Worker rechecks the Source state, preset, owner, the revision's saved grants against the current ceiling, the Agent principal's `operate` and the token class. A loan ends at most 15 minutes after the authority check that admitted it, and never after the grant's own expiry. It renews before it ends. The loan end is the Provider credential's expiry, not the token's expiry at GitHub, which OCE cannot learn or shorten. The 15-minute bound stays provisional until AC-5 passes.

### Lifecycle

Installed copies, replacement, serialized Provider writes, revocation and Stop, retirement, install and start without a GitHub App, and attribution and audit are specified in [Installed copies, replacement and retirement](lifecycle.md). [Acceptance criteria and delivery](acceptance.md) holds AC-1 to AC-10 and the delivery status.

## Interface changes

### APIs

| Change  | Operation                                                                        | Behavior and contract change                                                                                                                                                                                                                              |
| ------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Changed | POST `/namespaces/{namespaceId}/credential-sources`                              | Preset `github` and the Source ceiling in `config`. Value checked before custody. Model consumers refuse the preset.                                                                                                                                      |
| Changed | PATCH `/namespaces/{namespaceId}/credential-sources/{credentialSourceId}`        | Value checked before custody. `409` for any change to or removal of the `github` preset, clearing `config`, and a new value while a write to a copy is unreconciled. Ceiling changes only without a new value and while no registration names the Source. |
| Changed | DELETE `/namespaces/{namespaceId}/credential-sources/{credentialSourceId}`       | `409` with a named reason while the loaded registry names the Source, a recorded copy is not confirmed retired, or a write is unreconciled.                                                                                                               |
| Changed | GET, PUT and POST `/validate` on `.../sandbox-policy/networking`, POST `/deploy` | Refusals in the save table; clearing grants is never refused for Source reasons. GET adds `repositoryCredential`; Source metadata, effective access and delivery state require exact `credential_source:read`.                                            |

### IAM

| Operation or capability              | Required permission and scope                                                                                     | What changes                                                                   |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Enrol, replace, retire               | `credential_source:create`, `update`, `delete` in the Namespace                                                   | No changes; reused.                                                            |
| Save and deploy                      | Existing policy permissions plus `credential_source:operate` on the Source for the caller and the Agent principal | Reused, as for model Sources; checked again at each loan. Not needed to clear. |
| Read Source metadata in a policy GET | Existing policy read plus exact `credential_source:read` on the Source                                            | New field-level check; without it the Source is reported only as unreadable.   |
| Clear grants, Stop                   | Existing policy edit permissions; Agent `operate` for Stop                                                        | No Source permission or state required.                                        |

### Database entities

| Entity                       | Change                                                                                                                                                                      | Persistence semantics                                                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Repository Source copy (new) | Per Source-backed revision: Source ID, TokenService instance, Namespace, Agent, revision, Provider name, Source version per write, confirmation, unknown write, retirement. | Created in the deploy transaction; updated by the Worker before each write and after each read-back; survives restarts. Migration. |

The revision still freezes the Source through the existing registry grant identity, the catalog row already exists and the value stays in TokenService custody.

### Driver contracts

- Repo: the registration field `credentialSource`, optional App fields, and a resolved credential that is the App installation or a Source reference.
- Credential Proxy: the native Git Provider accepts a Source reference in place of an installation ID, with its own name prefix and a 15-minute loan limit. It reports the generation the target Sandbox applied, and retires a recorded copy by Provider name with read-back confirmation.
- Sandbox: the bound Git rule accepts the Source Provider name; one Provider per revision stays.
- TokenService: no change; `resolveCredential` already returns the custody version.

## Simplifications

Selection in the registry needs no Agent model change or admission version; the copy record needs one migration. Reusing the Source lifecycle avoids a Worker-mounted Secret, a Helm value and file-based versioning. No infrastructure simplifications.

<a id="alternatives-and-open-decisions"></a>

## Rationale and alternatives

- **Select the Source on the Agent.** Self-service, but it needs a migration relaxing the v9 admission rule in [0090](../../../migrations/0090_native_git_delivery.sql), an end to the rule that a TokenService Source authenticates the Harness, and Compute changes. It can follow later.
- **A Kubernetes Secret mounted in the Worker.** Smaller, but replacement has no actor in the audit and needs `kubectl`.
- **A GitHub probe at enrolment.** It adds a network call to enrolment, and its result goes stale.
- **A separate Git-use field.** It would duplicate the destination authority the preset already carries and need its own immutability rules.
- **Per-repository permissions under one Source.** The runtime checks one contents permission per selection; saved grants already give per-repository read or write.

## Unresolved questions

1. **Serialization (Credential Delivery).** Is a shared row lock plus a conditional Provider write, with a durable fence for uncertain writes, acceptable? AC-4 binds either way.
2. **Loan window (Credential Delivery).** Is 15 minutes the right revocation lag?
3. **Ceiling encoding.** Config values are strings of at most 2,048 characters, so the ceiling is one encoded value. Is a typed field preferred?
