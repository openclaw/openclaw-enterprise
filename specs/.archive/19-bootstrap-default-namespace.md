# Feature Spec: Bootstrap default Namespace

**Date:** 2026-09-01
**Status:** Completed — implemented and locally verified in PR #11; merge and deployment are outside this task.
**Owner:** OpenClaw Control Plane

## Problem and Decision

A fresh Installation should provide a usable initial platform Namespace without
requiring a separate creation request. Create a Namespace named `default`
through the existing authorized OCC creation and worker lifecycle.

This records the user-approved task implemented in
[PR #11](https://github.com/openclaw/openclaw-enterprise/pull/11), initially at
`4e454bde137f6a2d37ca750ae07c303b4286ac4b` over upstream
`872fa544c98bb7ad11b2d92d777e49229ececbf5`. The implementation predates this
specification. The subsequent swarm pass reviewed the contract, simplified
repeated test assertions, and independently verified the applicable evidence.
The [platform design](../../docs/design.md) remains authoritative, and
[Namespaces](../../docs/reference/namespaces.md#initial-namespace) owns current behavior.

## Scope

- Fresh CLI initialization in development and production, and the supported
  `POST /installation/bootstrap` route, create the initial Namespace.
- Existing-Installation bootstrap preserves Namespace and user configuration.
- Keep custom Namespace creation through `POST /namespaces`.
- No backfill, default Agent, new settings, migration, retry subsystem,
  privilege shortcut, or live Installation mutation is included.

## Contract

1. OCC assigns the Namespace ID and singleton Installation ownership. `default`
   is a platform name; it does not select Kubernetes' built-in default namespace
   or imply `existingNamespace` adoption.
2. Bootstrap calls `OpenClawController.createNamespace` as its administrator
   Principal, using the selected IAM Driver and ordinary Namespace `create`
   authorization. The CLI selects native IAM over its existing bootstrap seed;
   it does not introduce separate authorization rules.
3. Installation/IAM state, the Namespace in `provisioning`, its durable work,
   and bootstrap audit commit in one existing platform transaction. Better Auth
   accounts, service keys, and protected output retain their existing separate
   lifecycle and failure/recovery contract.
4. The worker reauthorizes the recorded actor, invokes the selected Compute
   Driver, and marks the Namespace `ready` only after backing infrastructure is
   ready. Bootstrap success does not establish readiness. Production still
   requires operator-supplied tenant RoleBindings.
5. The initializer's existing-Installation branch verifies the configured
   administrator and makes no Namespace changes. It neither duplicates nor
   recreates an initial Namespace; existing Configuration and Agent state stay
   intact. Repeated HTTP bootstrap retains its `409` response.
6. Authorization failure or an uncommitted platform transaction does not leave
   a partial Namespace/work item. An ambiguous commit still requires the
   [existing recovery procedure](../../docs/guides/deploy/service-keys.md#recover-an-incomplete-bootstrap).
   Concurrent initializers use existing singleton/transaction constraints.

## Implementation

1. Reuse the shared `default` name in [OCC](../../packages/occ/src/index.ts), and
   invoke normal Namespace creation inside the CLI and HTTP bootstrap transactions
   in [the initializer](../../scripts/bootstrap-installation.mjs) and
   [the API](../../apps/controller/src/index.ts).
2. Keep tests at the supported HTTP, native IAM, PostgreSQL, and worker boundaries.
   Preserve distinct authorization, concurrency, rollback, retry, and configured
   Namespace-state evidence; remove redundant branch-only setup/assertions.
3. Update the quickstart, deployment guide, current reference, and
   [development](../../docs/flows/docker-compose-development.md) and
   [production](../../docs/flows/production-startup.md) startup flows. Users discover
   the platform ID through `GET /namespaces`; Kubernetes operators discover the
   backing namespace by its existing `openclaw.dev/namespace` label before RBAC.
4. Complete independent code, simplification, docs, and dead-code reviews;
   verify the final delta and publish the scoped PR. No merge or deployment is requested.

## Verification

| Required outcome                                 | Proof and boundary                                                                                                                                       |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fresh default is discoverable and usable         | HTTP bootstrap and Namespace/Agent API tests; actual CLI plus Docker worker smoke reaches `ready` with one owned network and zero Agents.                |
| Namespace creation permission remains required   | Native-IAM HTTP test denies Namespace create while allowing Installation administration; verifies denied audit, absent resources, and a permitted retry. |
| Concurrent/repeated calls do not duplicate state | Real PostgreSQL bootstrap failure/concurrency tests count Namespace and work rows; production bootstrap reruns retain their IDs.                         |
| Existing user configuration survives             | Production HTTP before/after reads preserve Namespace, Configuration values, and Agent associations after repeated CLI bootstrap.                        |
| Failures preserve existing recovery guarantees   | PostgreSQL rollback and lost-commit-acknowledgement cases include Namespace/work accounting; existing protected-output tests remain.                     |
| Documentation and package boundaries agree       | Build/typecheck, workspace, formatting, OpenAPI, flow validators, links, and deployment shell syntax checks.                                             |

Evidence from the original implementation includes 169 conformance/API/service-key/
bootstrap-output tests, seven targeted PostgreSQL tests, and a real Docker
Namespace smoke. Reuse only evidence whose code, tests, and runtime inputs remain
applicable. Live Kubernetes and model-turn proof are outside this scoped change;
fixture-backed API tests do not establish those outcomes.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-01 15:26: Complete the scoped implementation and independent swarm verification; archive this implementation record and retain the Namespace reference as current behavior. (01a05ef1-ee29-7941-80f2-448bb0789969 - eb311f6cf40a424937f6d4fa1c458f4a1dbc171b)
- 2026-09-01 15:08: Record the approved default-Namespace contract and remaining swarm gates after the initial implementation. (01a05ef1-ee29-7941-80f2-448bb0789969 - 4e454bde137f6a2d37ca750ae07c303b4286ac4b)
