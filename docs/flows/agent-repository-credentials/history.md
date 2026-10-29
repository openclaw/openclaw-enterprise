---
published: false
---

# Agent repository credential documentation history

This record preserves the dated changes to the Agent repository credential flow. See the [parent flow](../agent-repository-credentials.md) for its context and overall sequence.

## Changelog

- 2026-10-17 06:00: Keep joiners in words and emoji and the three subdivision flags in repository descriptions. (lows-1017h - 49397a014)

- 2026-10-17 05:00: Replace invisible and bidi characters in repository descriptions; escape them in the picker. (lows-1017g - 3a02bef00)

- 2026-10-17 00:15: Preserve Unicode repository descriptions across truncation and discovery. (authoring-run/f538c999-f9bf-4549-ba36-19dca6101420 - 42fb0a90337209e28318765c1b537bc4f3623506)

- 2026-10-16 21:13: Restrict prepared Git draft body input to explicit text; bind prepared Git session origins to the Helm-owned broker Service before ingress admission. (authoring-run/97826393-386f-4988-ace7-afc669f1922f - dac53babe; authoring-run/c21f74f4-95aa-4ba6-878d-84586bd6ecb7 - d2200df9a)

- 2026-10-12 07:39: Recovery fences a reserved receipt whose fence did not commit. (authoring-run/aee1dd2c-5ac0-4499-aaf6-a4c36928423e - b195e54e9b0ce98ead2b2306015a5209325e837b)

- 2026-10-03 16:30: Log a stuck repository cleanup's cause once and slow its rechecks with age. (fix-repo-cleanup-backoff)

- 2026-10-01 17:20: Point the safe version response projection at its Agent HTTP owner. (authoring-run/bef09bf6-deaa-4189-9568-5f13beb451e7 - 7a6cc931d)

- 2026-09-30 05:21: Deliver broker CA settings to both repository consumers. (01a0ed9e-6c22-7671-9ee1-a58e1df39acd - ab0a1838)

- 2026-09-30 03:57: Recheck material deadlines. (authoring-run/00e5c01e-b8c9-46df-a8ac-45aa0e6932da - 5334a55faf3ced4bf9e0971daad6fd34ad2fe982)

- 2026-09-29 20:00: Trace repository descriptions, inheritance and overrides. (public-pr/374)

- 2026-09-28 21:24: Stabilize retained projection ordering. (public authoring-run/75044c27-6c5b-4cff-a6cf-9e31fd688ac2 - 8352c0932bcbde43e88b44c6975496ca5431ff55)

- 2026-09-28 17:25: Decouple Agent deletion from repository-session cleanup in the accompanying worker and finalizer changes. (authoring-run/df373b87-44bc-442f-bce4-03ca8ab4e3f7 - 33a2528163d5bbff311bb685345e60aadb24a70a)

- 2026-09-28 12:09: Check broker capability before fresh admission and worker readiness. (01a0e6ca-0480-79a1-ab5d-31a7cfb42228 - 5b66ac97aa3b805099aeebfaadeb846eb957707d)

- 2026-09-28 08:12: Trace durable broker terminal receipts and admission fencing. (authoring-run/41ba3c72-c44a-4a26-8285-7d4724f24352 - e06ff9625e72ff5ab3483a504a2f02a69a370cbb)

- 2026-09-28 07:05: Trace coalesced revision cleanup registration and preserved claim ownership. (authoring-run/80088bb7-240e-42d0-bae9-9420d6eac9f9 - e06ff9625e72ff5ab3483a504a2f02a69a370cbb)

- 2026-09-26 09:07: Replace the custom private-endpoint capability with stock Codex network settings and retain independent authorization boundaries. (authoring-run/c29b3860-d1f0-4a14-a264-49090586cb20 - 20123a3aa96021391616e918deee0ce60b009fa3)
  Removed the custom Codex private-endpoint requirement. (NOT_IN_SPEC)

- 2026-09-23 08:33: Condense the combined flow without changing its contracts. (public-pr/295 - acd86266)

- 2026-09-23 08:16: Trace accompanying initialization-safe hook delegation and equivalent native HTTPS destination matching. (authoring-run/fca0cd1e-2248-4139-aae8-d12423b5667e - 45c4cf5584b631c9ae5018c56a579d4bafa79ca5)

- 2026-09-23 06:44: Reconcile published successor readiness with access-level UI. (public-pr/295 - 9613bb6082e703eb13258c3e976326895297ca4b)

- 2026-09-23 06:29: Compose Console recovery and Dedicated material readiness with access-level permissions and the optional native push guardrail. (public-pr/295 - c0b9ce5b4ef36de65c3119fe2bc97cb29c30c184)

- 2026-09-23 06:18: Trace the accompanying access-level permissions and grant fingerprint changes. (authoring-run/0dffba8f-d16f-4f90-8fe2-893368f6926a - a2e94cf8ac2d94306f0701cee5457d1a9797e50a)

- 2026-09-23 06:11: Trace accompanying successor-readiness correction while the prior gateway serves. (public-pr/295 - fd5c5814e87585533a1f56127cf7eee9589b69ac)

- 2026-09-23 04:47: Document accompanying late material readiness checks, preserved workspace node, dedicated ingress and required installed-client volume coverage. (public-pr/295 - da14a882312fc7d88a047353bde2c76f19b2e2ee)

- 2026-09-23 04:15: Trace the accompanying optional push-ref guardrail and ordinary hook delegation. (48c7cd3a-4677-44e0-b710-c39ada9d4f48 - cbf1851308a2db398820ae9e1000f57837703ace)

- 2026-09-22 18:19: Trace Dedicated support, two-step private initialization, authorization-safe discovery and persistent retry intent. (public-pr/295 - 2607afb5829937a0b3110d0f9409fea373def428)

- 2026-09-22 10:13: Trace safe repository choices, focused selection, pre-write conflicts, ordinary retry and fail-closed repository recovery. (public-pr/295 - 4c2e9e37f18d01878a47083505fab656172008a1)

- 2026-09-21 17:15: Distinguish pending disposal from irrecoverable session loss in the accompanying worker correction. (authoring-run/7ba8b1a5-628b-45f2-9ec9-25ce904b82d9 - 47995c58a5f9d267040e510110ca28ffa3d3a226)

- 2026-09-21 15:48: Trace refusal of unsafe same-revision replacement and canonical retention registration in the accompanying changes. (authoring-run/f4034e1f-9090-4f83-87c7-189e172017e2 - 08a9b693de5fe959d26e698435017e0114e3e46e)

- 2026-09-21 07:32: Trace retained cleanup evidence and pending Agent deletion in the accompanying State and worker changes. (authoring-run/5657fc4b-0f7a-423e-9c54-1cf174f5d6c2 - d2b31887be1d114c9147e2ed6f07c1f38e765c6f)

- 2026-09-21 05:32: Reconcile accompanying platform credential documentation with current source history and native Git boundaries. (authoring-run/fba2d7fa-6603-465e-a7c8-df0375ad202d - a051a2406eec7cafde2e0dd5e2ec63dba6ce1581)

- 2026-09-19 23:54: Reconcile RepoDriver ownership, private status projection, and separate emitted service/client paths. (public authoring-run/73c80a5e-4d0c-4e72-b989-0cf9963c6593 - e5b5a5489f078d08272523476bdbcd0b9162c946)

- 2026-09-18 04:55: Trace the accompanying native exec PATH projection for repository material, including per-agent overrides. (e3012a8cee0c5ea60bc02943ebed88a1c88eb0d2)
- 2026-09-18 03:04: Trace the accompanying Agent admission, durable session lifecycle, Kubernetes material generation and concurrent client integration. (8500b2da103063b4503b62e5529f3910513e84a9)
