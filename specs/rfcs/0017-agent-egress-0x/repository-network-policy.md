---
rfc: index.md
---

# Per-Agent repository network policy

## Problem and decision

The [Sandbox network grant](../../../packages/contracts/src/sandbox-policy.ts) selects a binary, host and ports. The [installation Git Provider](../../../apps/controller/src/drivers/egress-proxy/openshell-prepared-git-provider.ts) permits Git transport across repositories on the same host. Neither expresses a distinct network permission for each repository.

Propose an opt-in restriction on [Agent egress](index.md). An Admin grants one Agent read access to repository A and write access to B. Unlisted C is denied. OpenShell must enforce those limits even if the credential permits more. The Agent gets only a placeholder. [RFC-0022](../0022-driver-configuration-contributions.md) governs configuration ownership.

## Native Git v1

| Grant    | Operations     | Git service                             |
| -------- | -------------- | --------------------------------------- |
| Read     | Clone, fetch   | `git-upload-pack`                       |
| Write    | Read plus push | Both upload-pack and `git-receive-pack` |
| Unlisted | None           | Neither                                 |

For each permitted service, allow GET `/{owner}/{repo}.git/info/refs?service={service}` and POST `/{owner}/{repo}.git/{service}` on the exact GitHub origin. Require inspected HTTPS, explicit enforcement and default deny.

- **Admission.** Reuse Admin repository choices. Check policy-edit authority, Namespace grants and Installation delegation at save and deploy. Reject ambiguous or excessive grants. Omission preserves legacy behavior. An explicit empty list denies all repositories, including after redeploy. Omit the Git provider or refuse launch when it cannot represent deny-all. Never fall back to the legacy profile.
- **Capability.** The selected Sandbox Driver must declare support for repository policy. If it cannot enforce an explicit policy, including an empty list, refuse admission or deployment with an actionable unsupported-policy error.
- **Composition.** Freeze canonical grants, profile and policy identity in the revision. Matching allows combine, so the Sandbox Driver must narrow the credential-bearing route itself. Replace wildcard Git and remove full REST and GraphQL access in this mode. Reject conflicting routes, including live additions. Preserve credential middleware, recipient checks and the startup probe denied before forwarding.
- **Release.** Before Agent traffic, verify the complete loaded policy, including Provider rules, against the revision and active generation. Block release on mismatch, incompatible workers or changes to the admitted proxy plan or Harness credential source.
- **Readback.** Show the Admin the admitted revision, canonical grants, Driver capability, active generation and effective inspection and enforcement state.

## v1 limitations

- Grants identify the exact GitHub owner/name path for a deployment. A different repository created at that path inherits its network access. Use v1 only where administrators can keep names stable for the full lifetime of the grant. Retire affected sandboxes before a rename, transfer, deletion or path reuse. Revalidate the new repository and deploy a new grant. Where stable object identity is required, refuse this mode until an independent identity check is available.

- HTTPS Git only. No branch ACL, SSH, LFS or API access. Submodule repositories need their own grants. GitHub branch protections still apply.
- Saving an ACL does not revoke running access. Stop all sandboxes with the old grant, or deploy a replacement and verify their retirement. Recheck authority before rollback or resume. Credential revocation remains independent.
- Network grants only narrow existing authority. Selected repositories share one token permission map. Never widen issuance or implicitly select [installation access](../0023-egress-proxy-credential-lifecycle/github-installation-access.md). Qualify each credential arrangement separately.
- The [stock matcher](https://github.com/NVIDIA/OpenShell/blob/v0.1.8/crates/openshell-supervisor-network/data/sandbox-policy.rego#L761-L817) may admit HEAD for GET, identical repeated service values or extra query keys. Record accepted variants. Any unauthorized forwarding or credential disclosure blocks release.

## Installed acceptance

Use a disposable installation with a disposable credential independently verified to permit A push and C access. Calibrate origin counters with allowed traffic. Deploy the grants above through the Admin workflow.

1. Clone/fetch A and B. Push B and independently verify the remote ref. For A push and all C Git operations, require OpenShell denial and zero forbidden origin requests for both discovery and direct RPC.
2. Repeat denials outside Git. Exercise conflicting and identical query duplicates, HEAD, extra keys, redirects, aliases, direct IP, REST and GraphQL. Reject broader or stale policy at startup and widening live updates. Verify credential non-disclosure.
3. Downgrade B to read, redeploy and retire old sandboxes. Verify fetch succeeds and push is denied. Fixture success alone does not qualify production credential delivery.

## Proposed REST CLI follow-up

Ship separately from native Git. Propose thin commands using `gh api` with explicit `--repo OWNER/REPO` on the wrapper. Git permission alone never enables API access.

| Proposed command                     | REST route under `/repos/{owner}/{repo}` | Requires                      |
| ------------------------------------ | ---------------------------------------- | ----------------------------- |
| `issues list` / `issues view NUMBER` | GET `/issues` or `/issues/{number}`      | Read and Issues read          |
| `pr create --draft`                  | POST `/pulls`                            | Write and Pull requests write |

The proxy enforces origin, repository, method, path and allowed query keys for every client. Reuse [draft validation](../../../apps/controller/src/drivers/repo/github/access/routes/request-selection.ts) for bounded JSON, draft status, same-repo head and approved base. Refuse unknown fields and fork heads. Disable creation if validation is unavailable. Deny other APIs and GraphQL. Ordinary `gh pr create` is outside this contract.

Qualify issue reads on A, draft creation on B and pre-origin denial for A mutations, C access and invalid bodies, even when bypassing the CLI.
