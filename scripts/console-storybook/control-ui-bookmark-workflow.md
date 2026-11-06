# Shared direct Control UI bookmark

Scenarios live in `public/scenario-groups/direct-control-ui-access.mts` and are registered through `public/scenarios.mjs`.

Use **Pages / Agent detail / Control UI Bookmark** and the matching Empty,
Readonly, Loading, Error, Edit, Conflict, Uncertain, and Roster Unavailable stories.
These are simulated UI fixtures, not proof of persistence, IAM enforcement, or a
reachable authenticated ingress. Real-controller coverage lives in
[the bookmark browser suite](../../tests/browser/console-control-ui-bookmark.test.mjs).

1. Open Access on desktop. The Direct Control UI access card keeps its native
   roster separate from Share Agent through OCC. The saved URL and **Open direct
   Control UI** link belong to this Agent, not its revision.
2. Select **Edit link**. Change the HTTPS URL, then **Cancel**; the saved link must
   stay unchanged. Reopen, edit, and **Save**. The inline field closes and the
   saved link changes. Do not open the synthetic external destination.
3. Reopen and **Remove**. This clears only the bookmark. **Add direct URL** can
   save a new one. No step configures ingress, authentication, an allowlist, a
   grant, or native Gateway identities.
4. Check Empty, Readonly, Loading, and Error. Readonly shows the link without edit
   controls or the administer-only roster. The bookmark and native roster load
   independently; their failures must not hide OCC sharing.
5. In Conflict, verify that the entered URL is preserved and Save is disabled.
   Select **Refresh bookmark**. The current saved URL changes, but the typed input
   remains. Review and save explicitly; never retry a stale edit automatically.
6. In Uncertain, the fixture simulates a lost success response. A read reconciles
   the current bookmark without replaying the write. Input remains for review.
   Real-controller coverage separately drops only the HTTP response after the
   actual controller commits the save.
7. Check Roster Unavailable. The bookmark remains usable without a successful
   configuration or native adapter read. Do not infer roster or profile access
   from a readable bookmark.
8. At 390px phone width, inspect the saved link, inline editor, conflict text, and
   button wrapping. The bookmark must not cause horizontal overflow.

Record the final source revision, build identity, desktop and phone screenshots,
and a short Save/Edit/Remove walkthrough. Capture only synthetic scenario data.
Compare against the archived approved Access layout, not an invented main
baseline. Keep evidence untracked under the task's workspace-only temporary
folder; the parent owns GitHub uploads and replacing the previous gallery.
