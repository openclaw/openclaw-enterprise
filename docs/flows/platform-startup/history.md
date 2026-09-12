# Platform startup documentation history

This record preserves the dated changes to the platform startup flow. See the [parent flow](../platform-startup.md) for its context and overall sequence.

## Changelog

- 2026-09-01 19:09: Validate Provider configuration at startup and exact saved ownership at use, preserving API repair access. (01a05d6b-e21d-7fc0-b1bd-b5cb15b365c6 - 1c7eae4d11e6c474cc7f1bbbb05d2c2e7052a158) (01a05f95-dd80-7011-990f-d1c46b5bb3cc - aa366c49c44834d59f74994c5fd37fb8096f169f)
- 2026-09-01 08:47: Trace Provider membership, API-only client injection, and persisted ownership checks. (01a05d97-f2b0-71d0-bfc3-01ee7d6d58f9 - b079c4b755ef336a9c65bb4eb737e3aedbfdaa7d)

- 2026-08-31 22:29: Remove automatic bootstrap recovery; preserve artifacts after any error and require manual repair. (01a05a3d-526f-7553-8cd8-070bd1847acb - 94a5440898bf331987148d7733f0075506af64a6)

- 2026-08-31 20:33: Trace the shared installation initializer, startup ordering, and initializer-owned credential delivery. (01a05a3d-526f-7553-8cd8-070bd1847acb - b6f213cbcee11ba3dd69886c936c7e5abe233eb3)

- 2026-08-31 17:43: Document fresh human/service administrator bootstrap, private key delivery, and operator recovery. (codex/01a05a69-3fbe-7441-9e6d-20394758cf94 - 0797098646028ac00cb26cd4afcbc9b2cf8bcb24)

- 2026-08-28 21:20: Removed local-test Compute Driver startup references; retain Docker and Kubernetes runtime ownership. (01a036f4-cf1d-7cc1-bbc1-000879038ac8 - 3ec166eb5fae39ed0f51ffb5ebd93338c4a2db94)
- 2026-08-28 17:58: Updated moved feature-reference links for the documentation organization. (01a036f4-cf1d-7cc1-bbc1-000879038ac8 - 4270aa29b7015562049f46c6027962fd85b584a9)
- 2026-08-25 08:46: Clarified that supported development startup requires PostgreSQL, API-only filesystem configuration storage, and Docker runtime-image inputs. (01a03630-cd9f-7352-9e64-1d30de98c7dd - 949e57ba008486c7ad60978df79dc53cce31bee9)
- 2026-08-24 22:43: Updated PostgreSQL-backed development startup for Docker Compute and API-only filesystem Configuration defaults. (01a03630-cd9f-7352-9e64-1d30de98c7dd - 63890cf94cfc15f848f62f8f957eb766d2101f55)
- 2026-08-24 23:46: Distinguished shared Installation Drivers from API-only provider initialization, mounted admin authority, and dedicated account-Secret projection. (01a03542-30ff-77a1-9967-587d55548ace - 51033bee121374332df2791e90e2290a5c892e5d)
- 2026-08-24 19:46: Pass platform state directly to process-local IAM Drivers. (01a036c0-9a0e-7ee0-8428-17824f5172a0 - 786b7ce)
- 2026-08-24 17:12: Documented stable API and worker IAM Drivers with current-policy identity lookup and authorization. (01a0352c-debe-73b1-baa6-379855af874f - 4502d7e)
- 2026-08-24 17:12: Removed IAM policy snapshots and Driver replacement; API and worker Drivers load current policy for every authorization decision. (01a0352c-debe-73b1-baa6-379855af874f - 4502d7e) (NOT_IN_SPEC)
- 2026-08-21 20:53: Merged duplicate Installation startup phases and retained process ownership, Harness topology, and real-infrastructure verification boundaries. (01a0269c-0551-7f01-9dfc-ffb2a0896c94 - f6491502262d6190c95d2a910ee46283c30244f9)
- 2026-08-21 20:05: Scoped startup documentation to process ownership and the single state-aware Driver bundle; delegated package details to their owning flow. (01a0269c-0551-7f01-9dfc-ffb2a0896c94 - b651c4ae38310032f8cda47c868a9b282fb12ff3)
- 2026-08-21 19:28: Documented production-capable packaged IAM, Compute, and Configuration with persisted IAM refresh and capability-owned preflight. (01a0269c-0551-7f01-9dfc-ffb2a0896c94 - a45b01d258c6a6b10db2301cad3303e2fa520f09)
- 2026-08-21 17:28: Updated independent API and worker startup to consume the single asynchronous Installation-and-Drivers result. (01a0269c-0551-7f01-9dfc-ffb2a0896c94 - d17a87541cbebc8e333bd00bd90c42e734d91a80)
- 2026-08-21 16:27: Clarified OCC lifecycle ownership for external Driver construction after factory simplification. (01a0269c-0551-7f01-9dfc-ffb2a0896c94 - 4fe8091c5f7faa1a56445beb022e075b59787bee)
- 2026-08-21 16:24: Corrected production worker startup and execution to support both embedded OpenClaw and dedicated Codex. (01a0259c-c825-71c3-8092-eb2afb161355 - 1379b0f500317e7f32559c711e31378eb22a8072)
- 2026-08-21 16:19: Documented installed Configuration Driver startup and external Compute selection while preserving bundled Kubernetes ownership. (01a0269c-0551-7f01-9dfc-ffb2a0896c94 - 9e356f7228c51fe68d85327cf7b47dbd04e420a4)
- 2026-08-21 11:39: Corrected production AgentRevision processing, per-Agent gateway ownership, active routing, and real-runtime verification boundaries. (01a0259c-c825-71c3-8092-eb2afb161355 - 9ae2efc1899a69463e7cab463e12a4ad27113f8d)
- 2026-08-20 15:40: Traced independent API and worker startup, shared singleton Installation selections, process-local Drivers, PostgreSQL coordination, and tenant-runtime handoff. (01a01fd2-0582-7702-a51d-c742deee0089 - 15219a570d00d9ef30dfaa090e7ee1b23dfa0201)

## Related

- [Return to the parent flow](../platform-startup.md).
