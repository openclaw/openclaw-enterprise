# Agent policy walkthrough

Use **Pages/Agent detail → Policy Denials Many** for 200 simulated denials and
**Policy Rules Populated** for ten applied network rules.

1. Confirm the Network policy card and suggestion appear above the denial log.
   The initial page shows five of 200 denials, on page one of 40. Search the loaded
   window, clear the filter, and expand a denial to inspect its sanitized log.
2. Select the visible page, go to the next page, and select another denial. Check
   the total and the count outside this page. Enable **Follow**: the new-denial
   button appears while the inspected rows, details, and selection stay in place.
3. Choose **Allow selected**. Check the selected-record, distinct-request, and
   new-rule counts. Repeated requests produce one rule. Review the changes and
   expand the previously saved rules to check existing access. No save or apply
   occurs before an explicit action.
4. Choose **Back to editing**, then **Done**. Open **Manage rules** and confirm
   the draft is retained. Search the list, clear the search, and page through five
   rules at a time. Use a row menu to edit or remove a rule. **Add rule** opens
   the schema editor. **Back to rules** retains an incomplete draft for correction.
5. Review again and choose **Save for later**. The saved version increases; live
   access stays unchanged. **Apply saved rules** requests
   application separately and is unavailable while the proposal has unsaved changes.
6. In **Policy Rules Populated**, open **Manage rules** on a fresh preview. Check
   ten rules across two pages, search for `allowed-10`, and inspect the row menu.
   Confirm the dialog has no editing toggle. Close it and turn **Policy editing**
   off in the Network policy card. Open **View rules**: all ten rules remain and
   **Add rule** is unavailable. Close the dialog, turn **Policy editing** on,
   and confirm **Add rule** becomes available again.
   Repeat at phone width and confirm the modal scrolls with its footer visible.
7. In **Policy Denials**, choose **Allow this** or **Review suggestion**, review
   the proposal, and **Save and apply to current revision**. Wait for pending to
   become applied. The card distinguishes the saved and last confirmed live versions.
8. In **Policy Denials Apply Rejected**, use the combined action. The alert must
   distinguish a saved policy from unconfirmed application.
9. In **Policy Denials Ceiling Denied**, review the `outside.example.org` suggestion.
   Confirm the error receives focus inside the modal. The draft remains editable;
   the saved policy and live access stay unchanged.
10. In **Policy Denials Protected**, open **Manage rules**. Confirm the protected
    execution notice is visible, adding and editing controls are hidden, and **Remove
    saved network rules** opens review. **Save for later** clears the rules; live
    application stays disabled.
11. In **Policy Incomplete Preview**, review a suggestion. The unreadable preview
    retains the draft and offers no Save action. In **Policy Unconfirmed Save**,
    use the combined action and refresh before making another change.

In **Unicode executable path remains complete**, copy the full path from the
**View network limits** on the page, then close the limits dialog. Select
**Review suggestion**, then paste that path into **Executable path**. Confirm it keeps the final `/tool`. The path has
281 Unicode code points, 551 UTF-16 code units, and 1091 UTF-8 bytes: six directory
components of 45 Deseret letters (`U+10400`) each, followed by `/tool`. Select
**Review changes**, then **Save for later**. Confirm the complete path appears in review
and saved policy v2, and the current revision stays unchanged. Reset to repeat.
This scenario simulates the API; it does not verify an executable or policy
application.

Compare empty, disabled, unsupported, gap, missing-metadata, permission-denied,
loading, unavailable-credential, and unconfirmed-application stories. In **Policy
Denials Disabled**, enable editing from the page's **Network policy** card before
opening **Manage rules**. The control shows the current editing status. Manual
editing remains available without logs or suggestions. The unsupported story
shows one sentence and no editor. In **Policy Denials Edit Denied**, try turning **Policy editing** off and confirm the refusal is visible and focused on the page.
Refused policy reads and suggestions offer no retry. Inspect
screenshots and record the final interactions outside the checkout.

These fixtures prove simulated UI behavior. Browser tests in
`tests/browser/console-policy-denials.test.ts` exercise real controller admission,
save, and application requests with in-memory storage and test Drivers. Logs and
the failed-application presentation are simulated; the retry reaches real admission
and checks its refusal for the fixture’s pending application. Use the OpenShell real-runtime lane for provider and
runtime enforcement proof.

Use **Policy Suggestions Expanded** to inspect three of twelve candidates, show
all, show fewer, and expand full paths. **Policy Denials Disabled** keeps
suggestions inspectable through **View suggestions**. Open **View network limits**
on the main page with editing on and off; search and page the read-only ceiling.
**Policy No Network Limits** explains that no additional access is delegated.
The rule dialog contains neither limits nor policy details.

In **Policy Rules Populated**, the clean footer shows **No unsaved changes** and
**Done**. Edit and restore a hostname: the clean state returns. Remove a rule:
**Review changes** becomes the primary footer action and **Add rule** is secondary.
Review and save for later, reopen the dialog, and choose **Apply saved rules**.
The footer stays visible on desktop, tablet, and phone.

Compare **Policy Saved For Later**, **Policy Applying**, **Policy Applied**, and
**Policy Retry Application**. In the last story, **Refresh status** must issue
only a GET, keep the unconfirmed warning, and expose **Retry application**.
Only that separate action requests application. **Policy Editing Admin Denied**
shows the real control with a simulated administrative refusal, without claiming
that the API provides an administrative permission hint.
