---
author: kevinlin-openai
implementation_status: Not implemented
status: Proposed
---

# Feature Spec: Agent workload tags

**Date:** 2026-09-03
**Status:** Planning — draft awaiting review and user direction
**Owner:** OCC and Compute/Sandbox Driver maintainers

## Problem and Decision

Add a user-owned `tags` string map to each Agent and snapshot it into every
AgentRevision. Compute and Sandbox Drivers consume that immutable map during
per-workload preparation, allowing trusted driver code to select different
sandbox behavior for `usage=personal` and `usage=security`.

The current [Agent and revision contracts](../../packages/contracts/src/index.ts)
have no user tag field. Compute already receives revisions; Sandbox provisioning
and cleanup receive revisions, but its admission-time `configureAgent` hook
receives only native configuration. Reuse those seams rather than adding a
tag service or a second driver-selection mechanism.

## Scope

**Changes**

- Create, replace, clear, and read Agent tags through the existing Agent API.
- Persist tags and copy them into immutable revisions at deployment admission.
- Expose tags to Compute preparation/hooks and Sandbox admission/provisioning.
- Document and prove conditional driver behavior using the personal/security example.

**Does not change**

- Installation-selected driver identities, Namespace ownership, or permissions.
- Native OpenClaw configuration, Kubernetes ownership labels, or Secret storage.
- No tag query language, inheritance, bulk tagging, tag-specific API, console
  editor, generic policy engine, or live mutation of running workloads.
- `usage` has no built-in platform meaning; trusted driver authors own its meaning.

## Contract

### Agent API and ownership

Each Namespace-owned Agent owns one `tags: Readonly<Record<string, string>>`
map; it has no separate identity or shared references. Two Agents sharing a
Configuration may have different tags. Agent and AgentRevision reads always
return a map, including `{}`. Tags are non-secret metadata visible to callers
with the existing exact-resource read permission; never store credentials in them.

Extend the existing [Agent routes](../../packages/contracts/src/api/routes.ts):

| Operation | `tags` behavior |
| --- | --- |
| `POST /namespaces/:namespaceId/agents` | Optional; omission creates `{}`. |
| `PATCH /namespaces/:namespaceId/agents/:agentId` | Optional; omission preserves tags, a supplied object replaces the whole map, `{}` clears it. Keep the existing required `configurationId`. |
| Agent and revision list/read responses | Include `tags` in the existing `data` envelope. |
| `POST /namespaces/:namespaceId/agents/:agentId/deploy` | Remains bodyless; snapshots the saved Agent tags. |

Example Agent update body: `{"configurationId":"<existing-configuration-id>","tags":{"usage":"personal","team":"developer-tools"}}`.

Keys and values are case-sensitive strings, preserved without coercion or
normalization. Allow arbitrary names, not an enumerated vocabulary: at most
64 entries, keys of 1–128 Unicode characters, values of 0–1024 characters;
exclude NUL, which PostgreSQL JSON cannot represent. Reject null, arrays,
nested values, and violations with `400 INVALID_REQUEST`. Treat keys as data,
including `__proto__`; no assignment may mutate object prototypes.

Reuse existing create/update/deploy authorization and audit paths. A denied
write changes neither tags nor revision state. Tags do not establish trust:
claiming `usage=security` grants no additional privileges or credential access.

### Admission and driver lifecycle

OCC copies the locked Agent's tags in the existing deployment transaction,
passes the same frozen copy to Sandbox configuration, and persists it in the
new revision. Extend `SandboxDriver.configureAgent(configuration, tags)` with
the read-only map as its second argument. Its returned native configuration
still passes existing validation before admission; driver failure admits no revision.

Compute `prepareRevision`, activation, retirement, and `beforeWorkloadStart` /
`beforeWorkloadStop` hooks read `revision.tags`. Sandbox `provisionHarness` and
revision `cleanup` read `context.revision.tags`. Namespace hooks and
Installation startup are shared across Agents and must not use one Agent's tags
to configure shared infrastructure. “Bootstrap” here means per-revision workload
preparation, not loading the driver once at controller startup.

Edits affect only later deployments. Already queued, active, or retiring
revisions retain their original tags, including after worker restart. Drivers
must not reread mutable Agent tags through `bindAgent` to make revision decisions.
Keep stable Agent/revision resource identities, existing retry/cancellation
semantics, and exact-resource cleanup; changing tags cannot redirect cleanup.

Trusted driver code can branch directly on `revision.tags.usage`: choose a
personal sandbox policy for `personal`, a separate security sandbox policy for
`security`, and an explicitly safe default or rejection for other/missing values.
These are operator-approved policies, not caller-supplied manifests or code.
Both paths preserve required workload identity, approved mounts, credentials,
and baseline containment from the [Sandbox contract](../../docs/reference/drivers/sandbox.md).
Additional preparation steps remain idempotent and participate in existing cleanup.

Do not automatically copy arbitrary tags into Kubernetes selectors/labels,
environment variables, commands, or telemetry attributes. Existing
`HarnessWorkloadRequirements.labels` remain platform-owned. Drivers may explicitly
translate supported tags into validated backend settings without weakening
ownership or isolation. This spec enables driver-authored conditional behavior;
it does not add a bundled OpenShell YAML rule language or hard-code `usage` policies.

## Implementation

1. Extend [shared models and freezing](../../packages/contracts/src/index.ts),
   [HTTP resource schemas](../../packages/contracts/src/api/resources.ts), route
   request schemas, and controller HTTP projections with `tags`. Retain response
   envelopes and regenerate OpenAPI output from its source.
2. Extend [OCC Agent writes and admission](../../packages/occ/src/index.ts),
   [state interfaces/in-memory storage](../../packages/occ/src/state/platform-state.ts),
   and [PostgreSQL mappings](../../packages/occ/src/state/postgres-state.ts). Store
   Agent tags in `occ.agents.tags` JSONB and revision tags in `admitted_spec.tags`.
   Update [database constraints](../../packages/occ/src/state/postgres-schema.ts) and
   their owning schema change, including the admitted snapshot's allowed fields.
   Persisted-map validation belongs to the database; the memory adapter mirrors it.
3. Pass the frozen map to Sandbox admission; preserve it through the existing
   [worker](../../apps/controller/src/worker.ts), concrete Compute calls, and lifecycle
   dispatcher. Update installed-driver contract tests and fixtures; no new job,
   callback registry, policy resource, or parallel tag cache is required.
4. Add a trusted driver example that branches on the admitted tags and performs
   distinct sandbox preparation. Exercise it through real OCC admission and
   Compute-to-Sandbox dispatch, not a controller mock that invents the result.
   A selected backend integration must prove the two resulting sandbox policies
   differ and both retain identity/containment; report unavailable live proof explicitly.
5. During implementation update Agent, Compute, Sandbox, and lifecycle references
   together. Keep current docs unchanged while this remains a proposal, and
   preserve historical specs and user Manual Notes.

## Verification

| Required outcome | How to verify |
| --- | --- |
| API round-trip and clear/preserve semantics | Extend `tests/integration/occ-api.test.mjs` through real routes; cover create omission, replacement, clearing, reads, invalid maps, and exact-scope denial. |
| Durable immutable snapshot | Extend PostgreSQL persistence and `postgres-worker-agent-revision.test.mjs`: deploy personal, update to security, deploy again, restart worker; each revision retains its own tags. |
| Both drivers receive the admitted map | Conformance tests inspect actual Compute lifecycle and Sandbox admission/provision/cleanup inputs; attempted mutation cannot alter stored Agent or revision tags. |
| Conditional sandbox selection | Run the trusted example with each usage value through the selected backend; inspect actual sandbox policy and workload identity, plus its safe unknown-tag path. |
| Failed preparation stays contained | Existing lifecycle failure tests cover rejected tag policy, cancellation, retry, and exact-revision cleanup without weakening baseline isolation. |
| Untagged Agents remain usable | Explicit empty-map fixtures follow current supported Docker/Kubernetes and Sandbox topologies; no live resource is retagged by an Agent update. |

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-03 23:56: Drafted Agent workload tags and revision-scoped driver consumption; implementation and reviews pending. (01a05901-204b-7b52-b9da-527ee94cbf81 - f0b17b79e25b020e7cf1adb5ed143ef8adc502c2)
