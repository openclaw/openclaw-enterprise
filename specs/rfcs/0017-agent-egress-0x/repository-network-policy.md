---
rfc: index.md
---

# Per-Agent repository network policy

## Summary

An Admin can let a saved Agent fetch repositories A and B, push only B, and deny C even when its credential permits more. Save repository grants on its SandboxPolicy and enforce them through native OpenShell network policy. The Credential Proxy retains credential custody and injection.

## Motivation

The [Sandbox grant](../../../packages/contracts/src/sandbox-policy.ts) selects a binary, host and ports. The installation-scoped [Git Provider](../../../apps/controller/src/drivers/egress-proxy/openshell-prepared-git-provider.ts) imports wildcard Git and API routes. OpenShell combines matching allows, so adding narrower rules cannot restrict that wildcard.

## Proposal

Add optional `repositoryNetworkPolicy` grants `{ repository, access: read | write }`. Omission keeps legacy behavior. Omission during update preserves the saved value. `[]` denies all repositories. OCC checks edit authority, delegation and Driver support before first save, including `[]`. Refuse unsupported deny-all. Preserve presence in storage and freeze canonical grants in each Agent revision. Recheck current delegation and policy IAM at deploy. The Worker rechecks the actor and Compute capability before queued dispatch. Loss of support must not prevent removing grants or Stop. Stop the serving Sandbox if replacement cannot withdraw access.

At save and deploy, the Repo Driver intersects Installation delegation with exact canonical repository registrations in the Namespace [registry](../../../apps/controller/src/drivers/repo/github/access/registry.ts). Read requires an allowed profile with Contents read or write. Repository-wide write requires Contents write without a push-ref allowlist. App installation coverage alone cannot authorize an unregistered path.

The Sandbox Driver compiles grants into native policy and validates the complete loaded policy against the revision and active generation before release. Replace the wildcard on the actual Provider-imported credential route and remove overlapping Git, REST and GraphQL allows, or refuse deployment. Refuse stale, broader or uncertain policy, unsafe live updates, changed credential sources, direct-socket bypasses and opaque TLS. Retire superseded Sandboxes before reporting a downgrade complete.

Use inspected HTTPS with verified TLS to the exact Git origin. Read permits GET `/{owner}/{repo}.git/info/refs?service=git-upload-pack` and POST `/{owner}/{repo}.git/git-upload-pack`. Write also permits the corresponding receive-pack requests. Reject mixed services, aliases, redirects and ambiguous paths. The [stock matcher](https://github.com/NVIDIA/OpenShell/blob/v0.1.8/crates/openshell-supervisor-network/data/sandbox-policy.rego#L761-L817) also accepts HEAD for GET, identical service duplicates and extra keys. Test these variants for bypass. Do not assume strict query cardinality. Retire affected Sandboxes before repository rename, transfer, deletion or path reuse.

Do not add repository ACL middleware or require a startup challenge solely for network policy. Where the selected protected credential delivery already requires a held probe, use an exact permitted upload-pack discovery path with a single-use nonce and no credential. Its authenticated hook binds the denial to the held Sandbox, workspace, binding, path, nonce and generation, denies before forwarding and permits release only on fresh matching proof. Refuse stale or replayed proof. For `[]`, omit the Provider or refuse launch. Preserve existing recipient, credential-currentness, fence, expiry, withdrawal, scope, ref, operation and body checks where the selected delivery uses them. Its existing authorizer limits upload-pack bodies to 1 MiB and complete receive-pack requests to 4 MiB. Qualify that path accordingly. Credential scope remains independently owned by [RFC-0022](../0022-driver-configuration-contributions.md) and the [credential contracts](../../../docs/reference/repository-credentials.md).

## Compatibility

Keep existing Agents on their current path until equivalent operations pass.

| Operation       | Existing delivery with policy omitted                                                           | Scoped Git v1          | Scoped REST follow-up                                     |
| --------------- | ----------------------------------------------------------------------------------------------- | ---------------------- | --------------------------------------------------------- |
| Clone / fetch   | Allowed repositories with Contents read or write                                                | A and B                | Same                                                      |
| Push            | Contents write, subject to applicable ref restrictions                                          | B only until downgrade | Same                                                      |
| Read issues     | API-capable selected or installation grant with Issues read                                     | Denied                 | Repository read and Issues read                           |
| Create draft PR | API-capable selected or installation grant with Pull requests write, or an approved exact draft | Denied                 | Repository write, Pull requests write and validated draft |

[Selected `github-repository` grants](../../../docs/reference/repository-credentials/protected-openshell-git.md) can authorize repository APIs under the token permission map. Installation grants depend on App coverage. Prepared Git-only transport excludes APIs. The `git-and-draft-pr` transport restricts creation to its approved draft. An Agent that relies on issue or PR access would lose it under scoped Git v1. Keep it on its current delivery until its workflows pass.

Recommend Git first. A separately qualified bundled skill uses stock `gh api` for issue GETs at `/repos/{owner}/{repo}/issues` and `/repos/{owner}/{repo}/issues/{number}`, and draft POSTs at `/repos/{owner}/{repo}/pulls`. Trusted validation must reject missing or false `draft`, unauthorized head/base, forks and missing operation or draft allowance before forwarding, including direct REST clients. Deny other API routes and GraphQL. An uncertain creation does not authorize retry.

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

OpenShell decides repository access from the deployed rules. Reuse credential protections in their existing owner. No new ACL service, middleware, network-only challenge or credential delivery dependency.

## Acceptance Criteria

- **AC-1:** In a disposable installed environment, an Admin saves and deploys one regular Agent with A read/B write. Register C in the Namespace but omit its Agent grant. Use synthetic broad fixture material covering A/B/C. With the same credential, client and selected legacy hook, first prove normal A push, A receive-pack discovery/direct RPC, and both C services' discovery/direct RPC reach the origin under permissive policy. Calibrate upstream HTTP observation separately for discovery and RPC. Under restricted policy, clone/fetch A/B and verify a B push by remote OID and fresh fetch. Deny normal A push, A receive-pack discovery/direct RPC, and both C services' discovery/direct RPC, with zero forbidden upstream HTTP sends.
- **AC-2:** Downgrade B to read on the same Agent and redeploy. Verify the old Sandbox retired, a fresh fetch succeeds and a distinct push fails before upstream HTTP. Confirm the remote ref is unchanged. Repeat A push and C access denials. Verify legacy fetch with the policy omitted. Clear the last grant to `[]`, verify it survives an unrelated save, redeploy and confirm old Sandboxes retire. Require launch refusal or denial of formerly allowed discovery and direct RPC with zero upstream HTTP. Check unsupported first save, lost authority, withdrawal and Stop.
- **AC-3:** In Git-only mode, send REST and GraphQL requests directly and require denial with zero upstream HTTP. Calibrate the observation with permitted traffic. Exercise direct TLS/IP, query variants, mixed services, aliases and redirects. Any unauthorized forwarding or credential disclosure blocks release. Record whether the origin was controlled or live GitHub.
- **AC-4:** Refuse an unregistered path even if the App covers it, and refuse write above the Namespace ceiling at save and deploy. For protected delivery, prove the held probe reaches its hook under the final narrow policy with zero origin requests. Reject nonce reuse, wrong recipient, broader sibling rules and expired generation.
- **AC-5:** Independently admit a second Agent in a separate workspace and confirm its allowed access survives the first Agent's downgrade. Preserve singleton preview admission. Retire the old Sandbox before workspace reuse. Shared placement needs separate recipient-isolation proof.
- **AC-6 (REST):** Read A issues and create a B draft through `gh api` and a direct client. Deny A mutations, C access, unauthorized refs, invalid draft bodies and GraphQL before forwarding.

## Delivery and verification

Enable opt-in Git after AC-1–AC-5 pass through the regular saved/deployed Agent workflow. Protected delivery is eligible only on a verified topology. Bundled dedicated Kubernetes remains gated: inspected workspace WebSocket traffic above 4 MiB is unresolved. Qualify REST separately under AC-6. Maintainers must decide whether REST blocks the first release. The recommendation is Git first. No installed acceptance is claimed here.
