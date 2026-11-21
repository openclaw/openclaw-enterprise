---
published: false
---

# Repository credential service documentation history

This record preserves the dated changes to the repository credential service flow. See the [parent flow](../repository-credentials.md) for its context and overall sequence.

## Changelog

- 2026-10-27 13:13: Preserve the selected exchange credential through rotation and authorize the first write. (authoring-run/1d86daf8-5e6c-47f3-b6b2-624ef2b23f37 - 852146b8faea0fd083abd2255190eed5c0e5f43d)

- 2026-10-27 13:11: Keep uncertain admission and disposal observation on the original owner. (authoring-run/eee8818e-6453-492f-acc7-5e5a3f1fe630 - bb7fa74e2d95bdd21648b36ad5c65558b0baffa9)

- 2026-10-27 11:09: Separate prepared startup from development authority and defer listener admission until socket setup completes. (authoring-run/51557b14-ec25-4b33-98f2-b5a16d00d6ea - 0418ef3a2c116b73f025281395d92477daf665d2)

- 2026-10-23 16:25: Require patched gh 2.103.2 in image and client version checks; pin its published checksum manifest. (authoring-run/9b2870c6-312f-48b7-a654-186ae5ec4668 - 5370e972f8b1d51222d79b64c375e8e13a2bd452)

- 2026-10-15 20:51: Separate token custody from ambiguous response evidence. (authoring-run/3af8b480-048d-4e5e-a05c-f5a92f357ccd - 53c4297eb1e0894042a1698609c3e672aef2c97b)

- 2026-10-15 04:44: Bound upload-pack streaming separately while retaining exchange and credential fencing. (authoring-run/35418147-f92b-4808-96cf-a6db4d91f2bb - 00bbc7cd976ab7be317ce1e0a9d36ad72ce10567)

- 2026-10-14 12:23: Document prompt rejection of oversized private-socket replies. (authoring-run/a404e7a3-9acf-4b50-9307-31e50b1b3582 - 4727e9b109a2127150e03e39e859d45e0668f82f)

- 2026-10-15 04:05: Project closed metadata reads; reject actual trailers before release. (authoring-run/ec233aef-e8c7-46e0-b7ca-d1e180dd99aa - 0647e70303cd583ed64286f0ae11c1fa1896ac6a)

- Earlier entries (3) are in the parent page's Git history.

- 2026-10-13 07:40: Past its window, a sweep fences a refused admission's reservation again and forgets it once the fence commits. (fix-1196-1197)

- 2026-10-12 07:39: A refused admission keeps a reservation whose fence did not commit, and the next open or recovery fences it. (authoring-run/aee1dd2c-5ac0-4499-aaf6-a4c36928423e - b195e54e9b0ce98ead2b2306015a5209325e837b)

- 2026-10-06 19:36: Preserve native child signal exit statuses in the shared client executor. (authoring-run/6fa93358-8fd9-4675-9684-511f79da8969 - 86bf3dd99470b86d4c46568f48455f695daabde5)

- 2026-10-03: Refuse GraphQL bodies that select the provider clone credential before dispatch.

- 2026-09-21 07:24: Condense the baseline service trace while retaining credential custody, failure and qualification boundaries. (authoring-run/7fb656ee-ae7a-45a8-a160-6d73bc5ae25b - d2b31887be1d114c9147e2ed6f07c1f38e765c6f)

- 2026-09-21 05:32: Reconcile accompanying platform credential documentation with current source history and native Git boundaries. (authoring-run/fba2d7fa-6603-465e-a7c8-df0375ad202d - a051a2406eec7cafde2e0dd5e2ec63dba6ce1581)

- 2026-09-21 03:34: Reconcile core normalization and response filtering with native client transport. (public authoring-run/7c8439bf-8351-451a-8e82-a947e909fc31 - aa6c43383764e0632f7f9a9aa4245473075e9ff6)

- 2026-09-21 03:28: Document admitted Git path normalization and unchanged authorization checks. (public authoring-run/3a7b57ee-abdc-48f9-87c7-4527c7f42e8a - daf5e85cd6a4c967b91302fa68ad2e156b20e5a7)

- 2026-09-20 21:55: Document accompanying GitHub response credential filtering at supported repository locations. (public authoring-run/85bfba42-19b5-4084-86ec-49dac9e45fba - 46627a2c38cb942fffcbc61ed5229c85fe01bef3)

- 2026-09-19 21:29: Update common/backend ownership and source paths; distinguish finite shutdown from completed disposal. Verify composed source. (public authoring-run/a55f804b-53b3-40df-a5d5-b6a2f425544b - 5d8329753f4e17402f619d392acc8fc3d112f620)

- 2026-09-18 02:02: Document accompanying capture deadlines and failed-construction cleanup. (source `cce878092910f39770aa27baa64c6d710f9651f8`)

- 2026-09-17 21:49: Document callable common lifecycle ownership. (source `2f8435756d0e82f0cc5205b009f5f1e0df692808`)

- 2026-09-21 03:16: Document accompanying native Git preparation, manifest helper selection and gh-only routing. (authoring-run/2c944a97-e78b-44f1-86cf-ddfec705e0a6 - a0e96101ba7a7e111816103b0f6336f3b9dbeee8)

- 2026-09-19 23:54: Reconcile RepoDriver ownership, private status projection, and separate emitted service/client paths. (public authoring-run/73c80a5e-4d0c-4e72-b989-0cf9963c6593 - e5b5a5489f078d08272523476bdbcd0b9162c946)

- 2026-09-19 21:58: Align emitted Docker contexts and container qualification with the separate service and client artifacts. (public authoring-run/8a16053e-895f-4ea3-8114-5bbe459856a0 - 99d01c1759ef28fe1ec2e6e22496879e752b5cb5)

- 2026-09-19 21:46: Reconcile transport and client ownership with accompanying detached service/client build and runtime checks. (public authoring-run/9feb5f57-7456-4831-8474-1fc7871d17c6 - bd3af4a7214c3e7b2142ef38183137786226cde9)

- 2026-09-18 18:51: Refresh operation, authentication and protected-input owners after behavior-preserving extraction. (source `d29fac7d363eb1cfb3dab6306a81cc3b8daf395d`)

- 2026-09-18 12:03: Keep admitted TLS exchanges outside the header timeout while bounding incomplete handshakes and headers. (source `b0b0b8b7ba98d2c8506ba261334aba1e769a87ef`)

- 2026-09-18 03:38: Capture upstream origin authority and construct canonical bounded private request headers before dispatch. (source `7c26fe8660e0af5d223baa2da83689974df36ebe`)

- 2026-09-18 03:33: Start upstream final-response-header deadlines after completed upload and preserve early-response handling. (source `7f2fd5988dfce4a485db48d33f0480b3f9485b86`)

- 2026-09-18 03:29: Preserve private control admission under public socket saturation. (source `0d34c2159d6a8fbec213cacf6ba42ca66aa9170a`)

- 2026-09-18 03:28: Document accompanying protected-path package startup and runtime session-control facade. (source `0d34c2159d6a8fbec213cacf6ba42ca66aa9170a`)

- 2026-09-18 01:59: Document accompanying admission reconciliation, failed-construction drainage and separate use/cleanup deadlines. (87e5c418d7a6c45688ce3be87c204660b431c703)

- 2026-09-17 23:47: Refresh configuration, route classification, driver composition and provider request source pointers from the accompanying adapter extraction. (source `251bf5662df1fd61e132ca57a36008409add1996`)

- 2026-09-17 23:40: Refresh contract and response-policy source owners after extraction; preserve the existing lifecycle. (source `3f0ce26cf864a8909c52104c1c6b6092ca21c857`)

- 2026-09-17 22:22: Document accompanying git-read, default git-write and git-full profile changes and provider-owned route authorization. (c4ecf32727aef09a6b4caeec16870bf391f7a505)

- 2026-09-17 22:10: Refuse new waiters after acquisition cancellation while retaining original settlement and cleanup ownership. (source `2f8435756d0e82f0cc5205b009f5f1e0df692808`)

- 2026-09-17 21:39: Reject late clone configuration and helper-qualified URLs; preserve child outcomes when temporary-home cleanup fails. (source `2f8435756d0e82f0cc5205b009f5f1e0df692808`)

- 2026-09-17 21:19: Reject Git URL userinfo before remote and direct network operations. (source `2f8435756d0e82f0cc5205b009f5f1e0df692808`)

- 2026-09-17 20:59: Reject inherited user-agent header injection before client launch. (source `2f8435756d0e82f0cc5205b009f5f1e0df692808`)

- 2026-09-17 20:40: Enforce repository HTTP settings and selected-session mounts; clarify response completion, URL preservation and cleanup capacity wakeups. (source `2f8435756d0e82f0cc5205b009f5f1e0df692808`)

- 2026-09-17 20:17: Correct source ownership after adapter and transport refactors. (source `2f8435756d0e82f0cc5205b009f5f1e0df692808`)

- 2026-09-17 20:12: Clarify client composition and exchange ownership source pointers. (source `2f8435756d0e82f0cc5205b009f5f1e0df692808`)

- 2026-09-17 19:55: Document accompanying standalone service and client implementation. (source `2f8435756d0e82f0cc5205b009f5f1e0df692808`)
