# Feature Spec: SSH Compute Driver for raw hosts

**Date:** 2026-09-05

**Status:** Completed

**Owner:** Bundled Compute implementations and Installation composition

## Problem and Decision

The bundled Compute Drivers run Agent gateways only as Docker containers
(development) or Kubernetes workloads (production). Operators who run OpenClaw on
ordinary Linux hosts (a VM, a bare-metal server, a fleet of hosts managed with
systemd) cannot use OCC as their deployment control plane at all.

Add one bundled `SshComputeDriver` (`id: compute-ssh`, implementation `occ/ssh`)
that realizes Namespaces and embedded OpenClaw AgentRevisions on operator-owned
Linux hosts over SSH. The worker connects with the system `ssh` client, runs one
controller-owned Node.js helper on the host, and manages one systemd service per
Agent. The driver does not install OpenClaw, Node.js, or systemd; the operator
provisions the host, the runtime, and per-Agent credential files, mirroring how
the Kubernetes Driver expects operator-owned images and Secrets.

This is the same [ComputeDriver contract](../docs/reference/drivers/compute.md)
under the [platform design](../docs/design.md): OCC owns resources, revisions,
authorization, and activation; the Driver realizes admitted intent on the host
and reports readiness without acquiring platform ownership.

## Scope

- One bundled Compute Driver selectable in development and production through
  `drivers.compute.id: compute-ssh` without a `package`. Any other bundled
  `id` continues to select the Kubernetes Compute Driver.
- Namespace lifecycle (`ensureNamespace`, `deleteNamespace`), embedded OpenClaw
  revision lifecycle (`prepareRevision`, `activateRevision`,
  `deactivateRevision`, `retireRevision`), production `preflight`, `bindAgent`,
  and selected-Driver lifecycle hooks.
- Conformance coverage that executes the real driver and the real host helper
  locally with a systemd fixture, one startup composition test, one opt-in real
  SSH integration against a disposable systemd container, and reference,
  settings, selection, architecture, and testing documentation.

Out of scope, recorded as explicit limitations rather than silent behavior:

- Dedicated Codex execution, SandboxDriver composition, OCC Secret bindings,
  `getGatewayEndpoint` (workspace-file API), `existingNamespace` adoption,
  active-runtime maintenance, macOS launchd, non-root SSH users, and
  zero-downtime cutover. Each fails closed with a specific message.
- Installing or upgrading OpenClaw on hosts. A runtime change is an operator
  host change followed by an explicit redeploy of each Agent.

## Contract

See [Contract](21-ssh-compute-driver/contract.md#contract).

## Implementation

1. Add `apps/controller/src/drivers/compute/ssh/` with `index.ts`
   (`SshComputeDriver`, static closed `configurationSchema` and
   `validateConfiguration`, `createSshComputeDriver`), `executor.ts` (the
   `SshCommandExecutor` seam and the default `ssh` spawn implementation), and
   `remote-helper.cjs` (the host program). Reuse `ComputeLifecycleDispatcher`,
   `operation-context.ts`, `sha256Hex`, and the Docker Driver's error
   classification idiom. No new dependencies.
2. Select the bundled driver by id in `composition/installation-config.ts`,
   apply the Kubernetes-only production checks only for the Kubernetes
   selection, and reject `drivers.sandbox` with `compute-ssh`. Leave installed
   package loading, the Kubernetes and Docker drivers, contracts, and the
   worker unchanged.
3. Add `tests/fixtures/ssh-compute/bin/systemctl`, a shell fixture that records
   `daemon-reload`, `enable`, `disable`, `restart`, `stop`, `is-active`, and
   `show`, and on `restart`/`start` launches a loopback HTTP listener on the
   unit's `OPENCLAW_GATEWAY_PORT` answering `/readyz` so the real helper's
   readiness polling runs unmodified. Add `tests/fixtures/ssh-compute/host/`
   with a Dockerfile for a disposable systemd container with `sshd`, Node.js
   24, and the runtime image's OpenClaw npm packages.
4. Add `tests/conformance/ssh-compute.test.mjs`: schema and semantic
   validation, unit rendering and environment, port allocation, ownership
   refusal, superseded candidates, idempotent activation, retire, and
   Namespace deletion, all through a local executor that runs the real helper
   against a temporary root with the fixture `systemctl` on `PATH`. State
   plainly that systemd and SSH are replaced by fixtures there.
5. Add `tests/integration/ssh-compute-startup.test.mjs` proving production
   composition selects `SshComputeDriver` for `compute-ssh`, skips the
   Kubernetes-only checks, rejects `drivers.sandbox`, and rejects invalid
   configuration; and the opt-in `tests/integration/ssh-compute-real.test.mjs`
   selected by `OCC_TEST_SSH_REAL=1` that drives the real driver over real SSH
   through Namespace readiness, two embedded revisions with cutover, state
   persistence across the restart, retirement, and Namespace deletion.
6. Document: `docs/reference/drivers/ssh-compute.md` (new reference owning
   configuration, layout, lifecycle, credentials, verification, and
   limitations), plus updates to `docs/reference/drivers/selection.md`,
   `docs/reference/drivers/compute.md`, `docs/reference/README.md`,
   `docs/reference/settings.md`, `docs/ARCHITECTURE.md`, `docs/README.md`,
   `docs/testing.md`, and `specs/README.md`.

## Verification

| Required outcome                 | Evidence                                                                                                                                     |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Selection and startup            | Production composition selects the driver for `compute-ssh`; Kubernetes-only checks do not run; sandbox composition and bad YAML fail.       |
| Real driver and helper lifecycle | Conformance suite runs the actual helper against a temporary root with the systemd fixture; asserts files, modes, unit content, and effects. |
| Ownership and immutability       | Foreign markers, changed snapshots, and unowned units are refused without mutation.                                                          |
| Real host                        | Opt-in integration against a disposable systemd container proves readiness, cutover, persisted state, retirement, and deletion over SSH.     |
| Repository gates                 | `pnpm typecheck`, `pnpm test:conformance`, targeted integration files, `pnpm format:check`, `pnpm check:workspace`, `pnpm openapi:check`.    |

The conformance suite is not host proof: it substitutes systemd and SSH. The
real integration is the host proof and must run without skips before this
specification is marked complete. Neither proves a model turn.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-05: Proposed and accepted the bundled SSH Compute Driver for raw Linux hosts; implementation in progress.
- 2026-09-05: Codex autoreview (P1) found three defects, all fixed with regression tests: the snapshot was chowned to the runtime account (now controller-owned `0640`), an interrupted cutover could be accepted as served (now gated on `served.json` written after readiness), and a cancelled SSH client did not stop the remote helper (now a stdout heartbeat plus self-deadline).
- 2026-09-05: Autoreview rounds 2 and 3 found races in filesystem stale-lock reclamation (a concurrent reclaimer could delete a live replacement lock; PID and inode read across a replaceable path; a tombstone prunable before its retention started). Replaced the whole protocol with a kernel `flock(2)` on `<root>/.compute-lock` held by a helper child tied to the helper's stdin, released by the kernel on any helper exit; `probe` now requires `flock` on hosts. Conformance proves exclusion and kernel release with the fixture `flock` wrapper over the same syscall; the real-host integration exercises util-linux `flock`.
- 2026-09-05: Implemented. Verified `pnpm typecheck`, workspace boundary, OpenAPI parity, Prettier, 10 SSH conformance tests, 23 targeted startup/composition integration tests, and the opt-in real-host integration against the disposable `node:24-bookworm` systemd container rig with OpenClaw `2026.7.1` (readiness, two-revision cutover, state persistence, retirement, Namespace deletion). Not proven: a model turn, dedicated Codex, and any host other than the rig. The unrelated `provider Harness readiness` cases in `tests/conformance/kubernetes-compute.test.mjs` fail on unchanged `main` at this baseline.
