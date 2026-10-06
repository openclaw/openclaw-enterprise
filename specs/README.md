# Specifications

This directory holds architectural decisions and implementation plans:

```text
specs/
  rfcs/      Architectural proposals and decisions
  plans/     Implementation plans and delivery records
  .archive/  Preserved historical specifications
```

An RFC defines a decision; a plan describes its implementation. Plans can also
stand alone, and link relevant RFCs through `rfc` frontmatter. Use one Markdown
file per document, or a folder with `index.md` when companions are needed.
Browse [implementation plans](plans/) directly for delivery records.
See the [specification process](../docs/contributing/specifications.md) for
authoring, numbering, and review.

## RFCs

Status reports implementation progress, separately from the historical decision
in each RFC’s `status` frontmatter. The `implementation_status` field owns the
status represented by each emoji below.

Audited on 2026-10-05 against upstream `main` at
[`6dd5e6c3075a`](https://github.com/openclaw/openclaw-enterprise/commit/6dd5e6c3075acfb8ab74fd3f098b2708b5f115cc),
using source, current references, and existing verification coverage. This is a
source audit, not a fresh runtime test or release certification. **Implemented**
means the scoped delivery is present; **Partially implemented** means material
parts remain; **Not implemented** means the proposed capability is absent.
Explicitly separate future phases do not prevent a scoped delivery being complete.
Historical RFC bodies remain unchanged; notes below identify later amendments
and current gaps.

The Author column comes from each RFC’s `author` frontmatter. Treat the author
as the RFC owner; no separate owner field is maintained.

**✅ 8 implemented · 🟡 7 partially implemented · ❌ 4 not implemented.**

| RFC                                                                                                               | Status | Notes                                                                                                                                                                                                                                                                              | Author                                                 |
| ----------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| [RFC-0001: Generic OIDC sign-in for existing accounts](rfcs/0001-oidc-sign-in.md)                                 | ✅     | [OIDC sign-in](../docs/guides/deploy/oidc-sign-in.md) has provider validation, existing-account binding, session revocation, and Helm wiring. Live IdP qualification remains separate.                                                                                             | [@rclarke0](https://github.com/rclarke0)               |
| [RFC-0002: Agent workload tags](rfcs/0002-agent-workload-tags.md)                                                 | ❌     | No workload `tags` field in the [Agent/revision contracts](../packages/contracts/src/index.ts), API schema, or deployment path.                                                                                                                                                    | [@kevinlin-openai](https://github.com/kevinlin-openai) |
| [RFC-0003: Gateway–Harness storage split](rfcs/0003-gateway-harness-storage-split.md)                             | ✅     | [Separate Gateway/Harness storage](../docs/reference/drivers/kubernetes-compute/storage-and-credentials.md) and remote workspace I/O are present. The later memory/skills placement amendment applies.                                                                             | [@Kimiyu-186](https://github.com/Kimiyu-186)           |
| [RFC-0004: Initial OCC Prometheus metrics](rfcs/0004-occ-prometheus-metrics.md)                                   | ✅     | [Private API/worker metrics](../docs/reference/metrics.md), bounded collectors, Helm networking, and monitoring assets are present.                                                                                                                                                | [@russellb](https://github.com/russellb)               |
| [RFC-0005: Harness authentication bindings](rfcs/0005-harness-auth-binding.md)                                    | ✅     | [Harness authentication bindings](../docs/reference/harness-execution.md) flow through admission, immutable revisions, credential projection, and startup probes; supported topology limits still apply.                                                                           | [@kevinlin-openai](https://github.com/kevinlin-openai) |
| [RFC-0006: Basic RBAC for personal and team Agents](rfcs/0006-basic-rbac/index.md)                                | ❌     | The fixed role catalogue, Groups, creation profiles, and requester-bound invocation design are deferred. Existing [IAM](../docs/reference/authorization.md) does not implement this broader contract.                                                                              | [@freeqaz-openai](https://github.com/freeqaz-openai)   |
| [RFC-0007: GitHub sign-in for existing accounts](rfcs/0007-human-federated-sign-in/index.md)                      | 🟡     | [Federated sign-in](../docs/reference/authentication/external-sign-in.md), bound sessions, maintenance, and recovery replacement are present. M1.1 remains missing: an activated profile still refuses startup without any external provider.                                      | [@freeqaz-openai](https://github.com/freeqaz-openai)   |
| [RFC-0008: Repository credentials for ordinary Agents](rfcs/0008-repository-credentials/index.md)                 | ✅     | The scoped [team/GitHub App credential path](../docs/reference/repository-credentials.md) is implemented. Personal delegated-user access and protected-requester successors are explicitly later phases, outside this delivery scope.                                              | [@freeqaz-openai](https://github.com/freeqaz-openai)   |
| [RFC-0009: Native OpenClaw plugin tool policies](rfcs/0009-native-plugin-tool-policy.md)                          | 🟡     | [Native Diffs policy](../docs/reference/drivers/plugin-bundled.md) supports enablement and tool overrides. The generic native prompt/automatic-review gate and classification contract remain absent; RFC-0014 revises the policy vocabulary.                                      | [@stevenlee-oai](https://github.com/stevenlee-oai)     |
| [RFC-0010: Agent access](rfcs/0010-agent-access.md)                                                               | 🟡     | [Sharing with existing people](../docs/reference/console/agent-sharing.md) is present. Zero-grant enrollment, granular native permissions, and the RFC’s session-currentness/settlement guarantees remain incomplete.                                                              | [@freeqaz-openai](https://github.com/freeqaz-openai)   |
| [RFC-0011: Independent production image upgrades](rfcs/0011-coordinated-image-upgrade.md)                         | ✅     | [Upgrade command](../scripts/upgrade-production-images) separates controller and runtime changes, validates fleet inventory, waits for revisions, and runs Doctor. Live release qualification remains environment-specific.                                                        | [@RomneyDa](https://github.com/RomneyDa)               |
| [RFC-0012: Default production observability](rfcs/0012-production-observability.md)                               | ✅     | [Production observability](../docs/guides/observability.md) has default private metrics, operational-log collection, and the separate demo chart. Protected model-turn proof is distinct from credential-free acceptance.                                                          | [@russellb](https://github.com/russellb)               |
| [RFC-0013: Platform audit](rfcs/0013-platform-audit/index.md)                                                     | ❌     | No `read_platform_audit` permission, bounded State projection, cursor contract, or `/audit-events` endpoint. The existing audit ledger is only a prerequisite.                                                                                                                     | [@freeqaz-openai](https://github.com/freeqaz-openai)   |
| [RFC-0014: Plugin policy enforcement](rfcs/0014-plugin-policy-enforcement.md)                                     | 🟡     | [Driver policy validation and translation](../docs/reference/agent-plugins.md) are present, using the newer approval vocabulary. Native review modes remain unsupported; Codex reviewer checks do not cover later session/model changes or establish resume/reconnect enforcement. | [@stevenlee-oai](https://github.com/stevenlee-oai)     |
| [RFC-0015: Recover repository credential cleanup after broker loss](rfcs/0015-repository-credential-recovery.md)  | 🟡     | [Durable admission and terminal receipts](../docs/reference/repository-credentials.md) recover a recorded `DISPOSED` result. Provider-action recovery and settlement of active/uncertain sessions after broker loss remain unimplemented.                                          | [@kevinlin-openai](https://github.com/kevinlin-openai) |
| [RFC-0016: Credential Gateway Driver for Sandbox-injected credentials](rfcs/0016-sandbox-credential-injection.md) | 🟡     | [Static OpenAI credential sources](../docs/reference/drivers/openshell-credential-gateway.md) are present. External/refresh source types and combined repository-plus-Sandbox revisions remain unsupported; production qualification is pending.                                   | [@mrunalp](https://github.com/mrunalp)                 |
| [RFC-0017: Agent egress for 0.x](rfcs/0017-agent-egress-0x/index.md)                                              | 🟡     | [OpenShell integration](../docs/reference/drivers/openshell-sandbox.md) now includes credential injection and provider-owned network fencing. Production qualification and the Gateway-hosted secret-proxy path remain incomplete; ordinary Harnesses still allow public HTTPS.    | [@freeqaz-openai](https://github.com/freeqaz-openai)   |
| [RFC-0018: Installation profiles: openclaw and codex](rfcs/0018-installation-profiles-design/index.md)            | ✅     | The [shared renderer and two profiles](../docs/guides/deploy/installation-profiles.md), paired YAML outputs, preflight reporting, and managed Slack proxy are present. Rendering does not qualify an installed environment or its optional integrations.                           | [@kevinlin-openai](https://github.com/kevinlin-openai) |
| [RFC-0019: Additional Installation administrators](rfcs/0019-additional-installation-administrators.md)           | ❌     | Proposal only. The PR documents current behavior and implements no option.                                                                                                                                                                                                         | [@freeqaz](https://github.com/freeqaz)                 |
