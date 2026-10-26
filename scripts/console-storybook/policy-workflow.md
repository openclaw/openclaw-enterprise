# Agent policy walkthrough

Use **Pages/Agent detail → Policy denials and reviewed network additions**.
Filter the loaded window by `example.org`, clear the filter, and expand a denial.
Confirm the expanded sanitized log is labelled `sandbox` and uses activity content.
Review its exact executable and endpoint, or select **Review suggestion**.

1. Under **Proposed network rules**, select **+** to add a rule and **×** to
   remove it. Confirm the unsaved message appears and the saved version stays
   unchanged. Fill the required fields, then select **Review changes**.
2. Select **Back to editing** and confirm the proposal remains editable. Review
   again, then select **Save**. Confirm the saved version increases and the
   message says the current revision is unchanged.
3. Edit the saved rule and review again. Select **Save and apply to current
   revision**. Wait for pending to become applied with a provider version.
   **Apply saved policy to current revision** applies an earlier saved policy;
   it is unavailable while the proposal has unsaved changes.
4. In **Policy saved but live application rejected**, use the combined action.
   Confirm the alert distinguishes a saved policy from unconfirmed application.
5. In **Policy addition exceeds the delegation ceiling**, review the suggested
   `outside.example.org` rule and use the combined action. Confirm the error
   receives focus and is visible without scrolling. The attempted rule remains
   editable; the saved policy version and rules stay unchanged.
6. In **Policy preview omits the validated rules**, review a suggestion. Confirm
   the preview leaves the proposal editable and offers no Save action.
7. In **Policy save returns different rules than reviewed**, use the combined
   action. Confirm the Console asks you to refresh, then shows which rules were
   saved. Live application requires a separate, explicit action.

In **Unicode executable path remains complete**, copy the full path from the
Installation delegation ceiling. Select **Review suggestion**, then paste that
path into **Executable path**. Confirm it keeps the final `/tool`. The path has
281 Unicode code points, 551 UTF-16 code units, and 1091 UTF-8 bytes: six directory
components of 45 Deseret letters (`U+10400`) each, followed by `/tool`. Select
**Review changes**, then **Save**. Confirm the complete path appears in review
and saved policy v2, and the current revision stays unchanged. Reset to repeat.
This scenario simulates the API; it does not verify an executable or policy
application.

Compare empty, disabled, unsupported, gap, missing-metadata, permission-denied,
loading, unavailable-credential, and unconfirmed-application stories. Confirm
manual editing remains available without logs or suggestions. The unsupported
story shows one sentence and no editor. A permission refusal offers no retry. These previews
prove simulated presentation only; use the OpenShell real-runtime lane for
persistence and enforcement proof.
