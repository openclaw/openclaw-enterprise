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
