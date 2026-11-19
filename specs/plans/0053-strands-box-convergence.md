---
rfc: ../rfcs/0023-egress-proxy-credential-lifecycle/index.md
---

# Strands and Box protected execution

- **ID:** TASK-0053
- **Delivery status:** Planned
- **Authority:** [RFC-0023](../rfcs/0023-egress-proxy-credential-lifecycle/index.md)
- **Source baseline:** `962a41087083053b585b477d4791f8aded6a9f4e`

## Outcome and scope

On a clean ARM64 Helm installation, the normal Worker deploys a Codex Agent in Box. The Agent must
complete a real HTTP model turn, push a commit to its assigned GitHub repository, and open a draft
pull request. Withdraw its Git access. The next Git operation must fail, and the next model turn
must succeed in the same conversation.

V1 covers HTTP API-key inference only. Admission must refuse personal access tokens (PATs),
interactive login, and WebSocket credential delivery. All five milestones below are pending.

## Credential and execution boundary

Qualify one trusted native Box parent that directly starts its trampoline and contained child in the
same Agent Pod container. Three proposed amendments govern this work.

| Decision                                                                          | Contract                                                                                                                   |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Who holds, issues, and delivers credentials?                                      | [Installation credential ownership](../rfcs/0023-egress-proxy-credential-lifecycle/installation-credential-ownership.md)   |
| How does Installation select the Drivers, and when can Compute release the child? | [Held startup](../rfcs/0023-egress-proxy-credential-lifecycle/strands-box-held-launch.md)                                  |
| When may every process in one Sandbox use a binding?                              | [Agent-wide Box policy for the isolated pilot](../rfcs/0023-egress-proxy-credential-lifecycle/strands-box-agent-policy.md) |

## Ordered pull requests

Deliver these in order, preferably under 2,000 changed lines per PR. Update the owning references
and flows with each behavior change. Submit a covering RFC for human review before changing a Driver
interface, required behavior, or configuration. Respect explicit holds and existing branch
ownership. Import only reviewed changes.

1. **Establish the boundary.** Start with
   [contract selection](../rfcs/0023-egress-proxy-credential-lifecycle/strands-box-held-launch.md#credentialproxy-contract-selection)
   through Installation setup, the default package loader, Compute, and the Worker. Next exercise
   the native parent, trampoline, and child with invented sentinels. Connect the real Box callback
   to the trusted recipient through the paired Sandbox and CredentialProxy. Prove the
   [startup and containment criteria (AC-0 through AC-4)](../rfcs/0023-egress-proxy-credential-lifecycle/strands-box-held-launch.md#acceptance-criteria)
   and the
   [two-subprocess pilot criteria](../rfcs/0023-egress-proxy-credential-lifecycle/strands-box-agent-policy.md#acceptance-criteria)
   through the real Agent.
2. **Protect inference.** Route a Codex turn through mandatory egress. Verify injection at the
   admitted HTTP origin and a genuine model reply. Exercise admission and request handling with
   another destination, a dangerous redirect, a missing credential, incompatible presentation, and
   unsupported authentication. Require refusal. Use invented sentinels to verify that the injector
   blocks known disclosures in response headers, bodies, trailers, errors, and logs.
3. **Enable prepared Git.** Extend the
   [Worker path](../../docs/reference/drivers/selection.md#select-a-protected-sender) through
   Sandbox `repositoryAccess` and `CredentialProxyDriver.bindRepositoryGit`. Reuse the selected
   issuer.
   - Limit pushes to permitted refs in the assigned repository and REST pull request operations to
     explicit grants and head/base refs. Deny GraphQL by default.
   - Stock `gh` needs a selector change for its exact GraphQL requests and variables, repository
     identity, head/base refs, and draft restrictions. Qualify that change with trusted effect
     readback and recovery that reconciles an uncertain creation to a single draft. Keep
     installation-wide GitHub API access out of scope.
   - Only then push and create a draft from the running Agent. Read back both effects at GitHub.
     Refuse another eligible repository, unauthorized refs, and out-of-scope PR actions. Preserve
     OpenShell Git behavior and coverage.
4. **Rotate and withdraw access.** Exercise a failed delivery, a stale serving copy, a rejected
   withdrawal, expiry, and a lost reply against the
   [delivery and recovery rules](../rfcs/0023-egress-proxy-credential-lifecycle/strands-box-held-launch.md#ownership-and-release).
   Verify that fresh Git use fails after withdrawal or expiry and that the Agent can continue its
   model conversation.
5. **Qualify the installation.** Install the Helm chart and Worker built from the exact reviewed
   candidate on clean ARM64. Record chart, image, and source identities. Check installer egress,
   RBAC, DNS, bootstrap, and diagnostics for held startups. Run the
   [full journey](#outcome-and-scope), denials, rotation, withdrawal, recovery, and cleanup with
   authorized provider and GitHub access. Capture independent evidence at each provider. Report
   unmet prerequisites and failures separately from source and fixture results.

## Delivery baseline

Start the native experiment at Box commit `956764b58f2c5ccb12bb7048fd1ced3d8ca1b5d4`.
[Box #311](https://github.com/strands-agents/box/pull/311) provides a reverse HTTPS backend without
CONNECT proxy support. Qualify TLS, addressing, identity, and request handling for the selected
route.

The
[historical Pod readiness gate](../rfcs/0023-egress-proxy-credential-lifecycle/strands-box-held-launch.md#problem-and-decision)
explains the first milestone. [#6098](https://github.com/openclaw/openclaw-enterprise/pull/6098)
covers Sandbox maintenance cadence. [RFC-0024](../rfcs/0024-sandbox-harness-mode-support.md) covers
OpenClaw mode reporting. Box and Codex require their own qualification. The
[platform design](../../docs/design.md#implementation-status) lists general credential-free
inference as planned.

## Manual Notes

## Changelog

- 2026-11-18 — Record the v1 decision and delivery order against the source baseline above.
- 2026-11-19 — Select the direct native Box parent experiment and retain conditional descriptor-handoff requirements.
