---
rfc: index.md
---

# Per-Agent repository network policy

## Problem and decision

The [Sandbox network grant](../../../packages/contracts/src/sandbox-policy.ts) selects a binary, host and ports. The [installation-scoped Git Provider](../../../apps/controller/src/drivers/egress-proxy/openshell-prepared-git-provider.ts) permits Git across repositories on that host. An Admin needs to grant one Agent read access to A and write access to B while denying unlisted C, even when its credential permits more. The Agent receives only a placeholder.

## Native Git v1

Read permits `git-upload-pack` (clone/fetch); write also permits `git-receive-pack` (push). On the exact GitHub HTTPS origin, canonical discovery is GET `/{owner}/{repo}.git/info/refs?service={service}`; canonical RPC is POST `/{owner}/{repo}.git/{service}`. Require inspection, enforcement and default deny.

The [stock matcher](https://github.com/NVIDIA/OpenShell/blob/v0.1.8/crates/openshell-supervisor-network/data/sandbox-policy.rego#L761-L817) may match HEAD as GET, identical duplicate `service` values or extra query keys. Accept these variants only if installed adversarial evidence shows no A push, C access, unauthorized forwarding or credential disclosure. Refuse mixed service values.

- **Save and deploy.** Use the existing Agent SandboxPolicy's optional `repositoryNetworkPolicy` array of `{ repository, access }` grants. Validate edit authority, the current Namespace grants and Installation delegation at both save and deployment. Omission preserves legacy behavior or the previously saved value on update; `[]` denies all. Preserve presence through storage, restart and redeploy. Freeze canonical grants and identity in the Agent revision. Refuse unsupported Drivers or protected execution combinations before credential preparation; preserve existing IAM, version, lock and protected-addition checks.
- **Compose and release.** The Git Provider narrows its credential-bearing route, replacing wildcard Git and removing REST and GraphQL. The Sandbox Driver checks the exact complete loaded policy, including overlapping Provider allows, against the revision and active generation. Refuse stale or broader policy, widening live updates, changed credential sources and bypasses through direct sockets or opaque TLS. Preserve credential middleware, recipient checks and the held startup challenge denied before forwarding. For `[]`, omit the Provider or refuse launch; never restore legacy access. On an uncertain update, deny Git until reconciliation.
- **Readback and revocation.** Show saved version, grants, revision, capability, generation and enforcement state. Saving does not revoke old executions: report a downgrade pending until every superseded execution retires. Recheck authority before rollback or resume.

## v1 limitations

Grants bind a lowercase owner/name path, not repository object identity; retire affected executions before rename, transfer, deletion or path reuse. Refuse v1 where stable identity is required. HTTPS Git only: no branch ACL, SSH, LFS or API; submodules need separate grants. Branch protections still apply. The current authorizer caps upload-pack bodies at 1 MiB and complete receive-pack requests at 4 MiB; qualify push behavior at those limits. Grants cannot widen credential issuance. Credential selection and production qualification remain separate decisions.

## Installed acceptance

Use a disposable installation and synthetic broad credential. First calibrate that the same Agent client and middleware can push A, send A receive-pack discovery and direct RPC, and perform C discovery and direct RPC under a permissive policy. Calibrate trusted observation of upstream sends separately for discovery and direct RPC; use origin counters only at a controlled origin.

Deploy A read/B write. Clone and fetch both. Push B and independently verify its remote ref. Attempt a normal push to A. Independently send receive-pack discovery and a direct receive-pack POST to A, and both services’ discovery and direct RPC to C. Require policy denial and zero upstream sends for each forbidden request. Exercise accepted query variants, mixed services, redirects, aliases, REST and GraphQL. Attempt direct TLS/IP from each covered execution context; verify confinement at a controlled boundary and no credential leak. Reject stale startup policy, unsupported combinations and deployment after authority is lost. Verify a second Agent retains independent grants. Downgrade B, redeploy, verify fetch succeeds and push fails, then confirm old executions retire. Verify omission and `[]` survive unrelated saves and redeploys. With the policy omitted, fetch successfully as a control. Clear the final grant to `[]`, redeploy and confirm superseded executions retire; require launch refusal or denial of discovery and direct RPC for a formerly allowed repository, with no upstream sends. Qualify production separately.

## Proposed REST CLI follow-up

Ship separately: issue GETs at `/repos/{owner}/{repo}/issues` and `/repos/{owner}/{repo}/issues/{number}` require repository read access and Issues read; draft PR POSTs at `/repos/{owner}/{repo}/pulls` require repository write access and Pull requests write. Use bounded repository-scoped commands and enforce these checks before forwarding, even outside the CLI. Before forwarding a draft POST, reuse Repo's draft validation and operation authorization, including any applicable draft allowance. Verify that a direct-client draft POST on read-only A is denied before forwarding; deny other APIs and GraphQL. An uncertain creation is not retry authority.
