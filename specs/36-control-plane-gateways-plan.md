# Control-plane Gateway placement execution plan

## Outcome and scope

OCC's Kubernetes Compute Driver deploys each dedicated Agent Gateway in a
managed control-plane runtime namespace and its Harness in the tenant data-plane
namespace. Both retain exact logical Namespace/Agent/revision ownership. Embedded
execution stays in the data plane because its Gateway also executes the Harness.
The authoritative architecture remains `docs/design.md` and its workload chapter.

Base: `b141ba1157c2f28276717d35c8c63028f209a479`.

## Decisions

- Keep placement inside Kubernetes Compute; use existing worker and Driver lifecycle.
- Allocate one Gateway runtime namespace per logical Namespace, preserving tenant
  isolation rather than co-locating tenants with controller credentials.
- Gateways have separate ServiceAccounts, private PVCs, configuration and admitted
  credential material. They receive no Harness model credential or workload token.
- Use explicit cross-namespace DNS and exact-owner network peers. Keep the paired
  node's private authenticated route. Do not claim mTLS for existing token-based
  app-server transport.
- Keep stop, revision retirement, Agent deletion and Namespace deletion distinct;
  preserve durable Agent state until final deletion, including partial failure.
- Runtime release pins, dedicated OpenClaw workers, remote Skills features, custom
  bootstrap paths, and live deployment are outside this change.

## Work

- [x] Inspect current design, interfaces, callers, lifecycle and split-storage implementation.
- [x] Reuse a clean worktree from a merged PR; pin fresh main without changing other work.
- [x] Implement placement, credential delivery, routing, networking and lifecycle.
- [x] Update production packaging and development/fixture configuration.
- [x] Extend regular Kubernetes integration to check cross-namespace placement,
      allowed/denied connectivity, replacement and exact-owner cleanup.
- [x] Update architecture, references, setup and the existing execution flow.
- [x] Run focused local type, lint, formatting, documentation and packaging checks.
- [ ] Run real Kubernetes fixtures and runtime replacement/reconnect acceptance
      with the required disposable cluster, database and compatible runtime images.

## Acceptance

Dedicated preparation and activation create Gateway resources only in the Gateway
runtime namespace and Harness resources only in the tenant namespace. Same-Agent
transport succeeds; other Agents and Namespaces cannot use it. Stale retirement
does not remove an active Gateway, its route or its state. Stopping retains state;
Agent deletion removes only owned resources in both targets. Namespace deletion
cannot delete another tenant or shared controller infrastructure. Missing placement,
permissions or credential delivery fails explicitly without a data-plane fallback.

## Evidence and open checks

Source inspection: current storage split removed the common workspace mount but
Gateway placement, Secret references, app-server DNS and network peers still assume
one namespace. Existing lifecycle and runtime status callers must all select the
correct target. Runtime fixtures and real model proof must be reported separately.

Current references: [Kubernetes Compute](../docs/reference/drivers/kubernetes-compute.md)
and [current architecture](../docs/ARCHITECTURE.md). This change does not deploy
the implementation or relocate existing runtime volumes.

Local checks:

- Kubernetes Compute and runtime-credential conformance plus production Helm
  packaging: 142 passed, zero failed or skipped with
  `node --test tests/conformance/kubernetes-compute.test.mjs
tests/conformance/kubernetes-runtime-credentials.test.mjs
tests/integration/production-kubernetes-packaging.test.mjs`.
- Direct installed TypeScript build, changed-file ESLint and Prettier, workspace
  boundary verification, documentation length/link checks and both flow validators.
- `GOPROXY=off go test ./internal/occdev` compiles the changed Go package; it has
  no Go test files. Full CLI tests are unavailable because an existing required
  dependency is not cached.

The existing installed dependency graph differs from the manifest: the direct
TypeScript check uses installed TypeScript 7, not the manifest's TypeScript 6 alias.
Dependencies were not installed or reconciled. Exact-lockfile CI remains required.
The broader configuration-startup suite has two repository-configuration schema
failures reproduced on the unchanged base with the same installed graph.

Real-cluster discovery explicitly skipped the selected suites: no disposable k3d
cluster, dedicated test database or runtime image selectors were supplied. The
fixture changes have not established cross-node policy enforcement, real model
turns, replacement, or reconnect. Staging/model E2E is separately owned. Runtime
pins and actual disjoint node-pool placement remain deployment prerequisites.

The existing deployment, routing and Kubernetes testing guides remain together
despite exceeding the 1,500-word review threshold: each owns a complete setup or
acceptance workflow, including its permission and recovery requirements. All
changed documents remain below the 2,500-word hard limit.
