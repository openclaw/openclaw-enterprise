---
rfc: index.md
---

# GitHub App integration and acceptance

## First implementation PR

For the first integration, give a running Agent read/write access to repository A and read access to B. The operator makes repositories eligible in the Namespace and the Agent owner selects them in `repositoryBindings`. Today, one permission map applies to all repositories in an Agent’s selection. For the installed test, resolve separate permissions for A and B, covering both code and issues. GitHub enforces branch and tag rules. [Current enrollment](../../../docs/guides/repository-credentials/openshell-enrollment.md)

Start with one repository and one permission tier. Port OCE’s [scope construction](../../../apps/controller/src/drivers/repo/github/credentials/provider-transport/request-options.ts), [candidate capture](../../../apps/controller/src/drivers/repo/github/credentials/prepared-owner.ts) and [response validation](../../../apps/controller/src/drivers/repo/github/credentials/installation-token-response.ts). Use an issuer-owned fixture key to verify the App JWT exchange and the failure cases below. This library change can land before the remote transport. The connected integration runs it in the separate issuer. Keep the OCC repository grant usable for GitLab. App JWTs and GitHub permission names belong in the GitHub strategy.

- Verify the successful POST contains the exact repository and permissions. Derive mint and revoke URLs from the trusted GitHub instance. Reject endpoint overrides and redirects. With a second test origin, verify it receives neither a request nor a credential.
- Drop the reply after the fixture receives the POST. Restart, advance past retry time, run a due sweep and request rotation. Reconfigure the same provider and credential key with a fresh request ID, then run another due sweep and manual rotation. Across all of these steps, expect one total POST and zero published outputs. In a separate case, return an overprivileged token. Verify zero delivery and revocation of that exact token.

## Connect OCE before cutover

Use the proposed `CredentialRefresh.CreateGrant` for grant setup, `CredentialStore.ResolveSecrets` for output resolution and `TokenMinter.Mint` for the GitHub exchange. OCE needs direct signer enrollment. Sending the App key in `CreateGrant.secret_material` through the gateway would violate that boundary. [Proposed issuer contracts](https://github.com/NVIDIA/OpenShell/blob/e7f04cbf5846ce3083bf4f8e479b68e2341cb216/rfc/0023-credential-issuer-service/README.md#credentialrefresh-contract)

For the first connected test, enroll a key at the separate issuer. Start with an approved repository grant and no cached token. Send one permitted Git request through the supervisor proxy. Observe an OCC decision, one issuer-to-GitHub mint, an approved short-lived output returned by OCC, and one send by the proxy. Prove that the credential gateway cannot read the key, obtain a signed App JWT, call the signer or select another installation. A local fixture cannot establish that boundary.

At enrollment bind the signer to the trusted GitHub instance, App, repository-bearing installation, eligible repositories and permission ceiling. Only OCC’s authenticated control-plane resolver or its explicit delegate can request a mint for an approved grant. Enforce these limits for every issuance trigger, including renewal and manual rotation. Reject a proxy that presents a valid workspace identity and signer reference but requests another Agent’s authority. Reject enterprise-account installations for this strategy. Only the issuer needs egress to GitHub’s mint and revoke endpoints. [GitHub installation types](https://docs.github.com/en/enterprise-cloud@latest/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)

Use one proxy-facing OCC resolution operation. Preserve the request identity, credential version, grant checks and deadline that the current metadata path applies across `resolve` and `authorizeSend`. Protected Git currently requires prepared material and a request-phase decision. Lazy issuance on an authorized miss changes that behavior for this integration. The OpenShell pre-credentials hook cannot write `Authorization`; the trusted supervisor needs an injection path that consumes OCC’s response. [Current Credential Proxy contract](../../../docs/reference/drivers/credential-proxy.md#installed-material) · [OpenShell hook](https://github.com/NVIDIA/OpenShell/blob/71da34fc14a09d9350c8ba306424fe158e443cae/proto/supervisor_middleware.proto#L688-L706)

Bind control-plane writes to the expected provider instance and generation. Test two late mints. Withdraw a grant on the same provider instance. Separately, replace the named provider while its grant stays approved. In each case OCC must withhold the stale output. The original issuer owns revocation or records uncertainty. An independent Agent must still succeed.

Control-plane resolution must deny a swapped placeholder, a client-supplied bearer or an ambiguous cross-repository API request. Prove that a legitimate B read gets B’s read credential. Neither Agent credentials, snapshots nor export APIs available to the Agent may reveal a provider token. Additional API path restrictions and disabling GraphQL remain operator options. Public reads can remain anonymous where permitted. Existing `git-write` grants retain their exact-ref restrictions.

Cache an authorization and its credential as a pair, bound to the authenticated execution, grant generation, credential version and authorized request scope. End reuse at the earliest of the OCC-issued TTL deadline, grant expiry and credential expiry. Cache hits never extend it. A B-read entry cannot authorize a B-write, a redirected target or a second Agent. After withdrawal, a positive TTL permits matching sends for the time left on that entry. During a partition, an expired entry fails closed. Optional denial notifications can evict entries sooner; the expiry bound applies even if every notification is lost.

Remove the OCE signer, exchange wiring and worker key mount after the last callers move and outstanding tokens and operations settle with their original owner. OCC retains repository policy and per-Agent grant checks. Retire the other credential paths as each family moves through the [migration plan](../../plans/0030-openshell-credential-service.md).

## Recover a missing reply

- **The proxy lost OCC’s credential response.** Without a usable response the proxy sends nothing. If the request is still eligible, it asks OCC for a fresh decision. OCC checks current access and reuses the known committed output or reconciles the original mint. Test by dropping the response after a successful mint, withdrawing the grant, then retrying resolution. Expect one mint, zero Git sends and a denial. A possible Git send has its own recovery path below.
- **OCC lost the issuer’s reply.** Persist the original issuer, caller, workspace, operation key, grant generation and scope before requesting a mutation. Use the issuer’s agreed idempotency and status contract to recover the original outcome and output reference. A same-name provider or unknown grant stays unavailable. The existing gateway management RPC’s success-replay window applies only to calls through that RPC; the remote issuer needs its own explicit replay semantics.
- **GitHub may have minted.** The issuer records intent before the POST. It can retry a proven unsent call under current approval. Park uncertain attempts across restart, scheduled refresh, manual rotation and reconfiguration. GitHub offers no documented mint deduplication by attempt ID. Quarantine identifiable rejected or superseded tokens for revocation at GitHub. If no token came back, keep the original grant unavailable until the issuer can establish non-issuance or expiry and exclude a late publication. Local deletion or a new grant name cannot settle the old attempt.
- **GitHub may have accepted a push.** The sender reports an unknown outcome. The caller reads the target ref through an authorized path and compares the expected SHA before deciding on another push.

## Local development and CI

For v1, the developer or CI runner checks out the repository and gives the Agent a working tree free of runner credentials. Give the Agent no GitHub credential. It edits, tests and returns a patch without a proxy or cluster. In GitHub Actions, set `persist-credentials: false` and omit runner tokens from the Agent environment. A separate trusted step can publish the patch. Use k3d when testing the Kubernetes deployment and its network policies. [Checkout settings](https://github.com/actions/checkout#usage)

If a job needs live private Git, first try the [existing Compose client and broker](../../../deploy/examples/repository-credentials/compose.yaml). The [development profile](../../../docs/reference/repository-credentials/development-token.md) keeps a host-supplied GitHub token in the broker and gives the client a short-lived repository session. Put the Agent only on an internal network and attach the broker to that network and an outbound network. Keep host networking, runner credentials, and the Docker and broker control sockets out of the Agent. From the same Agent, fetch a known private ref through the broker, then try a direct TCP connection to the GitHub address and port the broker reached. The fetch must succeed and the direct connection must fail. [Compose internal networks](https://github.com/compose-spec/compose-spec/blob/main/06-networks.md#internal)

For managed Git, the [native broker](../../../docs/reference/repository-credentials/prepared-native-git.md#what-a-request-authorizes) serves dedicated Codex on Kubernetes. To use it in plain CI, the runner would need to bind a short-lived session to an admitted Agent execution, deliver it to that job, and demonstrate denial after withdrawal. Defer this work if it requires new workload admission or a general egress proxy. Both live-Git options are optional for v1.

## Installed acceptance test

The OpenShell supervisor is the first sender. Test the same OCC interface with [Strands Box](https://github.com/openclaw/openclaw-enterprise/pull/4007) next. In each managed deployment, verify that a direct connection cannot bypass the trusted sender for a protected request.

Use the separate issuer service, OCC and the OpenShell supervisor proxy. Observe the scoped mint at the issuer and the protected Git request at the sender. Verify a static-source request invokes no minter, a denied cold request invokes no mint, and an unavailable OCC or issuer yields no unauthenticated fallback. Use one organization installation with access to private A, B and C. Verify independently that C is readable and the App can write the test branches on A and B. Disable alternative credentials. Give Agent 1 A-write and B-read and give Agent 2 an independent A grant.

1. Push a unique commit from Agent 1 to A. An independent reader sees its SHA.
2. Read a known private ref in B. Then try to push to B. The push fails and the remote SHA stays the same.
3. Try to read C from Agent 1. Access fails while the independent reader still reads C.
4. With TTL zero, keep an HTTPS client open and record its connection ID. Withdraw all Git grants from Agent 1 while the material is valid. Repeat a previously allowed request over that connection. Observe the withdrawal denial and zero GitHub requests for the attempt. Get a fresh model reply in the same execution and chat and a fresh private read of A from Agent 2.
5. In a separate run with an active grant and a positive TTL, prime only Agent 1’s A-read entry. Isolate its proxy from OCC and withdraw the grant. A matching read may still succeed before the recorded expiry. An A-write must miss and fail. After expiry, repeat the read: the proxy must deny it with zero new GitHub requests. Restore connectivity and verify that OCC still denies it.

Keep the chat running when the operator can verify Git-only detachment and independent model access. Retire the execution if Git access cannot be isolated.

For issues, read and update a test issue in A, read one in B, then try to update it. Verify B’s issue is unchanged after the denied write. Record identities, expiry, decisions and ref SHAs without token values. This installed test remains to be run.
