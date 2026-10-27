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
