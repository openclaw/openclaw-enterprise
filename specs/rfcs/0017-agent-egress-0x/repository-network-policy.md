---
rfc: index.md
---

# Per-Agent repository network policy

## Summary

An Admin lets a saved Agent fetch A/B, push and create PRs in B, and read A issues, while denying C. Native OpenShell network policy enforces SandboxPolicy grants; the Credential Proxy retains credential custody and injection.

## Motivation

The [Sandbox grant](../../../packages/contracts/src/sandbox-policy.ts) selects a binary, host and ports. The installation-scoped [Git Provider](../../../apps/controller/src/drivers/egress-proxy/openshell-prepared-git-provider.ts) imports wildcard Git/API routes. OpenShell combines matching allows; narrower rules cannot restrict that wildcard.

## Proposal

Add optional `repositoryNetworkPolicy` grants `{ repository, access: read | write }`. Omission keeps legacy behavior; omission during update preserves the saved value. `[]` requests deny-all; saving it does not revoke running access. OCC checks authority, delegation and Driver support before first save, including `[]`; refuse unsupported deny-all. Preserve presence in storage and freeze canonical grants in each Agent revision. Recheck delegation and policy IAM at deploy; the Worker rechecks the actor and Compute capability before dispatch. Loss of support must not prevent removing grants or Stop. If deployment cannot withdraw access, explicitly Stop and prove Sandbox retirement.

At save and deploy, the Repo Driver intersects Installation delegation with canonical Namespace [registrations](../../../apps/controller/src/drivers/repo/github/access/registry.ts). An allowed profile must provide Contents read or write for read, or Contents write without a push-ref allowlist for repository-wide write. App coverage cannot authorize an unregistered path.

The Sandbox Driver compiles grants into native policy and validates the complete loaded policy against the revision and active generation before release. Replace the Provider-imported credential wildcard and remove overlapping allows, or refuse deployment. Refuse stale, broader or uncertain policy, unsafe live updates, changed credential sources, direct-socket bypasses and opaque TLS. Retire superseded Sandboxes before reporting a downgrade complete.

Use inspected, verified HTTPS to the exact Git origin. Read permits GET `/{owner}/{repo}.git/info/refs?service=git-upload-pack` and POST `/{owner}/{repo}.git/git-upload-pack`. Write also permits the corresponding receive-pack requests. Reject mixed services, aliases, redirects and ambiguous paths. The [stock matcher](https://github.com/NVIDIA/OpenShell/blob/v0.1.8/crates/openshell-supervisor-network/data/sandbox-policy.rego#L761-L817) accepts HEAD for GET, identical service duplicates and extra keys. Test these variants for bypass. Do not assume strict query cardinality. Retire affected Sandboxes before repository rename, transfer, deletion or path reuse.

Do not add repository ACL middleware or require a startup challenge solely for network policy. Where the selected protected credential delivery already requires a held probe, use an exact permitted upload-pack discovery path with a single-use nonce and no credential. Its authenticated hook binds the denial to the held Sandbox, workspace, binding, path, nonce and generation, denies before forwarding and permits release only on fresh matching proof. Refuse stale or replayed proof. For `[]`, omit the Provider or refuse launch. Preserve existing recipient, credential-currentness, fence, expiry, withdrawal, scope, ref, operation and body checks where the selected delivery uses them. Its existing authorizer limits upload-pack bodies to 1 MiB and complete receive-pack requests to 4 MiB. Qualify that path accordingly. Credential scope remains independently owned by [RFC-0022](../0022-driver-configuration-contributions.md) and the [credential contracts](../../../docs/reference/repository-credentials.md).

## Compatibility

Keep existing Agents on their current path until equivalent operations pass.

| Operation     | Existing delivery with policy omitted                               | Scoped Git-only | Scoped Git and REST                                       |
| ------------- | ------------------------------------------------------------------- | --------------- | --------------------------------------------------------- |
| Clone / fetch | Contents read or write                                              | A and B         | A and B                                                   |
| Push          | Contents write and applicable ref restrictions                      | B               | B                                                         |
| Read issues   | API-capable grant with Issues read                                  | Denied          | Repository read and Issues read                           |
| Create PR     | API-capable grant with Pull requests write, or approved exact draft | Denied          | Repository write and Pull requests write; normal or draft |

[Selected `github-repository` grants](../../../docs/reference/repository-credentials/protected-openshell-git.md) use token permissions; installation grants depend on App coverage. Git-only policies exclude APIs and must not gain REST on upgrade or absent authorization. Preserve existing ref and `git-and-draft-pr` restrictions; never widen tokens. New repository-wide grants need no assigned branch or draft.

Expose one discoverable working path per operation, such as stock `gh api`. Native OpenShell TLS policy defaults to deny and checks the exact `https://api.github.com` origin, canonical repository, method and route. GET `/repos/{owner}/{repo}/issues` or `/repos/{owner}/{repo}/issues/{number}` requires repository read and independently authorized Issues read; POST `/repos/{owner}/{repo}/pulls` requires repository write and Pull requests write. Deny issue writes, unrelated APIs and GraphQL. Direct clients face identical restrictions; skills confer no authority.

The [PR endpoint](https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request) targets a repository and its base; `head` or `head_repo` can refer to a fork. Trusted checks must confine the head to the target repository and reject issue conversion (`issue`); otherwise disable creation. Preserve independently approved credential scopes. Recheck redirects before forwarding. Use a client without automatic POST resend on 307/308. Do not blindly retry ambiguous mutations or promise exactly-once creation.

## Interface changes

### APIs

Extend existing Agent SandboxPolicy save/read and deployment interfaces with grants and enforcement readback: saved version, revision, capability, generation and state.

### IAM

Reuse Agent `manage_policy` and SandboxPolicy `update` for save. Deployment requires both plus SandboxPolicy `read` and Agent `deploy`. Recheck the original actor before dispatch. No new permission.

### Database entities

Persist grant presence and values in SandboxPolicy and immutable Agent revisions. Distinguish omission from `[]`.

### Driver contracts

Extend Sandbox capability, compilation and complete-policy validation. Require Provider wildcard replacement and Repo registration/profile resolution.

## Simplifications

Reuse OpenShell rules and existing credential protections. Add no ACL service, middleware, network-only challenge or credential dependency.

## Acceptance Criteria

- **AC-1:** In a disposable installed environment, save and deploy a regular Agent with A read/B write. Register C but omit its grant. With the same broad synthetic A/B/C credential, client and selected legacy hook, prove normal A push, A receive-pack discovery/direct RPC, and both C services' discovery/direct RPC reach the origin under permissive policy. Calibrate HTTP observation separately for discovery and RPC. Under restricted policy, clone/fetch A/B and verify B push by remote OID and fresh fetch. Deny normal A push, A receive-pack discovery/direct RPC, and both C services' discovery/direct RPC, with zero forbidden upstream sends.
- **AC-2:** Downgrade B to read on the same Agent and redeploy. Verify retirement, fresh fetch, a denied distinct push before upstream HTTP and unchanged remote ref. Repeat A push and C denials; verify legacy fetch with policy omitted. Save `[]`, verify persistence across an unrelated save and redeploy. If deployment is refused, explicitly Stop and prove retirement; otherwise prove retirement and launch refusal or denied formerly allowed discovery/RPC with zero upstream HTTP. Check unsupported first save, lost authority and withdrawal.
- **AC-3:** In Git-only mode, send REST and GraphQL requests directly and require denial with zero upstream HTTP. Calibrate the observation with permitted traffic. Exercise direct TLS/IP, query variants, mixed services, aliases and redirects. Any unauthorized forwarding or credential disclosure blocks release. Record whether the origin was controlled or live GitHub.
- **AC-4:** Refuse an unregistered path even if the App covers it, and refuse write above the Namespace ceiling at save and deploy. For protected delivery, prove the held probe reaches its hook under the final narrow policy with zero origin requests. Reject nonce reuse, wrong recipient, broader sibling rules and expired generation.
- **AC-5:** Independently admit a second Agent in a separate workspace and confirm its allowed access survives the first Agent's downgrade. Preserve singleton preview admission. Retire the old Sandbox before workspace reuse. Shared placement needs separate recipient-isolation proof.
- **AC-6 (REST):** Using discoverable working client paths, read A's issue list/detail and create one normal or draft PR in B; independently read it back and verify its target, head and validity. Deny A creation, all C access, cross-repository heads, issue conversion, issue writes and GraphQL before forwarding. Prove direct-client bypasses fail, redirects are rechecked, and Git-only policies remain API-denied after upgrade or absent REST authorization.

## Delivery and verification

Implement Git and REST in parallel. Require installed AC-1–AC-5 for Git and AC-6 for REST in the saved/deployed workflow. Protected delivery requires verified topology. An installed k3d run of [#6764](https://github.com/openclaw/openclaw-enterprise/pull/6764) at `c94ba932`, using stock OpenShell 0.1.8 and the official OpenClaw pin from [#6746](https://github.com/openclaw/openclaw-enterprise/pull/6746), passed 46/46 checks for the saved-Agent Git workflow, a separate peer and selected REST operations against a controlled origin. This qualifies the composed test branch for those cases, not the full criteria or live GitHub. The selected legacy authorizer still limits Git push requests to 4 MiB; inspected workspace WebSocket replies are a separate path.
