# Review the Agent detail layout

Use the desktop Console first, then a 390-pixel phone frame. These stories use
simulated API state; they do not prove persistence or live runtime behavior.

For retained Harness settings, open **Pages / Agent detail / Retained Harness
history** (`retainedHarnessHistory`). Load older versions, select v1 and read the
saved-settings warning,
then return to v2 and confirm its Configuration remains readable. In **Retained
Harness without overrides** (`retainedHarnessWithoutOverrides`), choose **Open
draft**, then **Harness destination**. Only **Use Installation default** and
**Override model provider** are available: absent settings cannot be retained.
Switch to the override and back without deploying. Capture the warning, readable
current version, and chooser interaction as simulated UI evidence; the PostgreSQL
migration-history regression separately verifies the real read responses.

At desktop and 390-pixel widths, open **Pages / Agent detail / Gateway password
save in progress** (`gatewayPasswordSaving`). Confirm editing and deployment stay
unavailable while the save is pending. Storybook simulates the pending save and
does not stage malformed History state. For real Back during a held save, and
Back and Forward after it completes, use these tests in `tests/browser/console-drafts-kept.test.ts`:

- `Back during a Configuration save preserves the previous Agent tab`
- `Back during a Configuration save survives a synthetic marker that wraps to zero`
- `Back during a Configuration save survives a synthetic marker outside the history stack`
- `Back during a Configuration save leaves an overflowing synthetic marker untracked`

At both widths, open **Pages / Agent detail / Agent unavailable** (`agentMissing`).
Confirm the heading is **Agent details** and the panel says **Resource unavailable**,
without an Agent name. Choose **← Agents** (Back to Agents) and confirm the
collection heading is **Agents**.

At both widths, open **Pages / Agent detail / Retry a direct Agent link**
(`agentReadInterrupted`) directly in its own preview tab, without navigating from
the Agents list. Confirm **Agent details** and **Request unavailable** appear
without an Agent name. Use Tab to reach **Retry** and press Enter. The next read
uses the normal fixture response: confirm the H1 becomes **Research assistant**
and receives keyboard focus. This story simulates one failed GET with status 503.

At desktop and 390-pixel widths, open **Pages / Agent detail / Revision history
rejects with null** (`revisionRejected`, Storybook ID
`pages-agent-detail--revision-rejected`). The fixture rejects only the Agent's
revision-history GET with raw JavaScript `null`, with no HTTP status. The draft
Configuration GET uses its normal fixture response. Confirm **Version history
unavailable.** is visible, with no **No readable versions** message or **Load
older versions** control. Read the draft, open **Edit Configuration**, then
**Cancel**. Confirm **Deploy new version** stays unavailable and says version
history is required before deploying. The separate **Revision history
unavailable** (`revisionError`) preview still simulates HTTP 403. This null
rejection is simulated UI proof, not a normal browser network failure or proof of
backend persistence or deployment.

Open **Pages / Agent detail / Runtime Logs Source Switch After Rate Limit**
(`pages-agent-detail--runtime-logs-source-switch-after-rate-limit`). Wait for
Gateway output, select **Agent (Harness)** under **Source**, then choose **Refresh
logs** once the Agent output appears. Switch back to **Gateway** while the
five-second retry message is visible. **Reading output…** should replace the old
output and retry message. Wait past five seconds, while the Gateway read is still
pending, and confirm the message stays gone. After about ten seconds from the
switch, **gateway listening** appears. Reload to repeat.

**Runtime Logs Refresh Rate Limited** (`RuntimeLogsRefreshRateLimited`)
covers staying on the same source. Both stories use simulated responses. The
controller-backed browser regression in `tests/browser/console-agent-logs.test.ts`
checks the source switch through the Console API.

1. Separately, open **Pages / Agent detail / New version activated**
   (`deploymentSucceeded`, Storybook ID `pages-agent-detail--deployment-succeeded`).
   At both widths, confirm its H1 shows a readable Agent name as an independent
   success case. Check the compact summary separates Selected for service,
   Latest visible deployment, and Live serving. Choose another **Viewing version**;
   the service target stays the same.
   Choose **Open draft**. Check the new-version notice has an even, neutral border
   without a blue stripe. Open **Edit Configuration**; the notice stays visible.
   Repeat this check at phone width. For the narrow layout check, choose
   **Open preview in its own tab**. Set the browser content area to 390 pixels wide
   and use 200% browser zoom (195 CSS pixels of layout width). Tab to **Viewing
   version** and check that its label wraps above the picker. Use Home to view
   **Draft**, then Tab back to the picker and select a numbered version. Both
   choices stay readable without horizontal scrolling, and neither changes the
   version selected for service.
2. Open **Deployment**. Expand **Deployment details**, read the viewed version's
   record, and run diagnostics. Switch to Configuration and back: the record and
   results remain. **Logs** still opens the viewed version's output.
   Check **Pages / Agent detail / Deployment snapshot unavailable**. The viewed
   version's error and **Retry** appear inside Deployment. Retry restores its
   record and diagnostics without changing the viewed version or tab.
   In **Repository Access Redeploy Required**, choose **Refresh
   record**: both Completed outcomes remain and the repository guidance appears.
   View v6 and open Deployment: its record has no notice, while activity still
   identifies v7. Return to v7 and use **Refresh deployment**. No browsing or
   refresh action sends a deployment request. Repeat at phone width. This is
   simulated presentation proof; no notice does not establish healthy Git access.
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
   In **Diagnostics focus when deployment completes**, open the preview in its
   own tab. Fold **Deployment details** and Tab to **Run diagnostics for this
   version**. Scroll up until the focused button sits fully inside the lower
   edge of the viewport. After the delayed poll reports **Completed**, the
   details open and the same button stays visible and focused. Check desktop and
   phone widths. At phone width, reload and repeat. This time, scroll to the top
   after tabbing to the button. The details still open and the reader stays at
   the top.
   In **Refresh deployment focus when a newer version appears**, open the preview
   in its own tab, fold **Deployment details**, and Tab to **Refresh deployment**.
   About five seconds after queued v7 appears, its quiet poll starts and the
   button stays enabled. Press Enter during the next six seconds. The button
   becomes busy immediately and keeps focus as the panel switches to v8.
   When the simulated record read fails, v8 shows a retry notice and the
   button is enabled and still focused. Reset the story to replay. The real
   Controller regression for this replacement is in
   `tests/browser/console-agent-detail-2.test.ts`.
   These stories simulate responses. The real Controller browser regression in
   `tests/browser/console-deployment-activity.test.ts` additionally checks queued →
   503 → queued, queued → running, terminal completion with the diagnostics
   button focused, a final 403/404, and a delayed success delivered after refusal.
   Run it for the actual controls and response envelopes. Storybook simulates
   those Controller responses.

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

Open **Pages / Agent detail / Danger zone on Configuration** on desktop and phone.
Switch from Workspace files to Configuration to see stop status and deletion controls.
Switch back to verify the entire card disappears.

11. Open **Components / Stop Agent / First Deployment Failed**. The Agent has no
    selected version and its latest readable deployment failed. Check that **Stop
    Agent** remains enabled: a newer queued deployment can be unreadable. Open the
    confirmation, then Cancel. Check **Denied** still offers no Stop control.
    These stories do not prove revision filtering or Stop authorization; the mixed-history
    browser regression exercises those through the Controller and Native IAM.
    Confirm Stop: its result replaces the action description, without repeating it.
    In **First deployment queued**, confirm Stop and check **Deployment cancellation
    requested**, not a claim that cleanup finished. The lifecycle browser regression
    covers another actor deploying and stopping later; that read must remove the old result.
