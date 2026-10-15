---
published: false
---

# Bootstrap and human authentication documentation history

This record preserves the dated changes to the bootstrap and human authentication flow. See the [parent flow](../local-password-authentication.md) for its context and overall sequence.

## Changelog

- 2026-09-30 20:57: Receive landed PR751 while preserving bounded device proofs and both documentation histories. (authoring-run/b38fdf7a-4e45-40ac-a7d7-7da3aa8e0070 - 0e59bf4479aabfa0d00c6940c55be760fa19a200)

- 2026-09-30 20:28: Receive bounded device proofs and clarify audit-failure accounting and cookie delivery. (authoring-run/b84d8248-fb41-44b3-8ed5-30d7fd777926 - 2702a01c6c2136cf9fb5b6808d3972379158f2ff)

- 2026-09-30 20:12: Qualify audit-failure session cleanup and tracked-budget accounting. (authoring-run/d58e793e-df0f-40de-8f08-5d0ee989927a - d7b2e4c0697ace45cf2d4b3ab630ce3976334a16)

- 2026-09-30 17:01: Bound fresh device proofs without reopening spent allowances. (authoring-run/bc25e670-bfac-4568-9e6d-d0104391ed45 - 6b43652ca0792ca1a4be0f8bc628f62c1f72fe17)

- 2026-09-30 12:00: Trace the password-only refusal of account and recovery routes. (fix/dogfood-2)

- 2026-09-30 01:03: Receive the PostgreSQL binding and independent schema views. (authoring-run/f1ccd2eb-7d83-40d8-9fe1-c79672f9f98f - f2c9f98b0b89762cc9edda189c102ed8c593c678)

- 2026-09-28 04:00: Trace the GitHub attempt receipt, result exchange, and `x-occ-session-key` narrowing in the accompanying source change. (feat/github-session-binding-20260928)

- 2026-09-26 21:09: Trace origin checks for cookie-authenticated mutations and sign-out. (authoring-run/6d7cf57f-03f3-4ea7-8694-38edd9f3c9c2 - 849b2b24111fe237b12da5be1d4b411d3146cefb)

- 2026-09-25 17:27: Trace noncredential session identity for Console lifetime invalidation in accompanying changes. (01a0d992-db83-7843-b40c-355c0f2c2b9a - 64ab72aed5c4926e4a2080ade91d785e531801a2)

- 2026-09-23 18:50: Trace shared GitHub App login without OAuth scopes and discarded App credential data in the accompanying source change. (public-pr/305 - e9a16a23f1c3a5bc9a26e1ca13022b769bae5e7a)

- 2026-09-23 04:25: Trace the nested GitHub provider start and callback routes in the accompanying route change. (public-pr/305 - 16756fbf1197601f0cc7eef2143389952fd1959e)

- 2026-09-23 04:05: Trace host-bound HTTPS sessions, ambiguous-cookie rejection, and preserved callback completion uncertainty in the accompanying security repair. (public-pr/305 - 140f82a08e82c852e0c7ca5071f45a64f6dce596)

- 2026-09-23 01:46: Trace static authentication validation before activation and unchanged state on invalid configuration in the accompanying source repair. (public-pr/305 - ed1a4a2f719ad6bd28239f61f1213cce4c2d94fb)

- 2026-09-23 00:36: Trace stopped activation, guarded actor/version administration, finite work, and the temporary provisioning freeze in the accompanying source change. (public-pr/305 - bc3a8652bd60423a5c5749429628f55ab8329513)

- 2026-09-22 23:02: Trace existing-account GitHub login and shared guarded session admission in the accompanying source change. (public-pr/305 - 311bc23012d0fd269483168b865adf79df630542)

- 2026-09-01 19:09: Update links to consolidated runtime flows. (01a05f95-dd80-7011-990f-d1c46b5bb3cc - aa366c49c44834d59f74994c5fd37fb8096f169f)
- 2026-08-31 22:29: Remove automatic bootstrap recovery; preserve artifacts after any error and require manual repair. (01a05a3d-526f-7553-8cd8-070bd1847acb - 94a5440898bf331987148d7733f0075506af64a6)

- 2026-08-31 20:33: Trace the shared installation initializer, startup ordering, and initializer-owned credential delivery. (01a05a3d-526f-7553-8cd8-070bd1847acb - b6f213cbcee11ba3dd69886c936c7e5abe233eb3)

- 2026-08-31 17:43: Document fresh human/service administrator bootstrap, private key delivery, and operator recovery. (codex/01a05a69-3fbe-7441-9e6d-20394758cf94 - 0797098646028ac00cb26cd4afcbc9b2cf8bcb24)

- 2026-08-28 21:20: Preserved PostgreSQL account provisioning and rollback verification in the renamed auth-account suite after removing local-test Compute coverage. (01a036f4-cf1d-7cc1-bbc1-000879038ac8 - 3ec166eb5fae39ed0f51ffb5ebd93338c4a2db94)
- 2026-08-28 17:58: Updated moved feature-reference links for the documentation organization. (01a036f4-cf1d-7cc1-bbc1-000879038ac8 - 4270aa29b7015562049f46c6027962fd85b584a9)
- 2026-08-24 17:12: Documented current-policy identity lookup, authorization, and cross-controller account visibility. (01a0352c-debe-73b1-baa6-379855af874f - 4502d7e)
- 2026-08-24 17:12: Removed IAM policy snapshots and Driver replacement; load current policy for every identity lookup and authorization decision. (01a0352c-debe-73b1-baa6-379855af874f - 4502d7e) (NOT_IN_SPEC)
- 2026-08-24 15:14: Documented redacted session inspection and account provisioning without implicit sessions. (01a0352c-debe-73b1-baa6-379855af874f - 08862be)
- 2026-08-24 14:10: Simplified the runtime trace and retained real PostgreSQL bootstrap and account-provisioning verification. (01a0352c-debe-73b1-baa6-379855af874f - 99111a5)
- 2026-08-24 13:17: Documented the cookie-only sign-in response and shared auth-account seed validation boundary. (01a0352c-debe-73b1-baa6-379855af874f - 4725aed)
- 2026-08-24 13:01: Documented Better Auth bootstrap, session admission, IAM authorization, account provisioning, and verification flow. (01a03552-00ba-7c42-b5ca-414c8972f20b - 2e9769c)
