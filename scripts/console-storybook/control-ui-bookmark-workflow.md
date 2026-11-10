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

## Snapshot-protected Harness controls

Use **Pages / Agent detail / Harness Reauthorization Pending** and **Harness
Reauthorization Refused** alongside the unchanged Harness Overrides, Deployment
Pending, and Deployment Denied stories. These two return stories simulate only an
HTTP delay/refusal; they are not backend permission or runtime proof.

1. Start on Configuration. Open **Harness destination**, choose **Override model
   provider**, and enter `https://evaluation.example.com/v1`. Do not deploy.
2. Open **Access**. Focus another window and return to the preview to run its
   normal refocus check. Open **Configuration** again.
3. During the four-second snapshot read, neither the draft checklist/Deploy card
   nor Harness destination is visible. In Pending, the allowed answer restores
   the original controls with their unsaved selection and URL.
4. Reset Refused and repeat. Its 403 shows **Configuration unavailable** and retires
   both shared cards. Access remains independent; no Configuration GET is made
   while that metadata view is selected.

For permission claims use the existing real-controller/Native IAM retained browser
workflow, not these simulated responses. Capture comparable pending and refused
before/after views at 1440×1000 and one 15–30 second interaction using
`recordWalkthrough`. Keep actual baseline/current source hashes, synthetic-data
labels and recording seek times with the untracked evidence. Preserve the original
Nov6 capture labels; those older images are not a before state for this Harness gap.
