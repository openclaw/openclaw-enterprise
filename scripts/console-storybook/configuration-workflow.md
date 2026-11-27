# Driver configuration walkthrough

Rebuild Storybook before inspecting these stories. They render production console
components with simulated API state; they do not prove persistence or enforcement.

- **Pages/Settings → Account** and **Pages/Settings → Nested Driver values:**
  Before expanding a Driver, check that its collapsed summary shows the Driver
  ID, contribution key and a separate **Implementation** label. Switch from
  **Fields** to **JSON** and back. Confirm the same labels stay visible and the
  group stays collapsed. Expand it to inspect the values and switch views again
  to confirm it stays open.
- **Pages/Agent detail → Policy denials and reviewed network additions:** use
  **Add Network rules**, fill the schema fields, add a port range, then select
  **Review changes**. Preview does not change the saved version. Compare **Save**
  with **Save and apply to current revision**, then wait for provider confirmation.
- **Configuration preview field errors:** review a suggestion. The preview shows
  a field error and retains the proposal without saving.
- **Configuration version conflict retains draft:** preview a proposal and check
  the reload/review guidance and retained fields.
- **Another Driver renders enum fields from its schema:** add a rule and select
  a destination from the schema's enum. The owner controls remain the same.
- **A superseded preview preserves the newer draft:** start a preview, edit the
  rule before it returns, and confirm the old response does not open Save.
- **Overlapping policy refreshes retain the newest read:** click **Refresh policy**
  twice within 300 ms. The first response is older; wait for saved policy v3.
  Apply the saved policy and confirm polling reaches the simulated provider
  confirmation. The fixture simulates another operator's saves between reads;
  the browser integration performs actual HTTP saves.
- **Complex fields retain invalid JSON for correction:** review a suggestion,
  enter incomplete JSON for its destination, and confirm preview stays unavailable
  until the JSON is corrected. Expand **Schema** to inspect the field's constraints.
- **Configuration discovery loading/denied:** inspect the loading message and
  retry control. **Policy hidden while independent logs remain visible** keeps
  denial logs available while policy and suggestion reads show permission refusals
  without retry controls. **Sandbox policy capability unavailable** shows one
  unsupported message without fetching logs or recommendations.
- **Reconcile concurrent repository grant changes:** after the simulated save
  conflict, refresh the policy. Check that the panel shows the newer grants and
  only offers discard. Discard, narrow the remaining grant, and save.
- Inspect the existing empty, unsupported, loading, missing-credential, denied,
  and apply-rejected policy stories. After a saved change whose apply fails, the
  alert must identify the saved version.

Capture screenshots and an interaction video outside the checkout. Include the
story names and proof limits with the media; refresh it after material UI edits.

## Change the shared model in a roster

Open **Pages → Create Agent → Change a roster's shared primary model**. Change
Model ID, then inspect Advanced settings → Configuration JSON. Defaults and
explicit roster selections share the new primary; inherited selections remain
omitted. Clear the field and select another model: local policies and ordered
fallbacks remain. This story simulates the API and does not deploy a runtime.

## Correct a model configuration draft

Open **Pages → Create Agent → Enter another model ID** (`createModelManual`).
Select a listed Codex model, then open **Advanced settings → Configuration JSON**.
Change only `plugins.allow` to each of `"codex"`, `7`, `null`, and `["keep-plugin", 7]`.
For each value, select **Choose a model from the list**. Check that the editor
receives focus and describes how to correct `plugins.allow`. The raw JSON and
manual model choice must remain unchanged. Change **Model ID** and leave the
field: the editor must show the same error and retain both drafts.

Correct the field to `[]` or `["keep-plugin"]`, or remove it. Retry the switch
and select `gpt-6-sol`, then `gpt-6-luna`. Check the JSON primary model and confirm
that whole plugin entries remain. Repeat at 1440 px and 390 px. Do not create an
Agent. Capture the error and successful retry; this is simulated UI evidence only.

## Return to an offscreen Configuration selection

Open **Pages → Agent detail → Edit Configuration** in its own preview tab.
Replace **Configuration JSON** with a long unsaved JSON draft whose last
setting, just above the closing brace, is `"review": "Review A"`. Press
Ctrl+End, Up, End, and Left, then Shift+Left to select just the final A.

Wheel to the top inside **Configuration JSON**. Press Shift+Tab, then wheel
the page up until the editor is below the window. Press Tab. The editor and
its focus outline should come into view, while the selected line may still
be below the editor's visible text. Type B and check that the draft now says
`"review": "Review B"` with the rest unchanged. Leave the draft unsaved.

## Correct an offscreen Configuration syntax error

In **Pages → Agent detail → Invalid Configuration JSON** (`invalidConfiguration`),
enter a long draft with an extra `x` between valid lines. Use a short desktop
window and repeat at 200% zoom. Move to the end, then press Tab and Enter to
activate **Save Configuration**. When the editor and error fit, check that both
are visible and the caret is before `x`. Enlarge the editor manually
and try saving again. If both no longer fit, check that the editor keeps its
size and the caret stays visible. Press Delete and save the corrected draft.

Repeat at 320×480. On a line after line 10, add spaces before a string
value so its opening quote is past column 100. Replace that quote with
`“`. Move to the end so the typo scrolls out of view. Press Tab and Enter
to save. The caret and the instruction to use a straight quote should both
be visible. Without clicking, press Delete and type `"` to repair the draft.

## Correct an out-of-range Configuration number

Open **Pages → Agent detail → Invalid Configuration JSON**
(`invalidConfiguration`) and **Pages → Create Agent → Invalid Configuration JSON**
(`createInvalidConfiguration`). Check their initial syntax errors first. Follow
each story's review steps to restore the complete document, then set
`plugins.entries.knowledge` to
`{"enabled":true,"config":{"thresholds":[1,1e400,3]}}`, preserving the other settings.

The nested array has valid JSON syntax, but `1e400` is outside the supported
number range. Select **Save Configuration** or **Create Agent**. The error under
the editor must read: “A number is too large or too small to save. Use a number
closer to zero.” Check editor focus, exact draft retention, and no write. In
Create Agent, select **Enter model ID manually** if a model list is shown.
Change **Model ID** and leave the field: the rejected JSON must remain unchanged.
Restore the original Model ID before retrying.

Replace only `1e400` with `2`. Save or create, then inspect the Configuration for
`[1,2,3]`. Capture the rejection and successful correction. These stories use
simulated saves; they do not prove Controller persistence or runtime behavior.

To check the error in a short window, open **Pages → Create Agent → GitHub
repository access with a registered App** at 1024 × 360 and 390 × 360. Under
**Authentication method**, choose **Service Accounts**. Leave the credential
field empty. Open **Advanced settings**, use the same nested array as above and
select `1e400` in **Configuration JSON**. Change **Model ID** and press Tab.
Before scrolling, check that the selection and the whole error are visible above
the buttons. Type `2` to replace just the selected number. Repeat with the
application repository unchecked. The deployment warning should stay visible too.

Repeat the rejection in a tall window. Keep **Configuration JSON** focused as
you shrink the window. When both fit, the selection and full error should stay
visible. Scroll deliberately and check that the page stays where you leave it.

## Keep Runtime details visible while tabbing

Open **Pages → Create Agent → GitHub repository access with a registered App**
at 1024 × 360. Choose **Service Accounts**, leave the credential field empty,
and uncheck the application repository to show the deployment warning. Focus
**Model ID**, scroll down one wheel step beside the form, then press Tab. Check
that **Runtime details · Dedicated** and its full focus outline are visible above
the sticky actions. Repeat with the repository selected and no warning.

## Correct a Create Agent Configuration syntax error

Open **Pages → Create Agent → Invalid Configuration JSON**
(`createInvalidConfiguration`). Tab to **Reset template**, press Enter, and
confirm the discard prompt to restore the valid draft. Reopen **Advanced
settings** if needed and focus **Configuration JSON**. Press Ctrl+Home, then
Right Arrow. Type a comma after the opening brace. Press Ctrl+End, tab to
**Create Agent**, and press Enter.

At 1024 × 360 and at phone width, check that you can see both the caret before
the comma and the full error for line 1, column 2 without scrolling. Press
Delete once. The editor must match the restored draft exactly, the error must
clear, and the other form fields must stay unchanged.

In a tall window, repeat with an extra `x` before the opening brace. Check
that you can still resize the editor. If you make it too tall to fit alongside
the error, the caret must stay visible. Leave the corrected draft unsaved.

## Inspect, save, and withdraw repository grants

Open **Inspect Namespace repository limits** in **Pages / Agent detail**. Open
**View network limits** and check both repository entries. Open **Manage rules**
to verify that the Agent has no saved repository policy. Its earlier deployment
requires creating a new Agent for scoped access.

Open **Save Agent repository access and narrow a grant**. In **Manage rules**,
set `example/application` to **Read** and `example/tooling` to **Write**. Save
the repository policy. Reopen **Manage rules**, change tooling to **Read**,
and select **Refresh policy**. Verify that tooling still shows **Read**, then
save. The notice gives deployment requirements and explains when a new Agent is
required. Reopen **Manage rules** and set application to **No access**. The
story rejects this partial list. Check that the selection remains, then select
**Discard repository changes** to restore the saved choices.
Reload the story to reset it. Choose **Deny all repositories** and confirm the
save. Verify that a saved deny-all list replaces the legacy access summary.

In the protected execution story, remove and save the ordinary network rules
first. Reopen **Manage rules** and select **Withdraw saved repository grants**.
Use **Back to editing** to return to the saved grants, then open the review
again. Select **Save deny-all policy** and verify the saved deny-all state. This
story simulates the Console and API exchange.

Open **Withdraw grants with an unreadable active revision**. Verify that the
Console reports the active policy as unavailable. In **Manage rules**, review
withdrawal and check the compatible controller and Worker instructions before
saving.
