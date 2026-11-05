---
published: false
---

# Agent runtime logs documentation history

This record preserves the earlier dated changes to the Agent runtime logs flow. See the [parent flow](../agent-runtime-logs.md) for its context and overall sequence.

## Changelog

- 2026-10-09 23:09: Continue current-container log reads through initial Pod preparation without concealing unrelated failures. (authoring-run/9f37d8ec-6a5b-4676-a134-8a6fb5c54f3a - 21f34928437fb7d6f4391ba4af5d3e15bf9ce480)
- 2026-10-10 02:50: Preserve Event pagination and current termination when merging main; retain both regression groups and histories. (authoring-run/794085ff-b0bd-422e-8fe7-6b6e9846ca0f - 880b645f5e5fb5c99c6046c1eac6ca81211be584)

- 2026-10-10 00:33: Read Pod Event continuation pages before returning the newest 100 diagnostics. (authoring-run-9eade0ab-4aa4-4b21-9faa-e7478c6a8983 - 3e34cc0f4b469d29fc79d2c10a33f87a0921ee47)

- 2026-10-10 02:35: Preserve current termination projection and both flow histories when merging main timestamp parsing changes. (authoring-run/f9b46af2-6bd4-4636-b675-dd9bea82a566 - db4ccbdea96a752cd99a66cf4cf02c195f5fe3ba)

- 2026-10-10 00:51: Report the latest exit details for currently terminated containers while retaining prior exits for running and waiting instances. (authoring-run/3d28a5c1-f0ee-4fbd-97de-52993c05b57d - 4f29773d098d2288a805d0ad80e0c65474e162d9)
- 2026-10-10 00:04: Normalize supported kubelet timestamp offsets without losing nanoseconds, so classification and cursor overlap use the raw message and UTC time. (authoring-run/e25eab96-1110-45ec-b677-916a98b34613 - ba3686748ddf56052dc2717cc2ce6eaa3710c1f0)

- 2026-10-09 15:42: Count container lines delivered at the cursor time, so a timestamp group larger than the 16-hash history neither replays nor hides later lines; a full history without that evidence stays suppressed. (fix-949-950)

- 2026-10-09 22:24: Authenticate frontier completeness and retain conservative suppression for cut or legacy timestamp groups. (authoring-run/ce414344-4cec-4d51-accd-f66b2ece9e0f - f060fefd260b552e44d5549f549436d6147a474c)

- 2026-10-09 22:12: Preserve matching-text suppression when the 16-hash frontier may have forgotten earlier occurrences. (authoring-run/ce414344-4cec-4d51-accd-f66b2ece9e0f - 66845c95cde0c7ef6adf358eb7daa1474c5fd443)

- 2026-10-09 21:59: Count delivered occurrences when de-duplicating container lines at the cursor time. (authoring-run/ce414344-4cec-4d51-accd-f66b2ece9e0f - dc95c2261d4b46cff8aca703e13e43cdd71d153e)

- 2026-10-07 05:26: Point CLI runtime reads and log polling to their dedicated source owner; clarify the existing version selection. (authoring-run/9ac89b09-043f-44ba-8069-d0a90859ed7b - 61590165cdbb)

- 2026-10-05 11:38: Document clean CLI follow cancellation during initial version lookup with the accompanying fix. (authoring-run/2afba01b-8db4-41d7-a942-e14bd7f44262 - 0698d533b97dc3abe7bef7ff7907a0f4335c3182)
- 2026-10-05 10:51: Preserve shared tenant placement while incorporating main startup and runtime diagnostics. (01a0fe72-58b2-7cc3-b770-7310f5401deb - 71a1cedb)

- 2026-10-04 07:00: Authorize before the rate and concurrency limits so every denial is audited. (bh11-runtime-log-authz)

- 2026-10-03 22:00: A resumed view moves past a line longer than the 1 MiB read limit instead of re-reading it on every poll. (f349-log-resume)

- 2026-10-03 03:00: A cursor from a page that delivered no line resumes from that page, not the whole tail. (bughunt-1/fix-runtime-logs-quiet-follow)

- 2026-10-02: Describe shared single-cluster runtime placement. (01a0fe72-58b2-7cc3-b770-7310f5401deb)

- 2026-10-01 14:00: Add the server-side `minLevel` floor and the console's **Include debug** control. (fix-d79 - 3d6ce1fdb)

- 2026-09-30 23:44: Clarify the prior cursor frontier and ordered same-page PEM boundaries without changing masking behavior. (authoring-run/2c8a089c-ec67-402d-8cfd-ec8b29c5e3fe - a4cddf26bc462744bfff912b1e1cdb9f1ee60cd2)

- 2026-09-30 20:37: Receive cursor-context masking with current runtime-log guidance and preserve the current view behavior. (authoring-run/e2da7c2d-8080-4dd4-9ce9-d494b890234c - fb22aa07c1613218280cff25d6b62bfb4cff6b5d)

- 2026-09-30 19:43: Carry authenticated PEM context across container polls with read limits without closing on ambiguous overlap. (authoring-run/b5fcaf0e-328a-4fe2-b53f-e72268ef70af - affac2bfc1370e590e6da570bcaaad4a207c9f09)

- 2026-09-30 08:30: Document runtime status and container log reads for Kubernetes Compute. (build-1/agent-logs-slice-1 - 0918be781)
- 2026-09-30 11:40: Add downloads, console filters and the `occ agent runtime|logs` callers. (build-2/agent-logs-slice-2)
- 2026-09-30 13:00: Add the OpenShell sandbox source. (build-logs-3/agent-logs-slice-3)
- 2026-09-30 15:30: Overlapping sandbox resume with counted de-duplication; NOT_FOUND is a 503. (fix-3/agent-logs-slice-3)
- 2026-09-30 18:10: Console remembers a runtime status denial per page and points unready-Harness Gateway views to the Harness source. (dogfood3-fix-7)
- 2026-09-30 18:30: Without a selected version the CLI reads the latest version; a failed deployment links to its version's Logs tab. (fix/dogfood3-5)
- 2026-09-30 20:00: Key remembered denials by operator; the Harness hint ignores a rollout's old Pod and covers a missing Pod. (dogfood3-refix-7)
