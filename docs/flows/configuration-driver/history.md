---
published: false
---

# Configuration Driver flow documentation history

This record preserves the dated changes to the Configuration Driver and Agent revision flow. See the [parent flow](../configuration-driver.md) for its context and overall sequence.

## Changelog

- 2026-10-09 13:00: Configuration create and delete register their compensation before the write and undo only what `inspectExact` shows they stored or removed, so a write that applied but answered an error leaves no orphan ConfigMap or metadata without one. (fix-916)
- 2026-10-09 12:00: Provisioning resends a Configuration create still missing after its 90-second settle window, and a Configuration update's compensation is registered before the replace, so a replace that applied but answered an error is rolled back too. (fix-911)
- 2026-10-06 15:00: Deployment admission refuses a native gateway setting Kubernetes Compute cannot deploy, naming it, instead of failing every preparation attempt. (dogfood-r36/deploy-gateway-settings)
- 2026-10-05 16:38: Trace owned temporary-file cleanup after filesystem Configuration write or rename failure. (authoring-run/794614ec-1b79-47ec-95ed-f11128b4c611 - 69b5c21806187125a7a20b9ca447bb15f6f3e890)
- 2026-10-03 16:30: Configuration writes reject reserved binding destinations and cross-Namespace Secret references as invalid requests instead of not-found, as provisioning does. (binding-400)
- 2026-09-23 13:13: Align provisioning Configuration creation and recovery with canonical CP storage. (codex/01a0cf72-6985-7712-ba92-d8cc32470f24 - df4ca4474d90de2d4ab0dd6f6d03a64ebb92526a)
- 2026-09-01 19:09: Trace Secret-binding admission and optional Sandbox transformation before immutable version creation; remove the obsolete TODO link. (01a05f95-dd80-7011-990f-d1c46b5bb3cc - aa366c49c44834d59f74994c5fd37fb8096f169f)
- 2026-08-28 17:58: Updated moved feature-reference links for the documentation organization. (01a036f4-cf1d-7cc1-bbc1-000879038ac8 - 4270aa29b7015562049f46c6027962fd85b584a9)
- 2026-08-27 00:05: Removed stale contract-suite commands and kept production-behavior conformance and integration verification. (01a036f4-cf1d-7cc1-bbc1-000879038ac8 - ab560806dbd945436835ab092ebd10bf3e50d942)
- 2026-08-25 08:46: Clarified API-level Configuration validation and development filesystem Driver persistence boundaries. (01a03630-cd9f-7352-9e64-1d30de98c7dd - 949e57ba008486c7ad60978df79dc53cce31bee9)
- 2026-08-21 20:53: Combined duplicate Configuration startup phases and narrowed verification to capability-specific tests and explicit infrastructure prerequisites. (01a0269c-0551-7f01-9dfc-ffb2a0896c94 - f6491502262d6190c95d2a910ee46283c30244f9)
- 2026-08-21 20:05: Kept the trace focused on Configuration ownership and linked the canonical Driver startup flow. (01a0269c-0551-7f01-9dfc-ffb2a0896c94 - b651c4ae38310032f8cda47c868a9b282fb12ff3)
- 2026-08-21 19:28: Clarified production package-backed IAM, Compute, and Configuration startup plus state-aware persisted IAM authorization refresh. (01a0269c-0551-7f01-9dfc-ffb2a0896c94 - a45b01d258c6a6b10db2301cad3303e2fa520f09)
- 2026-08-21 17:28: Updated Configuration Driver initialization to the single asynchronous Installation-and-Drivers startup path. (01a0269c-0551-7f01-9dfc-ffb2a0896c94 - d17a87541cbebc8e333bd00bd90c42e734d91a80)
- 2026-08-21 16:24: Clarified that production configuration reconciliation supports both embedded OpenClaw and dedicated Codex. (01a0259c-c825-71c3-8092-eb2afb161355 - 1379b0f500317e7f32559c711e31378eb22a8072)
- 2026-08-20 22:43: Documented immutable Agent-owned Kubernetes configuration mounts and deferred snapshot cleanup; clarified that Secret Broker credential resolution and current-head live-cluster proof are unavailable. (01a02141-dc9e-7242-8a4f-0c74e14eebd5 - fb2be5b5b514f29669bd62aaac70d7c835de68d0)
- 2026-08-20 22:26: Documented immutable Agent Configuration kind, monotonic generations, separate immutable version metadata, exact-resource authorization, and Compute-owned per-Agent gateway handoff. (01a02141-dc9e-7242-8a4f-0c74e14eebd5 - fb2be5b5b514f29669bd62aaac70d7c835de68d0)
- 2026-08-20 19:03: Removed duplicate OpenClaw credential validation; OCC preserves native JSON while OpenClaw and SecretBroker own configuration and secret semantics. (01a01add-3345-76a2-8bf2-221bf4075636 - ba62d21b422da3175ce0035162b05c19323c95e1)
- 2026-08-20 18:37: Documented native OpenClaw configuration documents, inline unresolved SecretRefs, centralized credential validation, single-entry ConfigMaps, and deeply immutable version snapshots. (01a01add-3345-76a2-8bf2-221bf4075636 - 2a82234a9214da410e75f94c07cd29aa165a6fa1)
- 2026-08-19 15:12: Documented singleton startup configuration, Driver schemas, exact Namespace ConfigMap CRUD, and immutable Agent revision admission. (01a01b65-5e90-78f0-b899-ce53454884c6 - 1e048452d44be143677c4a2b83c959979126846c)
- 2026-08-19 15:24: Clarified lazy ConfigMap authorization and unavailable live-cluster proof. (01a01b65-5e90-78f0-b899-ce53454884c6 - 1e048452d44be143677c4a2b83c959979126846c)
- 2026-08-19 16:19: Simplified runtime Driver selection and tracked version stability across Compute configuration changes as future work. (01a01b65-5e90-78f0-b899-ce53454884c6 - 0e8413ee880a21a2db9b83cbf952f6d565378d67)
