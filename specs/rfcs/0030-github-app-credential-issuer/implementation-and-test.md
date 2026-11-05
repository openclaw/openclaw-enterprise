---
rfc: index.md
---

# Implementation and installed test

## First implementation PR

Extend OpenShell’s embedded minter registry and refresh engine for one repository and permission tier. Through the workspace-admin `ConfigureProviderRefresh` handler, configure an unattached fixture provider with an invented key. Trigger rotation or a due sweep to exercise the mint. Port OCE’s [scope construction](../../../apps/controller/src/drivers/repo/github/credentials/provider-transport/request-options.ts), [candidate capture](../../../apps/controller/src/drivers/repo/github/credentials/prepared-owner.ts) and [response validation](../../../apps/controller/src/drivers/repo/github/credentials/installation-token-response.ts). The engine must preserve an uncertain attempt when a grant is reconfigured. Its ordinary retry schedule cannot decide whether GitHub issued a token.

- Verify the successful POST contains the exact repository and permissions. Derive mint and revoke URLs from the trusted GitHub instance. Reject endpoint overrides and redirects. With a second test origin, verify it receives neither a request nor a credential.
- Drop the reply after the fixture receives the POST. Restart, advance past retry time, run a sweep, request rotation and reconfigure the same target. Expect one total POST and zero published outputs. In a separate case, return an overprivileged token. Verify zero delivery and revocation of that exact token.

## Connect OCE before cutover

An operator enrolls the App key as issuer-owned secret material, even when a caller omits a secret-field label. OCE supplies an approved signer reference bound to the GitHub instance, App, repository-bearing installation and eligible repository IDs. Reject an enterprise-account installation for this strategy. Keep the private key out of per-Agent configuration. An embedded signer compromise can affect every installation of that App. [Installation types](https://docs.github.com/en/enterprise-cloud@latest/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)

Only the authorized OCE preparation service can configure these grants. The gateway must condition that write on the expected provider instance and generation. Today `ConfigureProviderRefresh` addresses a provider by name. A replacement with the same name must fail at the receiver before it stores material or calls GitHub. Recheck current OCE approval before mint and before activating an output. Test a late reply by pausing a successful mint, withdrawing the grant, replacing the provider under the same name, then releasing the reply. Require zero activations, issuer-owned retirement of the exact token or a recorded uncertain outcome, and a successful request from Agent 2.

The pre-credentials hook can allow a request but cannot rewrite `Authorization` or install a placeholder. The trusted sender must bind the actual target to one approved output on the shared GitHub host. Add sender support if it cannot enforce that binding. Present A’s placeholder on a B request and require denial before forwarding. Verify a legitimate B read selects B’s output. Reject ambiguous targets, including cross-repository GraphQL. [OpenShell request hook](https://github.com/NVIDIA/OpenShell/blob/d9a9196f275eb9eb5146717a11fc0772b1233392/proto/supervisor_middleware.proto#L688-L706)

Prove that Agent identities cannot obtain the token through environment, snapshots or credential export. Privileged gateway administrators belong to the issuer trust boundary. Operators may add path restrictions or disable GraphQL. Anonymous public reads can remain available where allowed.

Remove the OCE signer, exchange wiring and worker key mount after the last callers move and outstanding tokens and operations settle with their original owner. Keep repository policy, OCC’s grant checks and unrelated Token Service and model Gateway paths.

## Recover a missing reply

- **OCE called the gateway.** Persist the operation and expected grant generation first. Within the gateway’s 24-hour success replay window, reuse the original `request_id`, identity, workspace, method and payload. If the window may have elapsed, or admission is unresolved, reconcile the original effects without resending. Before binding, verify the original provider instance, credential key and output. A same-name replacement or unknown result leaves Git unavailable. [Durable gateway request admission](https://github.com/NVIDIA/OpenShell/blob/d9a9196f275eb9eb5146717a11fc0772b1233392/docs/sdk/api-errors.mdx#durable-request-admission)
- **GitHub may have minted.** The issuer records intent before the POST. It can retry a proven unsent call under current approval. Park uncertain attempts across restart, scheduled refresh, manual rotation and reconfiguration. GitHub offers no documented mint deduplication by attempt ID. Quarantine identifiable rejected or superseded tokens for revocation at GitHub. If no token came back, keep the original grant unavailable until the issuer can establish non-issuance or expiry and exclude a late publication. Local deletion or a new grant name cannot settle the old attempt.
- **GitHub may have accepted a push.** The sender reports an unknown outcome. The caller reads the target ref through an authorized path and compares the expected SHA before deciding on another push.

## Installed acceptance test

Use a deployed gateway and supervisor with the mandatory pre-credentials hook. Use one organization installation with access to private A, B and C. Verify independently that C is readable and the App can write the test branches on A and B. Disable alternative credentials. Give Agent 1 A-write and B-read and give Agent 2 an independent A grant.

1. Push a unique commit from Agent 1 to A. An independent reader sees its SHA.
2. Read a known private ref in B. Then try to push to B. The push fails and the remote SHA stays the same.
3. Try to read C from Agent 1. Access fails while the independent reader still reads C.
4. Keep an HTTPS client open and record its connection ID. Withdraw all Git grants from Agent 1 while the material is valid. Repeat a previously allowed request over that connection. Observe the withdrawal denial and zero GitHub requests for the attempt. Get a fresh model reply in the same execution and chat and a fresh private read of A from Agent 2.

For issues, read and update a test issue in A, read one in B, then try to update it. Verify B’s issue is unchanged after the denied write. Record identities, expiry, decisions and ref SHAs without token values. This installed test remains to be run.
