---
created: 2026-09-01
updated: 2026-09-01
last_updated_session: 01a05d94-c601-7033-a519-a19647ccf3e9
---

# Setup Command Flow

## Overview

The operator-side Node command turns deployment inputs into one working embedded
OpenClaw Agent and a connected native TUI. It orchestrates the existing Compose,
Helm, initialization, and OCC API boundaries. The initializer still creates only
the Installation and first administrators; operator Kubernetes authority remains
outside the controller.

The [setup reference](../reference/setup.md) owns flags, configuration, state,
and recovery. The [deployment guide](../guides/deploy.md) owns the short procedure.

## Entry points

- [`scripts/setup.mjs`](../../scripts/setup.mjs): parses `dev`, `production`, or
  `tui`, checks inputs, locks private state, and selects the backend.
- [`scripts/setup/common.mjs`](../../scripts/setup/common.mjs): private state,
  exact OCC resource provisioning, pending-operation markers, and TUI process.
- [`scripts/setup/development.mjs`](../../scripts/setup/development.mjs): runtime
  build, Compose startup, bootstrap-key copy, and gateway-container selection.
- [`scripts/setup/production.mjs`](../../scripts/setup/production.mjs): explicit
  cluster/config validation, generated Helm inputs, protected bootstrap storage,
  tenant access, Secrets, and active gateway-Pod selection.

## Execution

`node scripts/setup.mjs production --config FILE` dispatches to `production`,
then `withStateLock` → `runSetup` → the production backend → OCC resource
creation. The command releases the state lock, then calls `runInteractive`. The development branch uses the same resource
sequence after Compose startup. This trace stops at native TUI execution;
gateway model routing is owned by the runtime.

1. Validate required input and the interactive terminal when opening a TUI.
   Acquire an exclusive state lock in a real private directory. Reject changed
   saved deployment identity and any unresolved pending operation.
2. Development ensures the runtime image exists, starts Compose, requires
   bootstrap `exited 0`, and copies its service-key JSON. Production renders and
   validates Helm configuration, creates bounded owned prerequisites, records a
   pending initialization marker, installs Helm, waits for readiness, and copies
   the initial password/key through a temporary read-only bootstrap reader. A
   resumed pending Helm install inspects the exact release, initialization Job,
   and owned resources before marking it complete; it never blindly reinstalls.
3. `runSetup` reads `/installation` with the private `x-api-key` and compares its
   ID with both key metadata and saved state. OCC requests reject redirects.
4. Create one Namespace through the real API. Production resolves that exact
   backing Kubernetes namespace and creates tenant-local worker and
   Configuration RoleBindings. Wait for OCC `ready`.
5. Create a native Agent Configuration and embedded Agent. Production generates
   its transport token once and writes the exact Agent-owned model/transport
   Secrets. The OCC credential is never delivered to the workload.
6. Send a bodyless deploy and save the returned revision ID. Wait until the
   Agent reports that revision active. On a rerun, read and reuse saved IDs.
   Before a mutating POST, persist a pending marker; save the returned ID and
   remove that marker atomically. An unknown outcome stops automatic retries.
7. Resolve the gateway for the active Agent revision. Development checks Docker
   ownership labels. Production requires exactly one Ready, Running,
   nonterminating Pod mounting the active revision's immutable ConfigMap.
8. Return the selected command to the CLI and release the state lock. Start
   native `node /app/openclaw.mjs tui` inside the selected gateway with the
   model key removed from the client process. The gateway configuration supplies
   its local connection and transport authentication. Exiting TUI retains the
   gateway and private deployment state.

`tui` reconnect reads current `activeRevisionId` before selection; it can attach
after an ordinary API redeployment without creating any resource.

## Authority and failure boundaries

Setup runs with operator Docker/Kubernetes permissions. The controller still
uses its existing scoped service principals and Driver authorization. Setup
adds no new HTTP route, initializer privilege, controller RoleBinding authority,
or gateway access to the OCC service key.

Credentials are stored separately from non-secret state. Setup creates Secrets
without client-side apply annotations and captures command output for redaction. Temporary reader and
prepare Pods are removed, while bootstrap PVCs and saved state survive failure.
An uncertain initialization or API response requires inspection of actual state;
setup does not reset storage, rotate credentials, uninstall, or adopt foreign
same-named resources. A successful production rerun does not reinstall Helm.

## Verification

[`setup-cli.test.mjs`](../../tests/integration/setup-cli.test.mjs) checks CLI input
and private-state boundaries. Its opt-in Docker case runs setup twice, verifies
exact IDs, and requires two real assistant replies via the shipped reconnect
command. [`setup-production-k3d-real.test.mjs`](../../tests/integration/setup-production-k3d-real.test.mjs)
uses a real disposable cluster, imported immutable images, PostgreSQL, and a TLS
proxy. It invokes the shipped production command and verifies installation,
rerun reuse, credential isolation, and two TUI replies.

For underlying runtime startup, see [development startup](development-startup.md),
[production startup](production-startup.md), and [production TUI](production-tui.md).
