---
rfc: ../rfcs/0024-openshell-codex-plugin-transport.md
---

# Implementation plan: OpenShell Codex app workflow

- **ID:** RFC-0024
- **Delivery status:** Planned
- **Authority:** [Transport proposal](../rfcs/0024-openshell-codex-plugin-transport.md), submitted in [PR #3985](https://github.com/openclaw/openclaw-enterprise/pull/3985).
- **Source baseline:** `c4d98ab574f2671896c2ccfce3ee458753f78a35`.

## Outcome and scope

One Slack request reaches a dedicated Codex Agent in OpenShell. That Agent reads
a specified repository file through the GitHub app, reads an authorized Linear
issue or project, and returns verifiable facts in the original Slack thread.
Use the existing Plugin Driver, native app policy, Credential Gateway, and Agent
lifecycle. This is development proof; production qualification and protected Git
remain outside scope.

## Implementation

1. Declare provider-owned preparation before native initialization. Keep ordinary
   Compute HMAC, private status, and best-effort semantics unchanged.
2. Gate the existing authenticated WebSocket path around the final native child.
   Reuse production plugin installation and policy checks with a connection-scoped
   credential, without provisioning it through environment variables or files.
3. Bound pending frames, clients, RPCs, and preparation. Terminate the generation
   when its preparation owner disconnects; close transport on child exit.
4. Require the real native initialization response for provider readiness.
   Integrate candidate preparation before dependent Gateway readiness.
5. Admit managed selections only through the complete provider capability,
   retaining fatal plugin failures and existing credential/network restrictions.
6. Extend the real Agent QA workflow and register its inputs/lane. Exercise the
   actual runtime, OpenShell, GitHub, Linear, and Slack dependencies. Keep private
   credentials and evidence outside this checkout.
7. Update the Sandbox/Plugin references, OpenShell provisioning flow, deployment
   guide, and owning testing page from observed behavior. Check affected cheat
   sheets and navigation. Preserve historical plans.

## Verification

| Required outcome                         | Proof                                                                                                                   | Result                 |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Plugin preparation and final policy      | Real native stdio installation and serving-process readback through deployment                                          | Not run                |
| Authentication and registration failures | Real runtime endpoint tests with absent, wrong, stale and conflicting inputs                                            | Not run                |
| Replacement and recovery                 | Candidate failure preserves predecessor; Harness restart rejects old bearer; Gateway restart adopts only after readback | Not run                |
| Credential and containment boundary      | Real Sandbox model commands, denied app/server requests, filesystem and network checks                                  | Not run                |
| Complete user request                    | Same-Agent Slack, GitHub, and Linear chain with source-verified thread reply                                            | Not run                |
| Repository quality                       | Focused integration, typecheck, lint, formatting, workspace, docs and independent review                                | Pending implementation |

## Delivery record

The RFC has been submitted before implementation. Source review found the
current selected-plugin rejection, verifier-only transport, and candidate
Gateway dependency. A real baseline model turn passed; managed selections failed
with `SANDBOX_HARNESS_UNSUPPORTED`. The revised design uses the existing native
protocol instead of credential registration. The proposal addresses each; no implemented support is
claimed. Toolchain preparation and isolated deployment preparation are ongoing.

## Manual Notes

## Changelog

- 2026-10-28: Created after RFC submission, from source `c4d98ab574f2671896c2ccfce3ee458753f78a35`.
