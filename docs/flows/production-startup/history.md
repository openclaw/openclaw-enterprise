---
published: false
---

# Production startup documentation history

This record preserves the dated changes to the production startup flow. See the [parent flow](../production-startup.md) for its context and overall sequence.

## Changelog

- 2026-10-09 22:28: Refuse invalid database ports before rendering NetworkPolicies. (authoring-run/4363ed9a-5724-4d4f-a14d-f1bc0485443e - dc95c2261d4b46cff8aca703e13e43cdd71d153e)
- 2026-10-09 23:51: Refuse custom Gateway hostnames Compute rejects during production configuration loading. (authoring-run/0d8da3d8-474a-4801-9887-230406a6b7bd - 5b9dd76c497c1b552a2651ee4b984978cdef0a93)
- 2026-10-09 22:22: Validate release Namespace labels before Helm rendering. (authoring-run/25ae11d6-4539-4513-9b2a-24d10996f971 - 7f358117e68076912a6062411d363e920a0e6adb)
- 2026-10-09 22:25: Refuse database CA paths that duplicate active database-client mounts before Kubernetes admission. (codex/01a12074-7896-7f63-99fe-9f42e9041d02 - 7f358117e)
- 2026-10-09 21:04: Refuse fractional routing ports before Helm emits Kubernetes resources. (authoring-run/b1433176-2fef-435b-bc30-c52bc7fa09e4 - 78677c21f)
- 2026-10-06 16:25: Admit IPv6 HTTP loopback origins through the existing production bootstrap verification exception. (authoring-run/f8a921de-7cd3-48d1-8355-98e3a6d05d02 - 3395f6f8e71757319b566f369fe0ad2853051bc5)
- 2026-10-05 12:10: Bound initialization hook names for valid long Helm releases. (authoring-run/54e33467-f3d2-4f4e-afad-952157ec12f0 - 4cda6515736280ca39f0fbe92cff78194b2c3638)
- 2026-10-05 06:59: Preserve bootstrap Pod namespace strings. (01a0f9e4-a0bf-76f1-acdb-e6b55ada490a - 66a4a07028fd0a08c29ea80e8f95cadc48a74932)
- 2026-10-05: Name Preset file failures `PRESET_FILE_INVALID`.
- 2026-10-04: Poll the startup probe every second.
- 2026-10-04: Time API startup phases in `listening`.
- 2026-10-04: Add the API startup probe.
- 2026-10-04: Log the API's shutdown start and completion.
- 2026-10-04: Describe API shutdown timing against the Pod termination grace.
- 2026-10-01 16:32: Trace scoped OpenShift DNS backend grants for Helm-managed production workloads. (authoring-run/e288dbbe-6d08-4251-adaa-860443c31b44 - 4070b6ad5ec6aff03c9c5e49e504a90393ffe091)
- 2026-09-29: Merge current main into release-scoped shared egress documentation. (PR-187)
- 2026-09-24 08:54: Describe release-scoped shared egress and dedicated collector/bootstrap policies. (PR-187 - 5ebd7305b0876db33276a249934bc82073b63424)
- 2026-09-27 08:51: Document API-only Slack directory proxy egress and disabled default. (01a0df20-f340-7810-bb59-b1df6c0bbbd3 - 1a2764952c421bfee00ed6892714366292c2741a)
- 2026-09-24: Record the post-bootstrap Kubernetes Installation identity marker used by coordinated upgrades.
- 2026-09-25 12:02: Document optional API model-discovery egress in the accompanying chart change. (01a0cf72-6985-7712-ba92-d8cc32470f24 - b2521074873ca46e1a5024248852a32b97cfc8a9)
- 2026-09-24 18:02: Trace private Envoy placement on the control-plane pool in the accompanying chart change. (01a0cf72-6985-7712-ba92-d8cc32470f24 - 92fb7cdfdf672fe476993e2cfd96a73a75c43ac2)
- 2026-09-21 05:32: Reconcile accompanying platform credential documentation with current source history and native Git boundaries. (authoring-run/fba2d7fa-6603-465e-a7c8-df0375ad202d - a051a2406eec7cafde2e0dd5e2ec63dba6ce1581)
- 2026-09-19 23:54: Reconcile RepoDriver ownership, private status projection, and separate emitted service/client paths. (public authoring-run/73c80a5e-4d0c-4e72-b989-0cf9963c6593 - e5b5a5489f078d08272523476bdbcd0b9162c946)
- 2026-09-18 03:03: Trace optional repository Driver composition and service-only projected input startup. (8500b2da103063b4503b62e5529f3910513e84a9)
- 2026-09-21 03:38: Trace canonical migration preflight and fail-closed initialization. (authoring-run/10020664-226c-401f-a499-199fb7f18c9c - 5f9a9903239a84224a755610339f3bf0443c171f)
- 2026-09-18 21:48: Clarify that control-plane node placement is optional unless configured. (authoring-run/23a79228-a1f4-4d9d-adb6-4c2a77d6b43f - db8547ffe19cd3317309b526d80e1d19af4c8a9a)
- 2026-09-18 17:09: Document multi-endpoint Helm egress values and control-plane node placement. (authoring-run/6fe8e24c-8bd5-489b-b76c-ca7d0a22c14b - 724dcb5cb80b5e76a62e8267a21185a2e91a85c2)
- 2026-09-17 12:56: Trace the advisory Kubernetes 1.35 startup preflight and warning handoff. (authoring-run/a6571e7c-996e-4f11-9c4c-f61418a8d109 - 324fe2d17f3856cd1602a57e4d8aa99a34d6514c)
- 2026-09-01 19:09: Document initial default Namespace creation and unchanged repeat-bootstrap behavior. (codex/01a05ef1-ee29-7941-80f2-448bb0789969 - 872fa544c98bb7ad11b2d92d777e49229ececbf5) (01a05f95-dd80-7011-990f-d1c46b5bb3cc - aa366c49c44834d59f74994c5fd37fb8096f169f)
- 2026-09-01 12:58: Trace production bootstrap-volume preparation, Helm startup, and authenticated Installation proof. (codex/01a05e87-6c64-7960-b9c2-f444d4a3d737 - bdb846c38d5dae6085a8841f720c93068ba8ad15)
- 2026-09-01 10:19: Validate Provider configuration at startup and exact saved ownership at use, preserving API repair access. (01a05d6b-e21d-7fc0-b1bd-b5cb15b365c6 - 1c7eae4d11e6c474cc7f1bbbb05d2c2e7052a158)
- 2026-09-01 08:47: Trace Provider membership, API-only client injection, and persisted ownership checks. (01a05d97-f2b0-71d0-bfc3-01ee7d6d58f9 - b079c4b755ef336a9c65bb4eb737e3aedbfdaa7d)
- 2026-08-31 22:29: Remove automatic bootstrap recovery; preserve artifacts after any error and require manual repair. (01a05a3d-526f-7553-8cd8-070bd1847acb - 94a5440898bf331987148d7733f0075506af64a6)
- 2026-08-31 20:33: Trace the shared installation initializer, startup ordering, and initializer-owned credential delivery. (01a05a3d-526f-7553-8cd8-070bd1847acb - b6f213cbcee11ba3dd69886c936c7e5abe233eb3)
- 2026-08-31 17:43: Document fresh human/service administrator bootstrap, private key delivery, and operator recovery. (codex/01a05a69-3fbe-7441-9e6d-20394758cf94 - 0797098646028ac00cb26cd4afcbc9b2cf8bcb24)
- 2026-08-28 17:54: Separated Helm execution from the deployment walkthrough and included optional Sandbox Driver startup ownership. (01a036f4-cf1d-7cc1-bbc1-000879038ac8 - 4270aa29b7015562049f46c6027962fd85b584a9)
- 2026-08-25 03:43: Added the production Helm initialization, protected administrator bootstrap, private OCC API, independent worker, and readiness startup flow. (01a036f4-cf1d-7cc1-bbc1-000879038ac8 - 2e9769c751d7)
