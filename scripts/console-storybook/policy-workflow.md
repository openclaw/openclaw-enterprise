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
   access stays unchanged. **Apply saved policy to current revision** requests
   application separately and is unavailable while the proposal has unsaved changes.
6. In **Policy Rules Populated**, open **Manage rules** on a fresh preview. Check
   ten rules across two pages, search for `allowed-10`, and inspect the row menu.
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
    execution notice is visible, adding and editing are disabled, and **Remove
    saved network rules** opens review. **Save for later** clears the rules; live
    application stays disabled.
11. In **Policy Incomplete Preview**, review a suggestion. The unreadable preview
    retains the draft and offers no Save action. In **Policy Unconfirmed Save**,
    use the combined action and refresh before making another change.

Compare empty, disabled, unsupported, gap, missing-metadata, permission-denied,
loading, unavailable-credential, and unconfirmed-application stories. Manual
editing remains available without logs or suggestions. The unsupported story
shows one sentence and no editor. A permission refusal offers no retry. Inspect
screenshots and record the final interactions outside the checkout.

These fixtures prove simulated UI behavior. Browser tests in
`tests/browser/console-policy-denials.test.ts` exercise real controller admission,
save, and application requests with in-memory storage and test Drivers; only their
log input is simulated. Use the OpenShell real-runtime lane for provider and
runtime enforcement proof.
