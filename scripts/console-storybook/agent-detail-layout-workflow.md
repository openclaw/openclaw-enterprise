# Review the Agent detail layout

Use the desktop Console first, then a 390-pixel phone frame. These stories use
simulated API state; they do not prove persistence or live runtime behavior.

1. Open **Pages / Agent detail / New version activated**. Check the compact
   summary separates Selected for service, Latest visible deployment, and Live
   serving. Choose another **Viewing version**; the service target stays the same.
   Choose **Open draft**. Check the new-version notice has an even, neutral border
   without a blue stripe. Open **Edit Configuration**; the notice stays visible.
   Repeat this check at phone width.
2. Open **Deployment**. Expand **Deployment details**, read the viewed version's
   record, and run diagnostics. Switch to Configuration and back: the record and
   results remain. **Logs** still opens the viewed version's output.
   Check **Pages / Agent detail / Deployment snapshot unavailable**. The viewed
   version's error and **Retry** appear inside Deployment. Retry restores its
   record and diagnostics without changing the viewed version or tab.
3. Open **Pages / Agent detail / Long version history**. Load older pages. The
   viewed version stays selected; the last page returns focus to its picker.
4. Open **Components / Native admin / Available**. **Open Agent UI** opens the
   selected version's interface directly in a new tab. Review the target and
   Gateway managed-mode warning. Check stopped, unsupported, denied, and failed
   status stories: no enabled launch link appears without available access.
5. Open **Components / Workspace / Keep unsaved files**. Choose Instructions and
   User context. Each keeps its edits and Unsaved indicator. Read every file's
   role description. Save one file, then Reload another; each action affects
   that file alone. Return through another Agent tab and check selection survives.
6. Repeat file selection on a phone using **Workspace file**. Check the editor
   fits the screen. Check Missing file, Save needs Agent operate, Write outcome
   unknown, and Reread keeps a focused editor's caret. A deployment poll must
   preserve the selected file, caret, and unsaved content.
   Check **Components / Workspace / Reread after a version change**: a confirmed
   missing file shows **Missing** in the tabs and phone picker. The browser
   regression also checks that a later missing-file response clears a previous
   **Needs attention** indicator.
7. Open **Pages / Agent detail / New version in progress, then current**. Follow
   its reset steps to check **Refresh deployment** with a stationary pointer
   through completion and the delayed overview reread. Repeat with a click during
   that reread: busy feedback is immediate and only one user refresh follows.

8. In **New version queued**, fold **Deployment details**, then Tab to **Run
   diagnostics for this version**. Routine polls keep the fold and the visible
   focused button in place. Repeat expanded, at desktop and phone widths.
   In **New version in progress, one status read fails**, open Deployment before
   the failed poll. The fold stays as chosen through the transient error; the
   selected record shows the error outside it, with one visible alert. Completion
   is a terminal result and can expand the details. In **Deployment activity
   unavailable**, fold the error and press **Refresh deployment**: the repeated
   error is revealed again.
   These stories simulate responses. The real Controller browser regression in
   `tests/browser/console-deployment-activity.test.ts` additionally checks queued →
   503 → queued, queued → running, a final 403/404, and a delayed success delivered
   after refusal. Run it for the actual controls and response envelopes; Storybook
   is not proof of those Controller responses.

9. Open **Rejected credential, binding editor cannot deploy**
   (`credentialRejectedBindingEditor`). Recovery must offer **Open Credentials**
   and ask for Agent deploy, without instructing the actor to deploy. Follow the
   link, check tab focus, and save the authentication source. Agent update,
   Configuration read and source operate permit this binding edit; Secret update
   is separate. Deployment remains unavailable. Repeat at phone width.
10. Open **Rejected credential, hidden Secret updater cannot rebind**
    (`credentialRejectedHiddenSecretUpdater`). Recovery and draft guidance must
    explain Secret update for replacement and source operate for rebinding and
    deployment. Configuration editing and Agent deploy do not supply that grant.
    Recovery must not link to the disabled authentication editor or expose the
    hidden Secret ID or name. Inspect Credentials through its tab and repeat at
    phone width. This is simulated guidance and non-disclosure proof only: the
    fixture's hidden-Secret flag also blocks its PATCH path. It cannot establish
    that an actor with update but no read can replace a known Secret in place.

These two previews require an owner build and walkthrough. Fixture permission
answers are not IAM enforcement; saved feedback is not backend persistence proof.
