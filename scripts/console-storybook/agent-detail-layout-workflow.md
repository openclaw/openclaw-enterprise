# Review the Agent detail layout

Start on desktop, then test at 390 px. These stories simulate API responses and
cannot verify persistence or live runtime behavior.

Open **Pages / Agent detail / First version** at desktop width. Focus the selected tab,
then press End and Left to focus the tab before last. Narrow the window to
920 px, then 390 px. Confirm the label and focus ring stay clear of both faded
edges and the selected panel stays open.

Open **Pages / Agent detail / Plugin selections, viewer cannot update the Agent**
and **Plugins in admitted version**. Select **Plugins** in each story. At
390 px and 920 px, check that the entire long plugin ID and the indented JSON fit
inside the card without horizontal scrolling. Focus **Plugins** and press Tab to
reach the JSON. At desktop width, check that the long ID fits on one line.

At 1280 × 1000, open **Pages / Agent detail / Edit Configuration** and make a valid
edit. Scroll until **Save Configuration** is near the middle of the window and
**Danger zone** is out of view below it. Save and check that **Edit Configuration**
has focus in view and **Danger zone** stays below the window. The signed-in test
in `tests/browser/console-agent-saves.test.ts` delays a real Configuration save.

Reopen **Edit Configuration**. In **Configuration JSON**, select a few characters
with Shift+Left. Switch browser tabs and return. After the access check, press
Shift+Left again. The selection should extend one more character to the left.

At desktop and 390-pixel widths, open **Pages / Agent detail / Channels access
could not be checked on tab return** in its own preview tab. Open **Edit Slack**
with the keyboard, then choose **Cancel** and confirm focus returns to **Edit
Slack**. Switch to another browser tab and return. The fixture returns one
HTTP 503 for the Agent permission check. Confirm **Channels** stays selected
and receives focus. Read the access-check message on the Channels panel and
check that the Slack card and **Deploy new version** describe why their actions
are unavailable. Choose **Refresh** in the page header and check that **Edit
Slack** is available again and the access-check message clears. Reload the
preview to repeat.

After Cancel, scroll to the bottom with **Channels** in view. Switch browser
tabs and return twice to see the failed check and recovery. Each time, the
Channels tab should stay in the same place on screen unless the page is too
short to allow it.

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

At desktop and 390 px, open **Pages / Agent detail / Revision history rejects
with null** (`revisionRejected`, `pages-agent-detail--revision-rejected`).
Only the history GET rejects with JavaScript `null`, without an HTTP status.
Confirm **Version history unavailable.** appears without **No readable versions**
or **Load older versions**. Read the draft Configuration, choose **Edit
Configuration**, then **Cancel**. **Deploy new version** stays disabled and
requires history. **Revision history unavailable** (`revisionError`) simulates HTTP 403.

Open **Older version page rejects with null** (`olderVersionPageRejected`,
`pages-agent-detail--older-version-page-rejected`). Choose **Load older versions**.
Confirm a warning appears. Retry to load v1 while v2 stays selected.
These simulations leave network failures, persistence and deployment unverified.

At desktop and 390 px, open **Pages / Agent detail / Revision history
recovers on return** (`revisionHistoryRecovery`) in its own tab. With the draft
clean and **Deployment** selected, confirm **Version history is unavailable.**
before switching browser tabs. Return; the warning disappears, the same view and
tab remain, history is empty, and **Deploy new version** stays disabled with its
reload instruction. Confirm no Deploy POST. Use Console **Refresh** and record
its result separately; browser reload resets the simulation.

In a separate pass, open **Configuration** and change **Configuration JSON** in
**Edit Configuration**. Leave the change unsaved. Switch browser tabs and return.
Confirm **Configuration** stays selected, the edit remains, and **Deploy new version**
stays disabled with **Save or cancel Configuration edits before deploying.**
Confirm no Deploy POST. Check Console **Refresh** separately. The
[Controller browser test](../../tests/browser/console-agent-detail.test.ts)
uses a clean draft and browser reload. It covers neither Console Refresh nor dirty edits.

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

Open **Pages / Agent detail / Deployment regains Secret operate on refocus**
in its own tab. Select **Deploy new version**. The unavailable button’s
accessible description should name the Secret. Switch tabs and return. The
simulated grant clears the refusal and enables Deploy on the same draft without
sending a Deploy request. Use **Deployment needs Secret operate** to check
access that stays denied.

Return to the same version in **Current version's Sandbox lost**. Check the warning.

In **Bootstrap failure with cleanup pending**, scroll down (sideways on phones).
Point at **Deployment**. When v7 fails, click without moving. The tab stays put.
Check v7’s failed record, pending cleanup and unchanged v6 selection. One check
changes **Sandbox running** to **Sandbox lost**, offering **Deploy a new version**.
Cleanup triggers no further checks.

Reopen and focus **View deployment**. After cleanup, Enter opens v7.

In signed-in tests, scroll down v1’s **Configuration**. Point near the top
of **Deployment**. After the simulated worker finishes, check **Selected for
service** shows v2. Click without moving. **Deployment** opens for v1. Repeat
over **Draft credentials** to open the draft’s **Credentials** tab.

1. Open **Pages / Agent detail / New version activated**
   (`deploymentSucceeded`, `pages-agent-detail--deployment-succeeded`).
   Check the H1’s Agent name is legible at both widths. The summary
   distinguishes Selected for service, Latest visible deployment and
   Live serving. Changing **Viewing version** leaves the service target unchanged.
   At both widths, choose **Open draft**. The new-version notice has an even,
   neutral border without a blue stripe. It stays visible after **Edit Configuration**.
   Choose **Open preview in its own tab**. At 390 px wide, zoom to 200%
   (195 CSS px). Tab to **Viewing version**. Its label should wrap above the
   picker. Use Home to view **Draft**, then Tab back and
   select a numbered version. Check both remain readable without horizontal
   scrolling and leave the service target unchanged.
2. In **Deployment**, expand **Deployment details**, read the viewed version's
   record and run diagnostics. Configuration and back preserves record and results;
   **Logs** opens that version's output. **Pages / Agent detail / Deployment
   snapshot unavailable** shows error and **Retry** inside Deployment; Retry
   restores record and diagnostics without changing version or tab. In **Repository
   Access Redeploy Required**, **Refresh record** preserves both Completed outcomes
   and shows repository guidance. v6's record has no notice; activity identifies
   v7. Return to v7 and **Refresh deployment**. Browsing and refreshing send no
   deployment request. Repeat on phone. Simulated presentation; no notice does
   not prove healthy Git access.

3. Open **Pages / Agent detail / Long version history**. Load older pages. The
   viewed version stays selected; the last page returns focus to its picker.
4. Open **Components / Native admin / Available**. **Open Agent UI** launches
   the selected version's interface directly in a new tab; review its target and
   Gateway managed-mode warning. Stopped, unsupported, denied, and failed stories
   have no enabled launch link without available access. **Browser chat off**
   says chat is off and offers **Open draft** and **Browser chat settings**; **Browser chat off,
   read-only caller** asks for someone who can edit Configuration and has no
   settings link.
5. In **Components / Workspace / Workspace Navigation** (Keep unsaved files),
   clear User context. Switch files; check role descriptions, Unsaved indicators
   and selection across Agent tabs. Select Instructions, open Namespaces, go Back:
   the draft survives and warns AGENTS.md changed. Enter `Previous guidance`;
   repeat: warning and enabled Save persist. `Updated guidance` matches the
   simulated file, clearing the warning and disabling Save. Edit/save AGENTS.md,
   then reload USER.md; each affects only its file.
6. On phone, select through **Workspace file**; the editor fits. Check Missing
   file, Save needs Agent operate, Write outcome unknown, and Reread keeps a
   focused editor's caret. Deployment polls preserve selection, caret and unsaved
   content. **Components / Workspace / Reread after a version change** shows
   confirmed absence as **Missing** in tabs and phone picker; the browser
   regression checks later absence clears **Needs attention**. **Components /
   Workspace / Gateway unreachable** names all four files in one notice above
   them; each shows the reason below its editor; none shows **Needs attention**. **Retry**
   clears the notice and loads all four.

7. Open **Pages / Agent detail / New version in progress, then current**. Reset
   as instructed; check stationary-pointer **Refresh deployment** through completion
   and the delayed overview reread. Repeat, clicking during that reread: busy
   feedback is immediate; only one user refresh follows. Reset; Tab to **v7**
   under **Latest visible deployment** before completion. At **Completed**, focus
   remains visible; Enter opens v7's **Deployment**.

8. In **New version queued**, test the picker's keyboard round trip. Fold
   **Deployment details**; Tab to **Run diagnostics for this version**. Polls
   preserve fold, focus and button position; repeat expanded at both widths.
   **Deployment activity loading** shows **Deploying version** in Configuration
   on reply; **Deployment activity unavailable** stays neutral. In **New version
   in progress, one status read fails**, open Deployment before the failed poll.
   The fold persists; the selected record shows one visible transient-error alert
   outside it. Terminal completion can expand details. In **Deployment activity
   unavailable**, fold the error; **Refresh deployment** reveals the repeated error.

   Standalone **Diagnostics focus when deployment completes**: fold **Deployment
   details**, Tab to **Run diagnostics for this version**, and scroll until the
   focused button is fully inside the viewport's lower edge. The delayed
   **Completed** poll opens details; that button remains visible and focused.
   Check desktop and phone. On phone, reload, Tab to the button, then scroll to
   the top: details open; the reader stays there.

   Standalone **Refresh deployment focus when a newer version appears**: fold
   **Deployment details**, Tab to **Refresh deployment**. About five seconds after
   queued v7 appears, the quiet poll starts; the button stays enabled. Enter
   during the next six seconds: immediate busy feedback and focus persist as the
   panel switches to v8. The simulated record failure shows v8's retry notice;
   the button is enabled and focused. Reset, repeat, Shift+Tab to **Deployment
   details** during refresh. At the notice, the summary retains focus; Enter
   folds, Space reopens. Controller replacement regression:
   `tests/browser/console-agent-detail-2.test.ts`.

   Stories simulate Controller responses.
   `tests/browser/console-deployment-activity.test.ts` additionally checks
   queued → 503 → queued, queued → running, terminal completion with the
   diagnostics button focused, a final 403/404, and delayed success after refusal.
   Run it for actual controls and response envelopes.

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

Open **Components / Deletion / Status unavailable after deletion request** on
desktop and at 390 px. Wait for the status check to return you to **Agents** in
the same Namespace. Check that an information notice above the list says deletion
was requested and cleanup could not be confirmed. The row still shows **Deleting**.
Open **Namespaces**, then return to **Agents** and check that the notice has cleared.
Use **Reset story** to repeat the simulated status response.

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
