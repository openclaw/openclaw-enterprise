---
rfc: ../rfcs/0040-runtimeclass-agnostic-deployment.md
---

# Implementation plan: remove OCE RuntimeClass configuration and the PSA exemption

- **ID:** TASK-0052
- **Delivery status:** In progress
- **Owner:** OCE deployment and OpenShell Sandbox Driver maintainers
- **Authority:** [Platform architecture](../../docs/design.md#implementation-status) and [OpenShell Sandbox Driver](../../docs/reference/drivers/openshell-sandbox.md)
- **Source baseline:** `81ab0a9fbe38cd2eea88f599a5e0ac9aad9c4f92`

## Outcome and scope

Remove Kubernetes RuntimeClass selection from OpenClaw Enterprise (OCE), rather
than make it optional. OCE does not configure, create, discover, validate, select,
or require a RuntimeClass. Remove installation-wide and per-Agent settings,
deployment defaults, development and CI provisioning, and the associated Pod
Security Admission (PSA) exemption. No OCE installation requires an API server
admission configuration change for OpenShell.

Runtime selection belongs to the operator's Kubernetes and independently managed
OpenShell configuration. With no external selection, Kubernetes uses each node's
default container runtime. OCE does not promise that every runtime is compatible.
OCE must not override an external runtime choice with its own default.

**User-selected assumption:** supported OpenShell no longer needs the exemption.
Remove it without a replacement bypass. Keep restricted tenant PSA and existing
network, filesystem, identity, and image controls. Actual PSA rejection blocks
delivery and requires investigation; do not silently restore an exemption.

This plan changes no Agent API authority, platform primitive, or node runtime.
Do not modify external clusters' admission configuration, introduce an alternative
runtime-placement API, or add migration procedures.

## Evidence and affected owners

OpenShell is the only bundled Sandbox Driver. The shared
[SandboxDriver contract](../../packages/contracts/src/drivers/sandbox/index.ts)
has no RuntimeClass setting; no other active bundled Driver selects one.
Externally supplied Driver packages are outside this source audit.

- [OpenShell Driver](../../apps/controller/src/drivers/sandbox/openshell.ts):
  requires `kubernetes.runtimeClassName`, permits it in `agentResourceOverrides`,
  and propagates it to Sandbox requests and native workspace preparation.
  [Struct encoding](../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts)
  rejects `undefined`, so removing a value requires removing its key too.
- [Installation template](../../docs/snippets/openshell-quickstart/kubernetes/installation.jq)
  and [OpenShell chart values](../../docs/snippets/openshell-quickstart/kubernetes/openshell-values.jq)
  hard-code `openshell-sandbox`.
- [Development OpenShell setup](../../internal/occdev/openshell.go) creates the
  class and PSA file. [Compose-backed startup](../../internal/occdev/up.go) and
  [Kubernetes-only startup](../../internal/occdev/openshell_k3d.go) mount the file
  and set the API server flag. [Installation rendering](../../internal/occdev/kubernetes.go)
  selects the class.
- [CI OpenShell setup](../../scripts/ci/openshell.ts),
  [cluster preparation](../../scripts/ci/k3d-preparation.ts), and
  [environment assembly](../../scripts/ci/prepare.mjs) create the class, inject
  the exemption, export settings, and probe exempt admission.
- [OpenShell fixture](../../tests/helpers/openshell-kubernetes-real.mjs),
  [workflow helper](../../tests/helpers/openshell-sandbox-workflows.mjs), namespace,
  and egress workflows propagate or require the class.

Pinned OpenShell `f3d976590d3eb1379690a2abaf0f0e26c21d487d` has an
[empty chart default](https://github.com/NVIDIA/OpenShell/blob/f3d976590d3eb1379690a2abaf0f0e26c21d487d/deploy/helm/openshell/values.yaml#L491-L496).
Its [workload/bootstrap](https://github.com/NVIDIA/OpenShell/blob/f3d976590d3eb1379690a2abaf0f0e26c21d487d/crates/openshell-driver-kubernetes/src/driver.rs#L7406-L7594)
and [supervisor](https://github.com/NVIDIA/OpenShell/blob/f3d976590d3eb1379690a2abaf0f0e26c21d487d/crates/openshell-driver-kubernetes/src/sandbox_runtime.rs#L578-L630)
run non-root, drop all capabilities, and disable privilege escalation. Source
inspection supports the assumption but does not replace no-exemption live proof.

## Selected contract

- Delete `kubernetes.runtimeClassName` and
  `kubernetes.agentResourceOverrides[].runtimeClassName` from Driver configuration.
  Reject these removed keys through the existing closed schema; do not accept
  and ignore them or retain compatibility aliases.
- Keep per-Agent CPU and memory overrides. Remove only their class-selection
  behavior; do not delete independently useful resource-sizing support.
- Send neither `template.runtime_class_name` nor Kubernetes
  `driver_config.pod.runtime_class_name`. Do not set `spec.runtimeClassName` on
  OCE-owned preparation Pods or render an OpenShell gateway class default.
- Remove RuntimeClass-specific readiness, preparation-adoption, validation, and
  bootstrap checks. Preserve checks of ownership and OCE-controlled content;
  do not broadly weaken Sandbox reconciliation to accommodate external mutation.
- Do not change the pinned upstream protobuf definition merely to erase the
  field name. A protocol field is not an OCE configuration capability. Audit
  upstream-error handling separately: remove obsolete feature-specific branches
  while preserving generic failure reporting and sanitization.

## Implementation

1. **Submit the Driver contract proposal before coding.** Removing configuration
   members and behavior requires RFC submission for human review. Submit a focused
   RFC or an owner-approved amendment to
   [RFC-0038](../rfcs/0038-operator-scratch-volumes.md), then link it in this plan's
   frontmatter. Its per-Agent RuntimeClass decision is affected. Submission permits
   implementation alongside review unless a specific hold applies.

2. **Remove Driver ownership of runtime selection.** Delete the two option fields,
   schema properties, validators, resolution code, outbound fields, and
   RuntimeClass-specific preparation-adoption comparison. Keep resource sizing,
   ownership, and other spec checks. Exercise real gateway create/get and adoption
   to determine the representation of an unsent protobuf string; normalize only
   confirmed wire defaults, not unrelated fields or arbitrary spec differences.

3. **Remove deployment selection.** Delete the class entries from both jq
   templates and related installation instructions. Do not replace them with
   optional arguments, environment variables, or an explicit empty class setting.
   Remove selections from shared and namespace-owned gateway setup. Leave upstream
   chart configuration to its owner. The OCE chart and generic installation-profile
   renderer gain no runtime-placement setting.

4. **Delete development provisioning and exemption plumbing.** Remove the class
   constant, manifest/apply stage, forced gateway flag, PSA generator and path
   constant, and generated Installation field. Remove callers, admission-path
   parameters, mounts, and API server flags from both startup paths. Prune the
   obsolete `openshell-runtime-class` reporter stage. Retain unrelated node/image
   pinning, loopback binding, and restricted tenant labels.

5. **Delete CI and fixture dependencies.** Remove RuntimeClass creation/lookups,
   named containerd-handler inspection, exemption generation/mounts/flags, and the
   probe that expects a privileged Pod to be admitted. Remove the class/handler
   bootstrap and state fields, exports, suite requirements, and
   `OCC_TEST_OPENSHELL_RUNTIME_CLASS` / `OCC_TEST_OPENSHELL_RUNTIME_HANDLER` inputs.
   Update namespace-driver, static-egress, and connected-egress input contracts
   and callers; leave no hidden `openshell-sandbox` fallback. Retain useful runtime
   smoke diagnostics with a class-free Pod, without naming a particular handler.

6. **Replace obsolete tests with supported-workflow proof.** Update Go launcher
   checks, `ci-openshell-preparation.test.ts`, cluster-preparation fixtures,
   Sandbox startup/adoption cases, and lane registration. Delete explicit-class
   and per-Agent class tests; retain their independent resource-sizing coverage.
   Verify removed settings are refused and generated requests omit selection.
   Mocked command success is not evidence that real PSA admits OpenShell.

7. **Update current documentation with implementation.** Remove class requirements
   and OCE class-selection examples from Driver/Compute references, Kubernetes/EKS
   setup, namespace gateways, snippets, development guides, and testing pages.
   Update existing provisioning, Compose-development, and CI-preparation flows
   against source. Keep kernel compatibility, storage, node placement, and
   isolation requirements. Remove test-variable inventories from testing owners;
   check affected cheat sheets. Preserve historical specifications and upstream
   protocol records. No architecture-overview change is planned: primitive
   ownership and trust boundaries stay unchanged.

## Verification

Required proof is listed below; executed checks and gaps are recorded afterward.

| Required outcome                      | Real proof                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OCE has no RuntimeClass configuration | Real Driver registration accepts class-free input and rejects both removed keys. Render paired inputs and real charts; inspect requests, gateway values, preparation Pods, and launcher/CI arguments. Audit remaining references for upstream protocol or historical ownership.                                                                                                 |
| No-exemption deployment works         | Use fresh disposable loopback k3d with no RuntimeClass objects, no custom PSA exemption, restricted tenant namespaces, and enforcing NetworkPolicies. Helm-install paired templates and OCC/PostgreSQL. Deploy real Codex and native OpenClaw Agents through the API and durable worker; prove model turns, native workspace preparation, reconciliation/adoption, and cleanup. |
| Both development modes work           | Extend existing `local-first-agent-openshell-real.test.mjs`, `local-first-agent-openshell-k3d-real.test.mjs`, and relevant `dev-up` coverage. Neither startup path mounts an admission file or supplies its API server flag.                                                                                                                                                    |
| PSA remains effective                 | Real privileged and forbidden-capability Pods are rejected in the tenant namespace while actual OpenShell workloads are admitted. Retain network and filesystem enforcement checks.                                                                                                                                                                                             |
| Independent sizing still works        | Retain installation and per-Agent CPU/memory override coverage, including invalid quantities and effective request/limit checks.                                                                                                                                                                                                                                                |
| CI runs the proof                     | Update OpenShell and launcher lane descriptors; audit selection. Run focused integrations, Go checks, typecheck, lint, formatting, workspace isolation, and docs checks. Register new erasable-TypeScript tests in CI.                                                                                                                                                          |

Live proof needs the [Kubernetes prerequisites](../../docs/testing/kubernetes.md),
a compatible default node runtime, approved immutable images, authorized model
credentials, and dedicated disposable databases with separate migrator/application
roles. External PostgreSQL uses administrator-created `openclaw_k8s_*` databases.
Preserve default kubeconfig and unrelated resources. Missing prerequisites or
skipped cases leave proof incomplete; do not replace dependencies with mocks.

## Blockers and delivery record

- RFC-0040 was submitted in [PR #6335](https://github.com/openclaw/openclaw-enterprise/pull/6335)
  at `edbe5ec43` before implementation. Its decision remains Proposed.
- Implementation removes both Driver settings, emitted class fields, development
  and CI class creation, handler requirements, and API server PSA exemption setup.
  CI now checks privileged and forbidden-capability rejection without an exemption.
  The upstream wire schema and sanitized provider error recognition remain protocol
  concerns, not OCE placement configuration.
- Current owners updated: OpenShell/Compute references, Kubernetes/EKS and remote
  Harness guides, paired snippets, three affected flow pages, and testing guides.
  No public API or supported environment-variable cheat-sheet inventory changed;
  removed test selectors belonged to CI descriptors. No image pins changed.
- `pnpm typecheck`, `pnpm lint`, `pnpm check:workspace`, formatting, and CI suite
  selection audit pass against the implementation worktree based on `edbe5ec43`.
  `go test ./internal/occdev` passes. `pnpm docs:check` validates 352 pages,
  5,880 links, and 127 specifications; no page exceeds its allowed hard limit.
- Focused integration commands selecting Sandbox startup, configuration, workspace,
  Codex, IPv6, CI OpenShell/preparation, and adjacent admission/registration cases
  report **575 passed, 0 failed, 8 skipped**. Skips require native runtime or
  production controller images. These prove composed source and harness behavior,
  not a real OpenShell deployment.
- Full conformance reports **3692 passed, 3 failed**: repository-credential container
  tests find host `/usr/bin/gh` 2.97.0 instead of pinned 2.103.2. A focused retry
  selecting the installed 2.103.2 binary then fails because `node:24-bookworm` is
  absent locally. These unrelated fixture prerequisites remain unresolved.
- Required no-exemption model turns and both live launcher workflows remain
  **unverified**: authorized model credentials, selected runtime/controller images,
  and disposable database inputs are not configured. No integration waiver is
  assumed; keep delivery In progress and the PR draft until proof is complete.
- Main provisioning and development flow validators pass. The CI-preparation
  companion remains a linked fragment, not a standalone flow; the standalone
  validator reports its pre-existing missing top-level sections. Keep long current
  references/flows together because each owns a complete existing workflow;
  remove repetition rather than split this change into competing behavior owners.

## Manual Notes

## Changelog

- 2026-11-16: Submitted RFC-0040, implemented removal, and recorded source checks
  and remaining live-proof prerequisites in PR #6335; baseline `edbe5ec43`;
  session `01a1e535-91ca-7273-913f-aaacfd69c1c2`.

- 2026-11-16: Revised at the user's direction to remove OCE RuntimeClass ownership
  completely, including installation and per-Agent options. Baseline
  `81ab0a9fbe38cd2eea88f599a5e0ac9aad9c4f92`; session
  `01a1e535-91ca-7273-913f-aaacfd69c1c2`.
- 2026-11-16: Revised scope at the user's direction: remove development and CI
  RuntimeClass provisioning and PSA exemption plumbing, retain optional placement,
  and require restricted-PSA workflow proof. Baseline
  `81ab0a9fbe38cd2eea88f599a5e0ac9aad9c4f92`; session
  `01a1e535-91ca-7273-913f-aaacfd69c1c2`.
- 2026-11-16: Created TASK-0052 from source inspection at
  `81ab0a9fbe38cd2eea88f599a5e0ac9aad9c4f92`; session
  `01a1e535-91ca-7273-913f-aaacfd69c1c2`.
