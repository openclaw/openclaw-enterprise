---
status: Proposed
implementation_status: Not implemented
author: freeqaz-openai
---

# Proposal: Per-Agent repository network policy

- **ID:** RFC-20261119-repository-network-policy
- **Created:** 2026-11-19
- **Last updated:** 2026-11-22, [personal access token amendment](#personal-access-token-amendment-2026-11-22-proposed) proposed.
- **RFC PR:** [#6531](https://github.com/openclaw/openclaw-enterprise/pull/6531), originally submitted under RFC-0017.
- **Related:** [Agent egress](0017-agent-egress-0x/index.md), [Driver configuration](0022-driver-configuration-contributions.md), [repository credentials](../../docs/reference/repository-credentials.md).

<a id="problem-and-decision"></a>

## Summary

An Admin grants an Agent read access to A, write access to B and no access to C, even when its credential covers all three. The Sandbox Driver owns every repository network rule and credential binding. The Credential Proxy provisions and rotates an endpointless OpenShell Provider. OpenShell authorizes Git and injects the credential locally. Scoped REST also permits issue reads and PR creation. Creating a PR adds one request-time check in OCE.

## Motivation

The current [SandboxPolicy](../../docs/reference/sandbox-policies.md) grants access by binary, host and port. A, B and C share a host. The [installation-scoped Provider](../../apps/controller/src/drivers/egress-proxy/openshell-prepared-git-provider.ts) imports wildcard Git and API routes, and OpenShell combines matching allows. Adding a narrower rule leaves the wildcard effective. An endpointless Provider lets the Sandbox policy be the sole source of network access.

<a id="scope"></a>

## Goals

- **G1. Enforce Git grants for every client through native OpenShell rules.** A push to A or a request to C stops before the origin receives HTTP; allowed Git operations work without a per-request OCE authorization callback.
- **G2. Bind access to the deployed Agent revision.** An Admin can withdraw grants and verify retirement of the old Sandbox without affecting a peer.
- **G3. Support issue reads and pull requests through REST.** A bundled skill uses explicitly authorized routes. Git-only grants stay API-denied across upgrades.

## Non-goals

Repository grants cover inspected HTTPS. Branch-specific grants, GraphQL and credential issuance are outside this decision. Preserve [existing profiles](../../docs/reference/repository-credentials/access-levels.md), stronger ref and operation restrictions, and the legacy credential lifecycle. Installation grants depend on App coverage, selected `github-repository` grants retain their token permissions, and `git-and-draft-pr` retains its approved draft and refs. A network grant can narrow existing credential authority; it cannot widen it or replace a stronger grant with repository-wide access.

<a id="design"></a>

## Proposal

### Architecture

The proposed deployment path binds one saved policy version to one Agent revision. Dashed arrows show the new grant checks.

```mermaid
---
config:
  theme: base
  htmlLabels: true
  themeVariables:
    fontSize: 14px
    primaryTextColor: "#344054"
    lineColor: "#8B949E"
    edgeLabelBackground: "#FFFFFF"
  flowchart:
    curve: linear
    nodeSpacing: 28
    rankSpacing: 32
    padding: 14
---
flowchart TB
  Admin["<b>Admin</b><br/>A read, B write"]
  Repo["<b>Repo Driver</b><br/>Delegated repositories"]
  OCC["<b>Control plane</b><br/>Admitted Agent revision"]
  Worker["<b>Worker and Compute</b><br/>Sandbox placement"]
  Driver["<b>Sandbox Driver</b><br/>Compile and verify rules"]
  Shell["<b>OpenShell</b><br/>Active policy generation"]
  Admin -.->|save and deploy| OCC
  Repo -.->|approve grants| OCC
  OCC -.->|freeze grants| Worker
  Worker -.->|prepare revision| Driver
  Proxy["<b>Credential Proxy</b><br/>Provision and rotate credential"]
  Proxy -.->|attach endpointless Provider| Shell
  Driver -.->|install rules and bindings| Shell
  Shell -.->|report loaded policy| Driver
  classDef actor fill:#F1EEF5,stroke:#A091AD,color:#3A3243,stroke-width:1px
  classDef gate fill:#F7F1E5,stroke:#B3A078,color:#514532,stroke-width:1px
  classDef state fill:#EAF0F6,stroke:#879FB7,color:#344054,stroke-width:1px
  class Admin actor
  class Repo,Worker,Driver gate
  class OCC,Shell state
  linkStyle default stroke:#8B949E,stroke-width:1px
```

1. **Save.** OpenClaw Control Plane (OCC) checks the caller and Driver support, including on the first save of `[]` (deny all). The Repo Driver intersects Installation delegation with canonical [Namespace registrations](../../apps/controller/src/drivers/repo/github/access/registry.ts). Read requires an allowed profile with Contents read or write. Repository-wide write requires existing Contents write authority without a narrower push-ref restriction. App coverage alone cannot admit an unregistered repository. An absent policy preserves legacy behavior; an explicit empty list remains deny-all.
2. **Deploy.** OCC rechecks authority and freezes grants, source and delivery path. The Worker checks the actor and Drivers before dispatch. Refuse native Git if a source restriction requires online authorization. Verify the loaded policy and active generation before release. For `[]`, omit the Provider or refuse launch.
3. **Withdraw.** Saving changes desired access. A downgrade completes once every Sandbox with the old grant has retired. If support is lost, allow authorized grant removal and Stop. If redeployment cannot enforce the withdrawal, the operator must Stop and verify retirement. Retire affected Sandboxes before workspace reuse or repository rename, transfer, deletion or path reuse.

### Request lifecycle

The Credential Proxy attaches a Provider whose profile has `endpoints: []`. The Sandbox Driver writes each inspected repository endpoint and sets [`credential_binding.provider`](https://docs.nvidia.com/openshell/v0.1.8/how-it-works/providers/profiles#understand-static-credential-endpoint-binding) to that attached instance. Scope the endpoint selector to the repository path and set enforcement to `ENFORCE`. Its rules constrain methods and Git service queries. Read back the complete effective policy and bindings, including sibling Providers. Rotation must preserve zero Provider endpoints and the exact Sandbox grants.

Proposed Git flow after deployment:

```mermaid
sequenceDiagram
  participant Client as Agent client
  participant Shell as OpenShell
  participant Origin as GitHub
  Client->>Shell: Request over inspected HTTPS
  alt Route outside the active grant
    Shell-->>Client: Denied before forwarding
  else Route allowed
    Shell->>Shell: Inject managed credential
    Shell->>Origin: Authenticated request
    Origin-->>Shell: Result
    Shell-->>Client: Result
  end
```

**Git.** On the exact verified Git origin, read allows GET `/{owner}/{repo}.git/info/refs?service=git-upload-pack` and POST `/{owner}/{repo}.git/git-upload-pack`. Write adds the corresponding `git-receive-pack` requests without requiring an assigned branch. Reject mixed services, ambiguous paths, aliases and redirects. The [stock matcher](https://github.com/NVIDIA/OpenShell/blob/v0.1.8/crates/openshell-supervisor-network/data/sandbox-policy.rego#L761-L817) accepts HEAD for GET, repeated identical service values and extra keys. Check their effects under AC-3.

### What can the Agent do on GitHub?

The Agent can **list and read issues** and **open pull requests** through GitHub’s REST API. Each operation requires both the Agent’s repository grant and the corresponding GitHub permission. For example, suppose the Namespace enables issue reads and PR creation for A and B. The Admin gives this Agent read access to A, write access to B, and no access to C.

| Agent action                          | A (read) | B (write) | C (no grant) |
| ------------------------------------- | -------- | --------- | ------------ |
| Clone or fetch code                   | Yes      | Yes       | No           |
| List issues or read one issue         | Yes      | Yes       | No           |
| Push a branch                         | No       | Yes       | No           |
| Open a PR (draft or ready for review) | No       | Yes       | No           |

**Enabling API access.** The operator sets [`scopedRest: "v1"`](https://github.com/openclaw/openclaw-enterprise/pull/6716) on each participating `github-repository` Namespace registration, rebinds the credential and redeploys the Agent. Issue reads require at least **Issues: read**. Opening a PR requires **Pull requests: write**. For a repository with a scoped Git grant, leaving REST disabled permits only the granted Git operations. Issue writes, PR merges and GraphQL are outside this grant.

**Why PR creation needs a body check.** For this pilot we propose letting an Agent open a fresh PR between branches in B while keeping C inaccessible and issues read-only. GitHub’s [create endpoint](https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request) accepts a fork head or converts an issue on the same POST with the same permission. OpenShell can restrict the destination to B. Only the body identifies the source and any issue to convert.

OpenShell admits `GET /issues`, `GET /issues/{number}` and `POST /pulls` under the authorized repository on `api.github.com`. Recheck redirects. For the PR POST, the [Worker-hosted Credential Proxy hook](https://github.com/openclaw/openclaw-enterprise/blob/1d2f37d8af5c01178e9092ec1e7d7849bce/apps/controller/src/drivers/egress-proxy/openshell-git-runtime.ts#L2394-L2451) runs the [Repo Driver’s body check](https://github.com/openclaw/openclaw-enterprise/blob/1d2f37d8af5c01178e9092ec1e7d7849bce/apps/controller/src/drivers/repo/github/access/routes/request-selection.ts#L213-L300) before credential injection. Require unqualified head and base branches. Reject `head_repo` and `issue`. Refuse PR creation if the validator is unavailable. Scope the hook to PR creation. If the adapter cannot isolate it, leave PR creation disabled on native delivery.

Codex discovers the [bundled skill](https://github.com/openclaw/openclaw-enterprise/pull/6658) automatically. It teaches stock `gh api` and grants no access. Use a JSON file with `--input` for writes, and verify the remote result before retrying. Draft-only grants retain their ref-constrained client.

### Which delivery paths need an OCE hook?

| Delivery path                                                                                                        | Startup nonce | OCE check on a request                                    |
| -------------------------------------------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------- |
| Proposed native Git, with optional issue reads                                                                       | None          | None. OpenShell enforces the bound routes.                |
| Proposed native Git with PR creation                                                                                 | None          | PR POST body only. Git and issue reads stay local.        |
| Existing protected `git-write`                                                                                       | Required      | Exact ref and optional `git-and-draft-pr` restrictions.   |
| Existing protected `github-repository`, including [#6716](https://github.com/openclaw/openclaw-enterprise/pull/6716) | Required      | Worker checks each permitted request against the binding. |
| Existing `github-installation` preview                                                                               | Required      | Worker hook in the single-Sandbox workspace.              |

Native attachment binds a credential to an endpoint. The [existing protected paths](../../docs/reference/repository-credentials/protected-openshell-git.md) also require proof that a request from the held launcher reaches the authenticated Worker hook before credential release. The launcher sends a one-use nonce on an admitted discovery path. The hook binds it to the Sandbox, workspace, binding, path and generation. The launcher must receive the matching denial before release, with zero upstream requests. Preserve these paths and their limits (1 MiB upload-pack, 4 MiB receive-pack) for existing grants. Token Service retains custody and renewal for its sources. The Agent receives a placeholder.

## Interface changes

### APIs

Under `/namespaces/{namespaceId}/agents/{agentId}`, extend the existing [routes](../../packages/contracts/src/api/routes.ts) and [policy schemas](../../packages/contracts/src/api/sandbox-policy.ts). The policy path below is `/sandbox-policy/networking`.

| Change  | Operation                                        | Behavior and contract change                                                                                                                                                                                                       |
| ------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Changed | PUT policy, POST policy `/validate`              | Add optional `repositoryNetworkPolicy`, a list of `{ repository, access }` with `read` or `write`. Keep `expectedVersion`. Omission preserves the saved value, including absence for legacy Agents. Preview checks without saving. |
| Changed | GET policy                                       | Return saved grants and version, Driver capability, deployed revision, active generation and enforcement state.                                                                                                                    |
| Changed | POST `/deploy`, `/deploy-first`, policy `/apply` | Deploy admits the saved list. Refuse live apply when the saved or active revision has a list.                                                                                                                                      |

### IAM

| Operation                          | Required permission and scope                                                                                                                         | What changes                                                                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Read / edit                        | Read requires `read` on the Agent and its SandboxPolicy. Validate and save require enabled editing, Agent `manage_policy` and SandboxPolicy `update`. | Reuse [exact-resource checks](../../docs/reference/sandbox-policies.md#authority-and-admission).                                  |
| Deploy with a list, including `[]` | Agent `deploy` and `manage_policy`, SandboxPolicy `read` and `update`                                                                                 | Compose existing permissions and [recheck the actor](../../apps/controller/src/worker.ts) at dispatch. Stop uses Agent `operate`. |

### Database entities

| Entity                                                                                | Change                                       | Persistence semantics                                                   |
| ------------------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------- |
| [`occ.sandbox_policies.document`](../../migrations/0058_sandbox_policies.sql)         | Extend the JSON validator and version guard. | Preserve absence, `[]` and nonempty lists across unrelated edits.       |
| [`occ.agent_revisions.admitted_spec`](../../packages/occ/src/state/postgres-state.ts) | Snapshot the list in `sandbox_policy`.       | Immutable per revision. Refuse dispatch through an incompatible reader. |

### Driver contracts

- [Repo](../../packages/contracts/src/drivers/repo/index.ts) resolves each canonical repository and approves its access level. [Compute](../../packages/contracts/src/drivers/compute/index.ts) admits a placement that can enforce the frozen grants.
- [Sandbox](../../docs/reference/drivers/sandbox.md#optional-network-policy-operations) compiles repository routes, sets explicit Provider bindings and verifies the active policy. [Credential Proxy](../../docs/reference/drivers/credential-proxy.md) provisions and rotates the attached endpointless Provider. Its profile contributes zero network allowances.

## Simplifications

The smallest Git delivery reuses the policy editor, revision snapshot, managed Provider and OpenShell matcher. It needs no repository ACL service or per-request OCE authorization. REST qualifies separately because PR body restrictions need trusted enforcement. No existing credential infrastructure is retired.

## Acceptance Criteria

Use a disposable installed OpenShell environment, an authorized Admin and regular saved Agents. Record the revision, policy generation, client outcome, origin observations and OCE authorization-callback attempts. Identify a controlled origin or live GitHub for each result.

- **AC-1 (G1).** Register A/B/C and select one broad synthetic credential valid for all three. Confirm the callback counter increments on a legacy request. Disable only the Worker’s Git authorization callback and reset the counter. Through the admin API, save and deploy a permissive native policy. Verify a normal A push, A receive-pack discovery and direct RPC, and discovery and direct RPC for both C services reach the origin. Count discovery and RPC separately. On the same Agent, save A read/B write, omit C and redeploy with the same credential and client. Clone and fetch A/B, push B and verify the remote commit by fresh fetch. Repeat every forbidden operation and require an OpenShell denial with zero upstream HTTP sends. The callback counter must stay at zero throughout both native phases.
- **AC-2 (G2).** With the Git callback still unavailable, downgrade B to read and redeploy the same Agent. Require zero callback attempts. Verify retirement, fresh fetch, a distinct denied push, zero forbidden HTTP and an unchanged remote ref. Repeat A push and C denials. Save `[]`, make an unrelated edit, verify persistence and redeploy. Prove retirement and launch refusal or denial of previously allowed discovery/RPC before forwarding. If deploy is refused, Stop and prove retirement. Check unsupported first save, lost authority and authorized withdrawal. In a separate control with the callback available, verify legacy fetch on an Agent with policy omitted.
- **AC-3 (G1, G3).** In Git-only mode, calibrate observation with permitted traffic. Require direct REST and GraphQL denials with zero upstream HTTP. Exercise direct TLS/IP, matcher variants, mixed services, aliases and redirects. Any unauthorized forwarding or credential disclosure blocks release.
- **AC-4 (G2).** At save and deploy, reject an unregistered App-covered path and write above the Namespace or selected credential ceiling. Before release and after rotation, verify zero Provider endpoints, exact Sandbox bindings and the active generation. Refuse missing or invalid credentials, unexpected source changes, wrong bindings, broader sibling allows, opaque TLS and stale or unverifiable policy. Repeat AC-1 after rotation with no startup nonce or Git callback. For protected delivery that requires a probe, verify it reaches the hook under the final rules with zero origin requests. Refuse replay, stale proof and wrong recipients. Verify existing ref and draft restrictions.
- **AC-5 (G2).** Independently admit a peer in a separate workspace and verify its permitted operations after the first Agent’s downgrade. Preserve singleton preview admission and verify retirement before workspace reuse. Shared placement requires separate proof of recipient isolation.
- **AC-6 (G3).** Through the bundled skill’s documented clients, read A’s issue list and detail, create one normal PR in B and independently verify its number, repository, head, base and draft status. Verify draft-only access with the existing ref-constrained client. Deny A creation, all C access, fork heads, issue conversion, issue writes and GraphQL before forwarding. Verify that the trusted hook enforces body restrictions for direct clients and refuses creation when unavailable. Verify redirects and continued API denial after a Git-only upgrade or without REST authorization. On a revision with both grants, disable the REST hook and repeat the native Git allow/deny checks. Git and issue reads must succeed without OCE callbacks while PR creation is refused.

## Delivery and verification

Develop Git and REST in parallel. Require installed AC-1–AC-5 for native Git and AC-6 for REST. Keep existing Agents on their current credential delivery until equivalent protections pass. Controlled-origin runs provide partial evidence:

- [#6588](https://github.com/openclaw/openclaw-enterprise/pull/6588) verified native Git and downgrade on stock OpenShell 0.1.8 with a directly attached Provider that supplied endpoint rules. The endpointless design needs an installed run with explicit Sandbox bindings.
- [#6764 at `c94ba932`](https://github.com/openclaw/openclaw-enterprise/pull/6764) passed 46/46 on k3d. It exercised saved-Agent Git, downgrade, retirement, a separate peer and selected REST operations. Allowed requests still used the [legacy Worker authorization callback](https://github.com/openclaw/openclaw-enterprise/blob/c94ba932c5ea7f9be4669fcaafe6ce47ee8fdf82/apps/controller/src/drivers/egress-proxy/openshell-online-git-authority.ts#L212-L217), and the peer used a distinct credential. This is workflow evidence, not acceptance of native network-only Git or the same-credential permissive control.
- [#6658](https://github.com/openclaw/openclaw-enterprise/pull/6658) recorded 49/49 on a combined amd64 build with the earlier opt-in skill. Automatic discovery and the revised commands need a fresh installed test. Live GitHub qualification is pending.

<a id="alternatives-and-open-decisions"></a>

## Rationale and alternatives

Token permissions alone cannot express different network grants for Agents sharing installation coverage. A CLI wrapper leaves other clients unconstrained. A per-request Worker authorizer could enforce Git policy, but it adds an online dependency the native OpenShell matcher does not need. REST PR body restrictions still require a trusted validator.

## Personal access token amendment (2026-11-22, proposed)

Proposed in [issue #6993](https://github.com/openclaw/openclaw-enterprise/issues/6993). An Installation without a GitHub App cannot give an Agent repository access: the [registry](../../apps/controller/src/drivers/repo/github/access/registry.ts) requires `appId` and `githubInstallationId`, and the only static token path for Git is the [development-only backend](../../docs/reference/repository-credentials/development-token.md). This amendment admits one fine-grained personal access token per Installation as the credential behind native Git. It changes only the credential source; rules, bindings, readback and withdrawal remain as above. It depends on native Git delivery ([#6533](https://github.com/openclaw/openclaw-enterprise/pull/6533)). REST, GraphQL and draft PR grants remain App-only.

### Source and scope

- **Source.** One fine-grained token (prefix `github_pat_`) in an Installation-private Secret that only the Worker reads, as for the App key. The Worker classifies the value by prefix on every read and refuses every other class, including classic tokens. OCE makes no GitHub call to register it. The Installation operator registers, replaces and retires it through Installation configuration and the Secret store. No API reads or returns the value.
- **Scope.** The Installation's `repositoryNetworkPolicyCeiling` is the source's explicit list of repositories and access. Effective access is that list, intersected with the Namespace's `github-repository` registration that selects `nativeGit: "v1"` and its `contents` permission, intersected with the Agent's saved list. OpenShell enforces the result per repository path and Git service. GitHub alone enforces the token's own repository selection and permissions, which may be wider or narrower. When they are narrower, GitHub refuses the forwarded request and Git reports GitHub's error.
- **One authority per Installation.** A registry names either the App or the token. No repository is served by both, so no precedence rule is needed.

### Custody, replacement and withdrawal

- **Custody.** The value moves from the Secret to Worker memory to the endpointless Provider. It never enters the workload's environment, files or Git config; the workload sees the Provider's stable placeholder.
- **Loan.** Each delivery is a loan that ends within one hour, the Provider's existing limit, and is renewed. The loan end is the custody `usableUntil` and the Provider's credential expiration time. The issuer never reports a provider expiry for a token, and status and documentation say that the loan ends, not that the token expires. The loan bounds OCE's delivery, not GitHub's acceptance of the token.
- **Replace.** Each renewal reads the Secret's current version, as the App lifecycle does for its key. A replaced value reaches running Agents at the next renewal, within one loan, without a redeploy. The operator revokes the old token at GitHub afterward.
- **Withdraw.** Narrowing an Agent's list follows **Withdraw** above: redeploy, verify the new policy by readback, and complete once the old Sandbox and its credential have retired. Removing every repository requires Stop until the OpenShell path can keep an Agent running without Git, as the prepared route does after [#6898](https://github.com/openclaw/openclaw-enterprise/pull/6898).
- **Retire.** Withdraw the source's Agents, then remove the source. A revision whose source was removed receives no renewal, so its loan lapses within an hour; Stop retires it as lost authority. OCE cannot revoke a token at GitHub. Withdrawal replies and documentation state this.

### Refusals

Registry load refuses a token source with any registration lacking `nativeGit: "v1"`, a profile other than `github-repository`, `installationAccess`, standing approvals, `pushRefAllowlist`, `transport`, draft PR options, scoped REST or GraphQL. Each needs enforcement the network policy cannot provide for a token. A loan with the wrong token class fails with a named diagnostic, and deployment waits for credential material as it does for an unreadable App key.

### Attribution and audit

GitHub attributes commits, pushes and its audit entries to the token's owner, not an App. OCE records each loan, renewal and withdrawal with the source, Secret reference and the mounted Secret file's generation, Namespace, Agent, revision, repositories and times. It never records the value or a digest of it.

### Interface changes for this amendment

- **APIs and IAM:** No changes.
- **Database entities:** None. The token gets no prepared-token row: each loan is derived from the source, the loan window and the mounted Secret file's generation. Without a row there is no row lock against a concurrent retirement; the live-session lock alone guards it.
- **Driver contracts:** The Repo Driver registry gains the token authority. The Sandbox rule compiler and the Credential Proxy accept the token's Provider in place of the installation Provider. The prepared-token kinds are unchanged.
- **Installation configuration:** One Helm value names the token Secret and its key, as `repositoryCredentials.appKeySecretName` does for the App key. Only the Worker mounts it.

### Decisions for review

Each decision is independent.

1. Admit a fine-grained token as a supported production source for native Git.
2. Choose the registry shape. Recommended: a discriminator that replaces the App fields, with the Secret named by a Helm value as the App key is. The chart mounts Secrets into the Worker and does not read the registry, so a Secret name in the registry would need a second copy in the values and a check that both agree.

   ```json
   "authority": { "kind": "github-token" }
   ```

   ```yaml
   repositoryCredentials:
     tokenSecretName: repository-token
     tokenKey: token
   ```

3. Require no database migration and no new prepared-token kind.

### Acceptance criteria for this amendment

- **AC-8 (G1, G2).** On a saved Agent whose Installation uses a fine-grained token source, repeat AC-1 and AC-2 for Git. Search the workload's environment, files, Git config and process arguments for the token by digest and find none. Replace the Secret value; verify that the next renewal delivers it without a redeploy and that the origin observes the new value. Narrow the list; verify denial before forwarding, Provider readback and the Agent still running. Verify refusal of a classic token and of each refused registry option.
