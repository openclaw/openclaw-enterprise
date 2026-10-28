---
rfc: ../rfcs/0014-plugin-policy-enforcement.md
---

# Implementation plan: Prepare dedicated Codex plugins over stdio

- **ID:** TASK-0049
- **Delivery status:** Planned
- **Owner:** kevinlin-openai
- **Source baseline:** `7257c814cdcba4daa53f3d1766f72f3696c7b4c6`

## Problem and decision

Prepare selected plugins with a temporary native Codex app-server over stdio
inside the dedicated Harness. Stop that process, then start the final native
WebSocket app-server against the same `CODEX_HOME`. Verify the final process
before forwarding user requests or reporting the Agent ready.

This document proposes an amendment to the active transport RFC in
[PR #3985](https://github.com/openclaw/openclaw-enterprise/pull/3985), inspected at
`8315cc1deb9e7063c7a4e7937b7683926c71989c`. That revision prepares plugins on the
final WebSocket process with a transient bearer. This amendment moves mutation
to temporary stdio preparation and keeps final-process verification read-only.
It does not change that PR's branch. Reconcile the owning RFC and primary plan
before merge. The frontmatter links the existing plugin-policy authority;
add the transport RFC link when its entry exists on the base branch.

## Scope

The regular Agent workflow gains selected plugins for dedicated Codex through
OpenShell. Embedded execution and ordinary Compute retain their current paths.
No external installation Job, new platform resource, production deployment, or
image publication is part of this delivery. GitHub access uses the existing
Credential Proxy and GitHub App path; it does not require a GitHub plugin login.

## Contract and ownership

The trusted Harness launcher owns both native generations, the shared private
home, cancellation, and the request gate. The Sandbox Driver owns admission,
exposure, and lifecycle observation. Dedicated Kubernetes Compute requires stopped
predecessors before preparation and activates only after native verification. The Plugin
Driver continues to own selection translation and app/tool policy. OCC consumes
Driver contracts without provider-specific branches.

The Sandbox Driver advertises this startup behavior explicitly. Compute uses
that capability to avoid the ordinary token-derived plugin-status protocol.
Existing `starting`, `serving`, and `failed` Harness states remain sufficient;
`serving` requires a verified native initialization, not a WebSocket upgrade.
Submit this amendment for human review before changing the Driver contract.

1. Restore the immutable managed configuration and admit enforced protected
   egress before either native process starts. Retain enrollment through both
   generations. Both use the same proxy, login, filesystem, and permission
   settings; upstream API credentials stay at the Credential Proxy.
2. Start one stdio process and initialize it. Use native catalog, read, install,
   and configuration RPCs to resolve and prepare every selected plugin. Require
   every selection to succeed on this provider path. Disable removed selections
   and reject unexpected enabled apps, tools, or plugins before continuing.
3. Close stdio and reap the preparation process and its descendants before
   starting the final process. Cancellation or uncertain mutation terminates
   the entire generation; no late installer may write into the shared home.
   A later attempt revalidates retained state instead of trusting a marker.
4. Start the final native WebSocket process with `APP_TOKEN_SHA` only. Do not
   provision the raw Gateway token in environment, arguments, files, mounts,
   logs, or diagnostics. Keep application requests behind the trusted gate.
5. Authenticate a connection through the existing provider exposure. Reuse its
   transient bearer only for native read-only verification of the owned final
   child, then release the reference. This bearer crosses the authenticator;
   this design makes no claim that it never exists transiently in memory.
   Verify selected installed releases, app/tool ownership, effective policy,
   and native initialization. Do not reinstall through this connection.
6. Forward the caller's own initialization only after verification. Child exit
   clears readiness and closes forwarded sockets. Every process/container
   restart repeats preparation and verification before serving requests.

Keep one preparation owner and one final verification owner per generation.
Use the existing 60-second preparation budget, with each RPC consuming its
remaining time; allow at most eight seconds for graceful process-group shutdown
before forced termination and reaping. Bound final verification to 60 seconds.
The gate admits at most sixteen authenticated connections and buffers at most
four messages and 64 KiB per connection. A disconnected verification owner,
overflow, timeout, or native exit fails that generation closed. Do not retry
mutating RPCs in place. Unchanged reconciliation observes the existing generation
without reinstalling. Revision, plugin selection, or image changes prepare a
replacement candidate through the existing lifecycle.

## Implementation

1. Complete the pinned-native feasibility checks below. Extend an existing native
   readback response only where current observations cannot establish effective
   policy. Reuse native policy resolvers; submit the narrow dependency for
   independent review and a separate PR. Native edits and builds stay in an
   isolated development checkout. Do not introduce a bootstrap RPC.
2. In [runtime entrypoints](../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts),
   separate the existing installer RPC transport from installation policy. Add
   temporary stdio preparation, process-group cleanup, and final read-only
   verification. Reuse existing native configuration translators and failure
   documents. Keep the ordinary WebSocket installer unchanged.
3. In [OpenShell Sandbox](../../apps/controller/src/drivers/sandbox/openshell.ts),
   replace the nonempty-selection rejection only after the complete startup
   path exists. Extend the existing provider client to observe real native
   initialization through the gate. In
   [Kubernetes Compute](../../apps/controller/src/drivers/compute/kubernetes/index.ts),
   consume the declared capability for runtime files, status, candidate
   readiness, and activation. Preserve protected-egress attribution and cleanup.
4. Extend the real Agent QA workflow and CI selection. Update the owning
   [Sandbox reference](../../docs/reference/drivers/openshell-sandbox.md),
   [runtime flow](../../docs/flows/openshell-sandbox-provisioning.md), and
   [OpenShell tests](../../docs/testing/openshell.md) with verified behavior.

## Verification

| Required outcome                             | Proof and current result                                                                                                                                                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Stdio catalog/read/install and durable state | Native `0.163.0-alpha.2` installed a local plugin; the temporary process exited with code 0; a new authenticated WebSocket process listed/read it as installed and enabled without reinstalling. Network-disabled Docker proof only. |
| Exact configured policy survives replacement | Both native generations returned configured app defaults, reviewer, and tool fields. This is configuration readback, not effective enforcement.                                                                                      |
| Effective managed policy is observable       | Unresolved: a mounted managed requirement disabled an app and overrode tool approval, but `config/read` returned the user values and `configRequirements/read` omitted app requirements.                                             |
| Remote admitted plugin and proxy custody     | Run the real selected identity through an isolated enforcing OpenShell environment; prove remote catalog/install, replacement, final tool inventory, and allowed/denied app calls. Not run.                                          |
| Removal, partial install, and stale state    | Through Agent revision changes, remove a selection and inject a genuine unavailable artifact; require exact final enablement or failure with no serving endpoint. Not run.                                                           |
| Restart, cancellation, and bounded cleanup   | Stop during installation and verification, then restart; prove no surviving child or late write, and no stale connection reaches an unverified replacement. Not run.                                                                 |
| Platform readiness and policy enforcement    | Exercise the regular Agent deployment, proxy path, filesystem denials, protected egress, and model/tool calls. Fixture checks do not replace these cases. Not run.                                                                   |

## Open decisions

The pinned native `app/installed` exposes effective app enablement and
callability, but no per-tool approval or reviewer. Its threadless path also omits
workspace configuration. `app/read` provides tool summaries; `mcpServerStatus/list`
provides tool schemas. Neither establishes the complete final-policy gate.
Review an extension to `app/installed` that takes explicit workspace context and
returns tool policy from native resolvers, including account-dependent decisions.
Do not collapse unresolved account policy into a single approval value. Neither
installation success nor an operator reading source satisfies this gate.

## Delivery record

Feasibility used the unmodified `rust-v0.163.0-alpha.2` source and an existing
runtime image built from OCE `bb05475fe39c0987ff84deecb62c208cc619d118`, with
OpenClaw `762a2fe60cc37cf6b8c9d05e61c329866e0d3f6f`. It establishes native
transport and local package persistence only. Product implementation, remote
plugin proof, OpenShell proof, and live user end-to-end proof remain incomplete.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-28 16:22 PDT: Proposed stdio preparation and recorded native feasibility limits (source `7257c814`; session `01a184cd-7ec2-7fa2-8547-9629c51ad0ba`).
