---
rfc: ../rfcs/0014-plugin-policy-enforcement.md
---

# Implementation plan: Install dedicated Codex plugins over stdio

- **ID:** TASK-0049
- **Delivery status:** Completed
- **Owner:** kevinlin-openai
- **Source baseline:** `7257c814cdcba4daa53f3d1766f72f3696c7b4c6`

## Outcome and scope

Install selected plugins with a temporary native Codex app-server over stdio
inside the dedicated OpenShell Harness. Stop that process, then start the final
native WebSocket app-server against the same `CODEX_HOME`. Verify installation
and discovery across the process replacement with the real runtime.

The user narrowed this task to installation. Final effective-policy attestation,
a new readiness gate, native API changes, and a bootstrap protocol are outside
scope. Keep existing managed selections and approval configuration, Credential
Proxy custody, failure handling, and basic platform readiness. Embedded execution
and ordinary Compute keep their current paths. No external installation Job,
production deployment, image publication, or merge is authorized.

This is the proposed amendment to the active transport RFC in
[PR #3985](https://github.com/openclaw/openclaw-enterprise/pull/3985), inspected at
`8315cc1deb9e7063c7a4e7937b7683926c71989c`, submitted through
[PR #3998](https://github.com/openclaw/openclaw-enterprise/pull/3998).
Reconcile the RFC and primary plan before merge; this lease does not edit the
other branch. Frontmatter links existing plugin-policy authority until the
transport RFC exists on the base branch.

## Contract and source touchpoints

The trusted Harness launcher owns temporary preparation and clean shutdown.
The Sandbox Driver owns admission, exposure, and lifecycle observation. Dedicated
Kubernetes Compute stops predecessors before preparation. The Plugin Driver
continues to own selection translation and managed app/tool configuration.
The Credential Gateway owns the source-wide native Plugin Service route
allowance submitted in the
[RFC amendment](https://github.com/openclaw/openclaw-enterprise/pull/3985#issuecomment-6484394125).
The supported operations on `chatgpt.com:443` are:

| Operation            | HTTP paths                                                              |
| -------------------- | ----------------------------------------------------------------------- |
| Discover plugins     | GET `/backend-api/ps/plugins/search` and `/backend-api/ps/plugins/list` |
| Read installed state | GET `/backend-api/ps/plugins/installed`                                 |
| Read plugin detail   | GET `/backend-api/ps/plugins/{id}`                                      |
| Install a plugin     | POST `/backend-api/ps/plugins/{id}/install`                             |

The enforced rules are GET `/backend-api/ps/plugins/*` and POST
`/backend-api/ps/plugins/*/install`. GET also permits HEAD. This is an account/source
capability shared across Agents, not a per-Agent selection ACL. Do not derive
the shared profile from the last reconciled Agent. Bundle downloads require
separate credential-free egress scoped to observed hosts and redirects.
The real scenario uses existing ordinary Sandbox operator configuration for
six observed regional artifact hosts, with read-only REST, TLS inspection and
native binary restrictions. It adds no artifact host to a credential profile
or production default. Protected egress plans retain their own authority.

1. Restore managed configuration and complete existing login, model checks, and
   protected-egress enrollment before preparation. Preserve the same home,
   proxy path, filesystem policy, and native launch settings for both processes.
2. Start one temporary native stdio process. Search the native global catalog for
   each selected plugin and require exact identity and marketplace matches. The
   pinned native `plugin/search` avoids scanning the entire paginated catalog,
   which timed out in the real Harness. Keep search pagination inside the
   preparation deadline. Use native read, install,
   and configuration RPCs through the existing installer. Require all enabled
   selections to install successfully; preserve existing removal and default-off
   configuration. Do not retry an uncertain mutation within that process.
3. Close stdin and wait for the temporary process to exit before launching the
   final native WebSocket process. Bound preparation to 60 seconds and graceful
   shutdown to eight seconds. Cancellation or failure stops startup; cleanup
   must complete before a replacement starts. The existing supervisor owns the
   process group and removes descendants on wrapper exit.
4. Start the final process with only the transport verifier. Never provision the
   raw Gateway transport token through Harness environment, arguments, files,
   mounts, or logs. Upstream credentials remain at the Credential Proxy.
5. Use existing basic Harness readiness. The Gateway uses the admitted plugin
   configuration without waiting for ordinary Compute's HMAC plugin-status
   exchange. Do not claim that successful installation establishes effective
   policy enforcement or authenticated app-tool success.

Process/container restart repeats preparation. Revision, selection, and image
changes use the existing replacement lifecycle. Unchanged reconciliation
observes the existing workload. Retained package state is revalidated through
the installer; removed selections must not remain enabled.

## Implementation

1. In [runtime entrypoints](../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts),
   supply a bounded stdio RPC session to the existing installer, then close it
   before final native launch. Reuse configuration translators. Keep ordinary
   WebSocket installation and embedded execution unchanged.
2. In [OpenShell Sandbox](../../apps/controller/src/drivers/sandbox/openshell.ts),
   admit selected Codex plugins only with the complete preparation path. In
   [Kubernetes Compute](../../apps/controller/src/drivers/compute/kubernetes/index.ts),
   omit the provider Harness's ordinary plugin-status exchange and configure
   its Gateway accordingly. Preserve egress enrollment and credential custody.
3. Extend the real Agent QA workflow and CI selection. Update the owning
   [Sandbox reference](../../docs/reference/drivers/openshell-sandbox.md),
   [runtime flow](../../docs/flows/openshell-sandbox-provisioning.md), and
   [OpenShell tests](../../docs/testing/openshell.md).

## Verification

| Outcome                             | Proof and result                                                                                                                                                                                                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native installation and replacement | `codex-plugin-stdio-real.test.ts`: passed against unmodified Codex `0.163.0-alpha.2`; local package installation survives clean stdio-to-WebSocket replacement without reinstalling.                                                                              |
| Real selected remote installation   | `openshell-plugin-install-real.test.ts`: passed through the real Agent API/worker, Credential Gateway, and enforcing OpenShell cluster. The final native process reports the selected plugin installed and enabled.                                               |
| Restart and removal                 | The same real scenario restarts the serving native process, verifies installed state, then removes the selection through the Agent API and verifies disablement after deployment.                                                                                 |
| Failure and cancellation cleanup    | The native test drains an actual failed install and a pending request interrupted by a launcher termination event. It verifies no surviving native process; it does not simulate loss of a controller lease.                                                      |
| Credential and execution boundaries | The real scenario checks ownership, mounts, model-secret exposure, verifier-authenticated transport, active artifact policy and absence of artifact hosts from the PAT profile. This is ordinary OpenShell policy proof, not protected-egress-plan qualification. |

## Delivery record

Implementation is delivered through [PR #3998](https://github.com/openclaw/openclaw-enterprise/pull/3998).
Both real-runtime tests passed with zero skips. The native executable is
`0.163.0-alpha.2`, source `a6274249d5877030676db098914db686bab7c921`.
The local runtime image configuration digest is
`sha256:8462c295b2b21e875c0ff502eff917e6c20ad3e73cd6bee07a8e28e57a6b975e`;
the tested k3s platform image digest is
`sha256:d55bdc7e7d9b879ff85fc8550262b4bb107252992dc68d1cecb4a9bfd4e3cd8b`.

Real execution identified the required API routes, the full-catalog timeout,
and package-host denials. The final implementation uses selected-plugin search
and the reviewed operator artifact policy. OpenShell 0.1.5 requires omitted
`tls` for automatic inspection; explicit `terminate` is rejected. The final
scenario also verifies initial workspace-file delivery after its existing setup
retry. No native API extension or stronger readiness guarantee is included.

Focused startup/translation checks, type checking, lint, formatting, workspace
isolation, CI registration and independent review accompany the runtime proof.
Official local documentation checks remain blocked by the missing docs-site
`@sindresorhus/slugify` dependency; no dependencies were installed for validation.
Scoped links and length review remain separate evidence. Reconcile the owning
RFC before merge and run the official documentation checks in CI.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-28 16:22 PDT: Submitted the initial proposal (source `7257c814`; session `01a184cd-7ec2-7fa2-8547-9629c51ad0ba`).
- 2026-10-28: Narrowed delivery to plugin installation on the user's instruction; removed native API and strong readiness work.
- 2026-10-28 18:49 PDT: Completed installation-only implementation and real native/OpenShell proof (source `000e1381e7` plus tested working tree; session `01a184cd-7ec2-7fa2-8547-9629c51ad0ba`).
