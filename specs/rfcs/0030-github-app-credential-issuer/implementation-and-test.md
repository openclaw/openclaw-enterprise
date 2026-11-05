---
rfc: index.md
---

# Implementation and installed test

## First implementation PR

Add the embedded GitHub App strategy upstream. Exercise one repository and permission tier through the gateway’s `ConfigureProviderRefresh` entry point. Port OCE’s scope construction, candidate capture and response validation. First verify a successful mint. Then drop a reply after the fixture receives the POST. Restart the gateway, advance past retry time, run a sweep and request rotation. Require one POST and zero published outputs in the ambiguous case. Also check the exact scope sent on a successful mint. Return an overprivileged token in another case and verify exact-token retirement with zero delivery. [Scope construction](../../../apps/controller/src/drivers/repo/github/credentials/provider-transport/request-options.ts) · [Candidate capture](../../../apps/controller/src/drivers/repo/github/credentials/prepared-owner.ts) · [Response validation](../../../apps/controller/src/drivers/repo/github/credentials/installation-token-response.ts)

Before enabling new OCE grants, agree on authenticated preparation, recovery and sender-only delivery. Prove Agent processes cannot read or export the token. Select the right permission group for each request and deny ambiguous targets, including cross-repository GraphQL. Operators can restrict API paths or disable GraphQL. Public reads can remain anonymous where allowed. Retire the OCE signer, exchange wiring and worker key mount after the last callers move and outstanding credentials and operations settle with their original owner. Keep repository policy, OCC’s grant checks and unrelated Token Service and model Gateway paths.

## Recover a missing reply

- **OCE called the gateway.** Persist the operation and expected grant generation first. Within the gateway’s 24-hour success replay window, reuse the original `request_id`, identity, workspace, method and payload. If the window may have elapsed, or admission is unresolved, reconcile the original effects without resending. Before binding, verify the original provider instance, credential key and output. A same-name replacement or unknown result leaves Git unavailable. [Durable gateway request admission](https://github.com/NVIDIA/OpenShell/blob/d9a9196f275eb9eb5146717a11fc0772b1233392/docs/sdk/api-errors.mdx#durable-request-admission)
- **GitHub may have minted.** The issuer records intent before the POST. It can retry a proven unsent call under current approval. Park uncertain attempts across restart, scheduled refresh, manual rotation and reconfiguration. GitHub offers no documented mint deduplication by attempt ID. Quarantine identifiable rejected or superseded tokens for exact-token revocation at GitHub. A local handle deletion cannot revoke the token.
- **GitHub may have accepted a push.** The sender reports an unknown outcome. The caller reads the target ref through an authorized path and compares the expected SHA before deciding on another push.

## Installed acceptance test

Use a deployed gateway and supervisor with the mandatory pre-credentials hook. Use one App installation with access to private A, B and C. Verify independently that C is readable and the App can write the test branches on A and B. Disable alternative credentials. Give Agent 1 A-write and B-read and give Agent 2 an independent A grant.

1. Push a unique commit from Agent 1 to A. An independent reader sees its SHA.
2. Read a known private ref in B. Then try to push to B. The push fails and the remote SHA stays the same.
3. Try to read C from Agent 1. Access fails while the independent reader still reads C.
4. Keep an HTTPS client open and record its connection ID. Withdraw all Git grants from Agent 1 while the material is valid. Repeat a previously allowed request over that connection. Observe the withdrawal denial and zero GitHub requests for the attempt. Get a fresh model reply in the same execution and chat and a fresh private read of A from Agent 2.

Also exercise issue reads and writes against both permission tiers before enabling issues access. Record identities, expiry, decisions and ref SHAs without token values. This installed test remains to be run.
