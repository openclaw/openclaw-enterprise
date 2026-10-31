---
rfc: ../rfcs/0023-egress-proxy-credential-lifecycle/index.md
---

# Implementation plan: Read one GitHub repository through stock OpenShell

- **ID:** TASK-0048
- **Delivery status:** Planned
- **Owner:** kevinlin-openai
- **Authority:** [RFC-0023](../rfcs/0023-egress-proxy-credential-lifecycle/index.md), submitted in [PR #1530](https://github.com/openclaw/openclaw-enterprise/pull/1530), and its [online request authorization requirements](../rfcs/0023-egress-proxy-credential-lifecycle/online-authorization.md).
- **Source baseline:** `7257c814cdcba4daa53f3d1766f72f3696c7b4c6`.

## Outcome and scope

A human Slack request reaches a dedicated Codex Agent in a disposable Kubernetes
installation with OpenShell. The same Agent fetches its assigned GitHub repository
through Credential Proxy and an existing GitHub App, reads the requested content,
and replies in the original thread with a verifiable commit link.

Use the existing public `git-read` profile and ordinary Git smart HTTP. Linear
and GitHub native plugins are not prerequisites. Limit the material to one
repository, with `metadata: read` and `contents: read`. Do not use installation-wide
access, a write grant, the observed-hook preview, or the legacy broker as a substitute.
This work uses the published online middleware protocol; it adds no wire protocol
or platform resource.

## Contract and source touchpoints

The [Repo contract](../../packages/contracts/src/repo.ts) already names `git-read`,
but protected delivery maps only one `git-write` binding or installation access.
The [registry](../../apps/controller/src/drivers/repo/github/credentials/registry.ts)
and [prepared material owner](../../apps/controller/src/backends/repository-credentials/prepared-git-owner.ts)
also require write-oriented fields for a narrow Git recipient.

Add an internal `git-ref-read` token profile for public `git-read` with `git-only`
transport. Keep the broader existing public read profile unchanged for other
callers. The existing issuer supplies one repository ID and explicit permissions;
its response validator must continue to require that exact scope. Carry the
read profile through fingerprints, standing approval, preparation, encrypted
custody, delivery and retirement without manufacturing a push ref.

The [online Git authorizer](../../apps/controller/src/drivers/egress-proxy/openshell-online-git-authority.ts)
uses the shared request classifier. Give the read variant an explicit branch that
permits only upload-pack discovery and fetch for the named repository. Absence
of a push ref must never mean unrestricted receive-pack. Refuse API operations,
other repositories and all writes before material authorization.

The [OpenShell Proxy](../../apps/controller/src/drivers/egress-proxy/openshell.ts)
must replace its admission refusal and missing enforcement evidence together.
Use the existing version-5 online authorization and execution enrollment. Verify
the published runtime pair, required request binding, fail-closed attachment,
TLS, intended effective configuration, exclusive provider recipient and
never-reused sandbox identity. Read the published binding-policy fields through
the existing credential-free `GetSandboxConfig` operation. `Phase: Ready` alone
is insufficient when the desired configuration was rejected.

## Implementation

1. Qualify stock OpenShell 0.1.6 with synthetic material at a controlled HTTPS
   origin. Preserve authenticated management and middleware, TLS verification,
   process isolation and network restrictions. Do not enroll an App key before
   the enforcing path passes its release checks.
2. Extend existing read-profile mapping, material ownership and database
   constraints. Keep write and installation grants distinct. Reject unsupported
   combinations before startup and preserve retirement after uncertain outcomes.
3. Integrate verified stock online enforcement into regular Agent provisioning,
   policy withdrawal and cleanup. Use the published configuration fields; do not
   infer enforcement from a version string or a successful request.
4. Extend the real Agent integration and canonical QA selection. Prove a normal
   Git fetch and local file read, consequential refusals and live withdrawal.
5. Update the Repo and Proxy references, owning runtime flows, operator setup,
   test instructions and affected cheat sheets from the implemented behavior.
   Record image identities, source, resources, tool calls and the final Slack
   permalink outside the checkout. Finish repository checks and independent review.

## Verification

| Required outcome                  | Real check                                                                                                          | Result or remaining proof                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Current request authorization     | Stock supervisor sends an allowed read; live denial sends no new origin request while material stays valid          | Passed in an isolated Docker diagnostic with synthetic material; not OCC or GitHub proof |
| Required request binding          | Gateway accepts the request manifest; a fresh supervisor receives only a response manifest                          | Protected read refused; desired configuration invalid despite Sandbox phase Ready        |
| Middleware outage                 | Stop only the authorizer; retain healthy origin, proxy and material                                                 | Protected read refused; direct operator control still authenticates to the origin        |
| Transport and execution isolation | Plaintext-in-CONNECT, direct route, omitted hook, unauthorized policy/provider changes and restart/replacement      | Pending; a missing proxy environment variable is not a passing transport test            |
| Narrow material scope             | Exact repository and two read permissions; reject incorrect issuance and unsafe classifiers                         | Pending                                                                                  |
| Regular Agent workflow            | Real GitHub fetch through OCE, denied other-repository and write attempts, withdrawal while the token remains valid | Pending                                                                                  |
| Human request and reply           | Same Agent completes the authorized read from the human Slack thread and returns source-backed facts there          | Pending                                                                                  |

## Delivery record

Published OpenShell 0.1.6 includes required middleware bindings. The diagnostic
uses its unmodified supervisor and sandbox images, production OCE request/JWT
validation, a controlled authorization decision and a controlled HTTPS origin.
It does not qualify OCE grant handling, Kubernetes deployment, App material or
the final user workflow. The earlier plugin-free Agent model turn passed; the
App key remains unenrolled. Deferred plugin startup work is preserved separately.

## Manual Notes

## Changelog

- 2026-10-28: Planned the narrow read adaptation under submitted RFC-0023 after stock runtime checks and source review (`7257c814cdcba4daa53f3d1766f72f3696c7b4c6`; session `01a1846c-cfc7-77e2-902d-a7d13b1e3118`).
